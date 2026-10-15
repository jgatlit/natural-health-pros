import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accrueAffiliateShare } from '@/lib/affiliate-ledger';
import {
  MAX_TRANSFER_ATTEMPTS,
  settleAffiliateEntryBestEffort,
  settleAffiliateShares,
} from '@/lib/affiliate-payouts';
import { reverseReferralOnRefund } from '@/lib/referral-refunds';
import { fakeAffiliateDb } from './helpers/fake-affiliate-db';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * LANE R2 — recruiters are paid as client payments come in, and a refund AFTER the recruiter was
 * paid is netted off their next payouts (operator ruling 2026-10-14: negative balance, NHP never out
 * of pocket, the recruiter sees "adjusted for a refund").
 *
 * Everything here runs against the in-memory fake with the REAL money code: the accrual, the refund
 * reversal, the claim-and-net transaction, the fee helper. The only mocks are Prisma and the Whop
 * transfer; nothing here can reach Whop. `WHOP_TRANSFERS_ENABLED` is set only inside this file, on the
 * process env, and restored.
 */

const ENV = [
  'WHOP_TRANSFERS_ENABLED',
  'WHOP_COMPANY_API_KEY',
  'WHOP_PARENT_COMPANY_ID',
  'WHOP_TRANSFER_FEE_BPS',
  'WHOP_TRANSFER_FEE_MODE',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

/** `feeBps` '0' keeps the arithmetic in whole cents; omit for the shipped default (3%, charged to the sender). */
const enable = (feeBps: string | null = '0') => {
  process.env.WHOP_TRANSFERS_ENABLED = 'true';
  process.env.WHOP_COMPANY_API_KEY = 'test-key';
  process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';
  if (feeBps !== null) process.env.WHOP_TRANSFER_FEE_BPS = feeBps;
};

const NOW = new Date(Date.UTC(2027, 0, 1));
const PAST = new Date(Date.UTC(2026, 11, 1));
const R = 'R';
const Y = 'Y';
const VERIFIED = { whopCompanyId: 'biz_R', whopPayoutsEnabled: true };
const wallets = {
  R: VERIFIED,
  S: { whopCompanyId: 'biz_S', whopPayoutsEnabled: true },
  U: { whopCompanyId: null, whopPayoutsEnabled: false },
};

const entry = (over: Record<string, any> = {}) => ({
  bookingIntentId: 'bi_1',
  recruiterPractitionerId: R,
  recruitedPractitionerId: Y,
  grossUsdCents: 10_000,
  bps: 300,
  shareUsdCents: 300,
  holdUntil: PAST,
  holdDays: 0,
  ...over,
});

const debit = (amount: number, over: Record<string, any> = {}) => ({
  recruiterPractitionerId: R,
  sourceLedgerEntryId: 'afl_old',
  amountUsdCents: amount,
  ...over,
});

let transferSeq = 0;
const okTransfer = () =>
  vi.fn<(args: any) => Promise<{ transferId: string }>>(async () => ({ transferId: `tr_${++transferSeq}` }));

const settle = (db: any, transfer: any, over: Record<string, any> = {}) =>
  settleAffiliateShares(db, { transfer, at: NOW, ...over });

describe('netting: a recruiter’s open debits come off their next payable share, oldest first', () => {
  it('a debit SMALLER than the share: the remainder is sent, the debit is APPLIED, the row records every number', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()], adjustments: [debit(120)] });
    const transfer = okTransfer();

    const summary = await settle(db, transfer);

    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer.mock.calls[0]![0]).toMatchObject({ amountUsdDollars: 1.8, destinationId: 'biz_R' });
    expect(db.rows[0]).toMatchObject({
      state: 'SETTLED',
      grossShareUsdCents: 300,
      adjustmentAppliedUsdCents: 120,
      transferFeeUsdCents: 0,
      transferUsdCents: 180,
      netPaidUsdCents: 180,
    });
    expect(db.adjustments[0]).toMatchObject({ appliedUsdCents: 120, state: 'APPLIED' });
    expect(summary).toMatchObject({ settled: 1, netted: 1, debitAppliedUsdCents: 120 });
  });

  it('a debit LARGER than the share: the share is swallowed, NO transfer is made, and the rest carries to the next payout', async () => {
    enable();
    const db = fakeAffiliateDb({
      practitioners: wallets,
      entries: [entry(), entry({ bookingIntentId: 'bi_2', holdUntil: new Date(PAST.getTime() + 1) })],
      adjustments: [debit(500)],
    });
    const transfer = okTransfer();

    await settle(db, transfer);

    // Row 1 (oldest) swallowed whole: SETTLED, net 0, nothing sent. Row 2 absorbed the last 200 of
    // the debit and sent the remaining 100.
    expect(db.rows[0]).toMatchObject({
      state: 'SETTLED',
      grossShareUsdCents: 300,
      adjustmentAppliedUsdCents: 300,
      transferUsdCents: 0,
      transferFeeUsdCents: 0,
      netPaidUsdCents: 0,
      whopTransferId: null,
    });
    expect(db.rows[1]).toMatchObject({ state: 'SETTLED', adjustmentAppliedUsdCents: 200, transferUsdCents: 100, netPaidUsdCents: 100 });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer.mock.calls[0]![0].amountUsdDollars).toBe(1);
    expect(db.adjustments[0]).toMatchObject({ appliedUsdCents: 500, state: 'APPLIED' });
  });

  it('a debit that outlasts the only share stays OPEN with its remainder, and nothing is ever sent negative', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()], adjustments: [debit(1_000)] });
    const transfer = okTransfer();
    await settle(db, transfer);
    expect(transfer).not.toHaveBeenCalled();
    expect(db.rows[0]).toMatchObject({ state: 'SETTLED', transferUsdCents: 0, netPaidUsdCents: 0 });
    expect(db.adjustments[0]).toMatchObject({ appliedUsdCents: 300, state: 'OPEN' });
    expect(db.adjustments[0].amountUsdCents - db.adjustments[0].appliedUsdCents).toBe(700);
  });

  it('a debit EXACTLY equal to the share: swallowed, APPLIED, no transfer', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()], adjustments: [debit(300)] });
    const transfer = okTransfer();
    await settle(db, transfer);
    expect(transfer).not.toHaveBeenCalled();
    expect(db.rows[0]).toMatchObject({ state: 'SETTLED', netPaidUsdCents: 0, adjustmentAppliedUsdCents: 300 });
    expect(db.adjustments[0]).toMatchObject({ appliedUsdCents: 300, state: 'APPLIED' });
  });

  it('applies debits OLDEST FIRST, and a partly-applied debit resumes where it left off', async () => {
    enable();
    const db = fakeAffiliateDb({
      practitioners: wallets,
      entries: [entry({ shareUsdCents: 150 })],
      adjustments: [debit(100, { id: 'd_old' }), debit(100, { id: 'd_new' })],
    });
    const transfer = okTransfer();
    await settle(db, transfer);
    expect(db.adjustments.find((a) => a.id === 'd_old')).toMatchObject({ appliedUsdCents: 100, state: 'APPLIED' });
    expect(db.adjustments.find((a) => a.id === 'd_new')).toMatchObject({ appliedUsdCents: 50, state: 'OPEN' });
    expect(transfer).not.toHaveBeenCalled(); // 150 swallowed whole

    // The next share continues the second debit.
    db.rows.push({
      ...entry({ bookingIntentId: 'bi_2', shareUsdCents: 300 }),
      id: 'afl_n2',
      state: 'ACCRUED',
      reversedUsdCents: 0,
      transferAttempts: 0,
      transferUsdCents: null,
      settledAt: null,
      whopTransferId: null,
      lastError: null,
      adjustmentAppliedUsdCents: null,
    });
    await settle(db, transfer);
    expect(db.adjustments.find((a) => a.id === 'd_new')).toMatchObject({ appliedUsdCents: 100, state: 'APPLIED' });
    expect(transfer.mock.calls[0]![0].amountUsdDollars).toBe(2.5);
  });

  it('only the RECRUITER’S OWN debits are netted; someone else’s debit and an APPLIED debit are never touched', async () => {
    enable();
    const db = fakeAffiliateDb({
      practitioners: wallets,
      entries: [entry()],
      adjustments: [
        debit(100, { recruiterPractitionerId: 'S', id: 'd_other' }),
        debit(80, { id: 'd_done', appliedUsdCents: 80, state: 'APPLIED' }),
      ],
    });
    const transfer = okTransfer();
    await settle(db, transfer);
    expect(transfer.mock.calls[0]![0].amountUsdDollars).toBe(3);
    expect(db.adjustments.find((a) => a.id === 'd_other')).toMatchObject({ appliedUsdCents: 0, state: 'OPEN' });
    expect(db.adjustments.find((a) => a.id === 'd_done')).toMatchObject({ appliedUsdCents: 80, state: 'APPLIED' });
    expect(db.rows[0].adjustmentAppliedUsdCents).toBeNull();
  });

  it('the fee helper runs on the NET amount, never on the part the debit swallowed', async () => {
    enable(null); // the shipped default: 3%, charged to the sender
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()], adjustments: [debit(120)] });
    const transfer = okTransfer();
    await settle(db, transfer);
    // net 180 -> largest S with S + ceil(3% S) <= 180 is 174 (fee 6). Not the 291 / 9 a full $3 would give.
    expect(transfer.mock.calls[0]![0].amountUsdDollars).toBe(1.74);
    expect(db.rows[0]).toMatchObject({
      grossShareUsdCents: 300,
      adjustmentAppliedUsdCents: 120,
      transferFeeUsdCents: 6,
      transferUsdCents: 174,
      netPaidUsdCents: 174,
    });
    expect(300 - 120 - 6).toBe(174);
  });

  it('a remainder too small to cover the fee is NOT sent and NO debit is applied for it', async () => {
    enable(null);
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()], adjustments: [debit(299)] }); // net 1c: send = 0 at 3%, so it is not sendable
    const transfer = okTransfer();
    const summary = await settle(db, transfer);
    expect(transfer).not.toHaveBeenCalled();
    expect(summary.belowFee).toBe(1);
    expect(db.rows[0]).toMatchObject({ state: 'ACCRUED', adjustmentAppliedUsdCents: null });
    expect(String(db.rows[0].lastError)).toMatch(/BELOW_TRANSFER_FEE/);
    expect(db.adjustments[0]).toMatchObject({ appliedUsdCents: 0, state: 'OPEN' });
  });

  it('a share already reduced by a PRE-payout refund nets against the reduced amount', async () => {
    enable();
    const db = fakeAffiliateDb({
      practitioners: wallets,
      entries: [entry({ reversedUsdCents: 100 })], // payable 200
      adjustments: [debit(150)],
    });
    const transfer = okTransfer();
    await settle(db, transfer);
    expect(transfer.mock.calls[0]![0].amountUsdDollars).toBe(0.5);
    expect(db.rows[0]).toMatchObject({ grossShareUsdCents: 200, adjustmentAppliedUsdCents: 150, netPaidUsdCents: 50 });
  });

  it('eligibility is unchanged: an unverified or inactive recruiter keeps the share AND the debit untouched', async () => {
    enable();
    const db = fakeAffiliateDb({
      practitioners: { R: { ...VERIFIED, archivedAt: new Date() }, U: wallets.U },
      entries: [entry(), entry({ bookingIntentId: 'bi_u', recruiterPractitionerId: 'U' })],
      adjustments: [debit(100), debit(100, { recruiterPractitionerId: 'U' })],
    });
    const transfer = okTransfer();
    await settle(db, transfer);
    expect(transfer).not.toHaveBeenCalled();
    expect(db.rows.every((r) => r.state === 'ACCRUED')).toBe(true);
    expect(db.adjustments.every((a) => a.appliedUsdCents === 0 && a.state === 'OPEN')).toBe(true);
  });

  it('a debit-netted row is settled ONCE: a second run finds nothing and re-applies nothing', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()], adjustments: [debit(120)] });
    const transfer = okTransfer();
    await settle(db, transfer);
    const again = await settle(db, transfer);
    expect(again.matched).toBe(0);
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(db.adjustments[0].appliedUsdCents).toBe(120);
  });
});

describe('netting: conservation. Whatever the shares and debits, nothing is created or lost', () => {
  /** A tiny deterministic PRNG so a failing case is reproducible. */
  const rng = (seed: number) => () => {
    seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return seed / 4_294_967_296;
  };

  it('over 300 random scenarios: sent + applied = shares, applied <= debits, payouts >= 0, no debit over-applied', async () => {
    enable();
    const rand = rng(20_261_014);
    for (let n = 0; n < 300; n += 1) {
      const shares = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => 1 + Math.floor(rand() * 900));
      const debits = Array.from({ length: Math.floor(rand() * 4) }, () => 1 + Math.floor(rand() * 1_200));
      const db = fakeAffiliateDb({
        practitioners: wallets,
        entries: shares.map((s, i) => entry({ bookingIntentId: `bi_${i}`, shareUsdCents: s, holdUntil: new Date(PAST.getTime() + i) })),
        adjustments: debits.map((d) => debit(d)),
      });
      const transfer = okTransfer();
      await settle(db, transfer);

      const sent = transfer.mock.calls.reduce((sum, c) => sum + Math.round(c[0].amountUsdDollars * 100), 0);
      const appliedOnRows = db.rows.reduce((sum, r) => sum + (r.adjustmentAppliedUsdCents ?? 0), 0);
      const appliedOnDebits = db.adjustments.reduce((sum, a) => sum + a.appliedUsdCents, 0);
      const totalShares = shares.reduce((a, b) => a + b, 0);
      const totalDebits = debits.reduce((a, b) => a + b, 0);

      expect(appliedOnRows).toBe(appliedOnDebits); // every cent netted on a row came off a debit, and vice versa
      expect(appliedOnDebits).toBe(Math.min(totalShares, totalDebits)); // as much as the shares can bear, no more
      expect(sent + appliedOnRows).toBe(totalShares); // fee-free: every cent of share is sent or netted
      for (const a of db.adjustments) {
        expect(a.appliedUsdCents).toBeLessThanOrEqual(a.amountUsdCents);
        expect(a.state).toBe(a.appliedUsdCents === a.amountUsdCents ? 'APPLIED' : 'OPEN');
      }
      for (const c of transfer.mock.calls) expect(c[0].amountUsdDollars).toBeGreaterThan(0);
      for (const r of db.rows) expect(r.netPaidUsdCents).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the flag: with WHOP_TRANSFERS_ENABLED not exactly "true", debits and shares are not read, written or sent', () => {
  it.each([undefined, 'false', '0', 'TRUE', '1', ''])('flag=%s: zero reads, zero writes, zero transfers, no transaction', async (value) => {
    process.env.WHOP_COMPANY_API_KEY = 'k';
    process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';
    if (value !== undefined) process.env.WHOP_TRANSFERS_ENABLED = value;
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()], adjustments: [debit(120)] });
    const spies = [
      vi.spyOn(db.affiliateLedgerEntry, 'findMany'),
      vi.spyOn(db.affiliateLedgerEntry, 'updateMany'),
      vi.spyOn(db.affiliateBalanceAdjustment, 'findMany'),
      vi.spyOn(db.affiliateBalanceAdjustment, 'updateMany'),
      vi.spyOn(db.affiliateBalanceAdjustment, 'createMany'),
      vi.spyOn(db, '$transaction'),
    ];
    const transfer = okTransfer();

    const summary = await settle(db, transfer);
    const best = await settleAffiliateEntryBestEffort(db as any, { bookingIntentId: 'bi_1', recruiterPractitionerId: R }, { transfer, at: NOW });

    expect(summary.blocked).toBe('skipped: transfers disabled');
    expect(best).toBeNull();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
    expect(db.rows[0]).toMatchObject({ state: 'ACCRUED', adjustmentAppliedUsdCents: null });
    expect(db.adjustments[0]).toMatchObject({ appliedUsdCents: 0, state: 'OPEN' });
  });
});

describe('the best-effort immediate settle', () => {
  it('settles ONLY the named row, leaving other eligible rows to the cron', async () => {
    enable();
    const db = fakeAffiliateDb({
      practitioners: wallets,
      entries: [entry({ bookingIntentId: 'bi_a' }), entry({ bookingIntentId: 'bi_b' })],
    });
    const transfer = okTransfer();
    const summary = await settleAffiliateEntryBestEffort(db as any, { bookingIntentId: 'bi_b', recruiterPractitionerId: R }, { transfer, at: NOW });
    expect(summary).toMatchObject({ matched: 1, settled: 1 });
    expect(db.rows.find((r) => r.bookingIntentId === 'bi_b')!.state).toBe('SETTLED');
    expect(db.rows.find((r) => r.bookingIntentId === 'bi_a')!.state).toBe('ACCRUED');
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it('NEVER throws: a database failure is logged loudly with the row ids, and returns null', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()] });
    db.affiliateLedgerEntry.findMany = async () => {
      throw new Error('connection reset');
    };
    const transfer = okTransfer();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      settleAffiliateEntryBestEffort(db as any, { bookingIntentId: 'bi_1', recruiterPractitionerId: R }, { transfer, at: NOW }),
    ).resolves.toBeNull();
    expect(log.mock.calls.some((c) => String(c[0]).includes('IMMEDIATE SETTLE THREW') && String(c[1]).includes('bi_1'))).toBe(true);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('NEVER rejects when the transfer itself blows up: the row is classified (HELD) and the error is logged', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()] });
    const transfer = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const summary = await settleAffiliateEntryBestEffort(db as any, { bookingIntentId: 'bi_1', recruiterPractitionerId: R }, { transfer, at: NOW });
    expect(summary).toMatchObject({ failed: 1, held: 1 });
    expect(db.rows[0].state).toBe('HELD');
  });

  it('a configuration block (flag on, Whop unconfigured) is logged loudly, not swallowed silently', async () => {
    process.env.WHOP_TRANSFERS_ENABLED = 'true';
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()] });
    const transfer = okTransfer();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const summary = await settleAffiliateEntryBestEffort(db as any, { bookingIntentId: 'bi_1', recruiterPractitionerId: R }, { transfer, at: NOW });
    expect(summary?.blocked).toMatch(/not configured/i);
    expect(log.mock.calls.some((c) => String(c[0]).includes('IMMEDIATE SETTLE BLOCKED'))).toBe(true);
    expect(transfer).not.toHaveBeenCalled();
  });
});

describe('concurrency: the same cents are never netted or paid twice', () => {
  it('the webhook trigger and the cron racing on the SAME row: one transfer, one debit application', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()], adjustments: [debit(120)] });
    const transfer = okTransfer();
    await Promise.all([
      settleAffiliateEntryBestEffort(db as any, { bookingIntentId: 'bi_1', recruiterPractitionerId: R }, { transfer, at: NOW }),
      settle(db, transfer),
      settle(db, transfer),
    ]);
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer.mock.calls[0]![0].amountUsdDollars).toBe(1.8);
    expect(db.adjustments[0]).toMatchObject({ appliedUsdCents: 120, state: 'APPLIED' });
    expect(db.rows[0].adjustmentAppliedUsdCents).toBe(120);
  });

  it('two settles over two rows of one recruiter: the debit is applied exactly once in total', async () => {
    enable();
    const db = fakeAffiliateDb({
      practitioners: wallets,
      entries: [entry({ bookingIntentId: 'bi_1' }), entry({ bookingIntentId: 'bi_2', holdUntil: new Date(PAST.getTime() + 1) })],
      adjustments: [debit(120)],
    });
    const transfer = okTransfer();
    await Promise.all([settle(db, transfer), settle(db, transfer)]);
    const sent = transfer.mock.calls.map((c) => Math.round(c[0].amountUsdDollars * 100)).sort((a, b) => a - b);
    expect(sent).toEqual([180, 300]);
    expect(db.adjustments[0]).toMatchObject({ appliedUsdCents: 120, state: 'APPLIED' });
    expect(db.rows.reduce((s, r) => s + (r.adjustmentAppliedUsdCents ?? 0), 0)).toBe(120);
    expect(db.rows.every((r) => r.state === 'SETTLED')).toBe(true);
  });

  it('INTERLEAVED: A reads the open debit and pauses, B nets it first; A’s swap misses, its claim ROLLS BACK, and it retries without the debit', async () => {
    enable();
    const db = fakeAffiliateDb({
      practitioners: wallets,
      entries: [entry({ bookingIntentId: 'bi_1' }), entry({ bookingIntentId: 'bi_2' })],
      adjustments: [debit(120)],
    });
    const transfer = okTransfer();

    let reached!: () => void;
    const atRead = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let paused = false;
    db.hooks.afterAdjustmentRead = async () => {
      if (!paused) {
        paused = true;
        reached();
        await gate;
      }
    };

    const a = settle(db, transfer, { only: { bookingIntentId: 'bi_1', recruiterPractitionerId: R } });
    await atRead; // A holds a read of the 120 debit and is about to claim bi_1 and swap it
    await settle(db, transfer, { only: { bookingIntentId: 'bi_2', recruiterPractitionerId: R } }); // B nets all of it
    expect(db.adjustments[0]).toMatchObject({ appliedUsdCents: 120, state: 'APPLIED' });
    release();
    await a;

    const sent = transfer.mock.calls.map((c) => Math.round(c[0].amountUsdDollars * 100));
    expect(sent.sort((x, y) => x - y)).toEqual([180, 300]); // bi_2 got the netting, bi_1 did not
    expect(db.rows.find((r) => r.bookingIntentId === 'bi_1')).toMatchObject({ state: 'SETTLED', netPaidUsdCents: 300 });
    expect(db.rows.find((r) => r.bookingIntentId === 'bi_1')!.adjustmentAppliedUsdCents).toBeNull();
    expect(db.adjustments[0].appliedUsdCents).toBe(120); // applied ONCE
  });

  it('the rollback really un-claims: a conflicting swap leaves no SENDING row and no half-applied debit', async () => {
    enable();
    const db = fakeAffiliateDb({
      practitioners: wallets,
      entries: [entry()],
      adjustments: [debit(100, { id: 'd1' }), debit(100, { id: 'd2' })],
    });
    // d2's swap always misses (someone else keeps winning it): the whole attempt must undo d1 and the claim.
    const real = db.affiliateBalanceAdjustment.updateMany;
    db.affiliateBalanceAdjustment.updateMany = async (args: any) =>
      args.where.id === 'd2' ? { count: 0 } : real(args);
    const transfer = okTransfer();

    const summary = await settle(db, transfer);

    expect(transfer).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(db.rows[0]).toMatchObject({ state: 'ACCRUED', transferUsdCents: null, adjustmentAppliedUsdCents: null, transferAttempts: 0 });
    expect(db.adjustments.map((a) => a.appliedUsdCents)).toEqual([0, 0]);
  });

  it('REFUND beats the claim: the claim misses, no debit is made, and the next run sends the REDUCED amount', async () => {
    enable();
    const world = refundWorld([{ id: 'bi_1', share: 300 }]);
    const transfer = okTransfer();
    await world.accrue('bi_1');
    // After the settle has READ the candidate but before it CLAIMS, a refund lands.
    const realFind = world.db.affiliateLedgerEntry.findMany;
    let injected = false;
    world.db.affiliateLedgerEntry.findMany = async (args: any) => {
      const out = await realFind(args);
      if (!injected && args.where?.state === 'ACCRUED' && args.select?.recruiterPractitioner) {
        injected = true;
        await world.refund('bi_1', 40, 'r1');
      }
      return out;
    };

    const first = await settle(world.db, transfer);
    expect(first.settled).toBe(0);
    expect(transfer).not.toHaveBeenCalled();
    expect(world.fake.adjustments).toHaveLength(0); // nothing had left: no debit
    expect(world.fake.rows[0]).toMatchObject({ state: 'ACCRUED', reversedUsdCents: 120 });

    await settle(world.db, transfer);
    expect(transfer.mock.calls[0]![0].amountUsdDollars).toBe(1.8); // 300 - 120
    expect(world.fake.adjustments).toHaveLength(0);
  });

  /** A transfer that stays in flight until `finish()` / `fail()`; `atTransfer` resolves once it is on the wire. */
  function slowTransfer() {
    let inFlight!: () => void;
    const atTransfer = new Promise<void>((r) => (inFlight = r));
    let finish!: () => void;
    let fail!: () => void;
    const gate = new Promise<'ok' | 'refused'>((r) => {
      finish = () => r('ok');
      fail = () => r('refused');
    });
    const transfer = vi.fn(async (args: any) => {
      void args;
      inFlight();
      if ((await gate) === 'refused') throw new Error('Whop /transfers failed (422): amount invalid');
      return { transferId: 'tr_slow' };
    });
    return { transfer, atTransfer, finish, fail };
  }

  it('CLAIM beats the refund: the refund lands while SENDING; the DEBIT is written when the transfer is confirmed, never lost', async () => {
    enable();
    const world = refundWorld([{ id: 'bi_1', share: 300 }]);
    await world.accrue('bi_1');
    const slow = slowTransfer();

    const running = settle(world.db, slow.transfer);
    await slow.atTransfer; // the row is SENDING; the money is on the wire
    expect(world.fake.rows[0].state).toBe('SENDING');
    const out = await world.refund('bi_1', 40, 'r1');
    expect(out.affiliateReversedUsdCents).toBe(120);
    expect(out.affiliateDebitRecordedUsdCents).toBe(0); // not confirmed paid yet: no debit yet
    expect(world.fake.adjustments).toHaveLength(0);
    slow.finish();
    await running;

    expect(world.fake.rows[0]).toMatchObject({ state: 'SETTLED', reversedUsdCents: 120, transferUsdCents: 300, grossShareUsdCents: 300 });
    expect(world.fake.adjustments).toHaveLength(1);
    expect(world.fake.adjustments[0]).toMatchObject({
      amountUsdCents: 120,
      appliedUsdCents: 0,
      state: 'OPEN',
      sourceLedgerEntryId: world.fake.rows[0].id,
      dedupeKey: `REFUND:${world.fake.rows[0].id}:120`,
    });
  });

  it('two refunds while SENDING become ONE debit for their total at confirmation', async () => {
    enable();
    const world = refundWorld([{ id: 'bi_1', share: 300 }]);
    await world.accrue('bi_1');
    const slow = slowTransfer();
    const running = settle(world.db, slow.transfer);
    await slow.atTransfer;
    await world.refund('bi_1', 40, 'r1');
    await world.refund('bi_1', 20, 'r2');
    await world.refund('bi_1', 40, 'r1'); // redelivery
    slow.finish();
    await running;
    expect(world.fake.rows[0].reversedUsdCents).toBe(180);
    expect(world.fake.adjustments.map((a) => a.amountUsdCents)).toEqual([180]);
  });

  it('the transfer is REFUSED after a refund landed while SENDING: the row returns to ACCRUED, NO debit is ever made, and the retry sends the reduced amount (the recruiter is charged ONCE)', async () => {
    enable();
    const world = refundWorld([{ id: 'bi_1', share: 300 }]);
    await world.accrue('bi_1');
    const slow = slowTransfer();
    const running = settle(world.db, slow.transfer);
    await slow.atTransfer;
    await world.refund('bi_1', 40, 'r1');
    slow.fail(); // Whop says no: the money never moved
    await running;

    expect(world.fake.rows[0]).toMatchObject({ state: 'ACCRUED', reversedUsdCents: 120 });
    expect(world.fake.adjustments).toHaveLength(0);

    const transfer = okTransfer();
    await settle(world.db, transfer);
    expect(transfer.mock.calls[0]![0].amountUsdDollars).toBe(1.8); // 300 - 120, once
    expect(world.fake.adjustments).toHaveLength(0);
    expect(world.fake.rows[0]).toMatchObject({ state: 'SETTLED', netPaidUsdCents: 180 });
  });

  it('a refund lands between the confirmation’s read and its swap: the swap misses on the total, re-reads, and the debit includes it', async () => {
    enable();
    const world = refundWorld([{ id: 'bi_1', share: 300 }]);
    await world.accrue('bi_1');
    const transfer = okTransfer();
    const realFind = world.fake.affiliateLedgerEntry.findUnique;
    let injected = false;
    world.fake.affiliateLedgerEntry.findUnique = async (args: any) => {
      const out = await realFind(args);
      // The confirmation's own read of the SENDING row (it selects grossShareUsdCents).
      if (!injected && args.select?.grossShareUsdCents && out?.state === 'SENDING') {
        injected = true;
        await world.refund('bi_1', 40, 'r1');
      }
      return out;
    };

    await settle(world.db, transfer);

    expect(world.fake.rows[0]).toMatchObject({ state: 'SETTLED', reversedUsdCents: 120 });
    expect(world.fake.adjustments.map((a) => a.amountUsdCents)).toEqual([120]);
  });

  it('a refund AFTER confirmation is a debit on its own, and an earlier SENDING-window debit is not repeated', async () => {
    enable();
    const world = refundWorld([{ id: 'bi_1', share: 300 }]);
    await world.accrue('bi_1');
    const slow = slowTransfer();
    const running = settle(world.db, slow.transfer);
    await slow.atTransfer;
    await world.refund('bi_1', 20, 'r1'); // 60, in flight
    slow.finish();
    await running;
    await world.refund('bi_1', 20, 'r2'); // 60 more, after confirmation
    await world.refund('bi_1', 20, 'r1'); // redeliveries
    await world.refund('bi_1', 20, 'r2');
    expect(world.fake.adjustments.map((a) => a.amountUsdCents)).toEqual([60, 60]);
  });

  it('the refund READ the row as ACCRUED, then the whole payout lands before its swap: the swap misses on STATE, re-reads, and records the debit', async () => {
    enable();
    const world = refundWorld([{ id: 'bi_1', share: 300 }]);
    await world.accrue('bi_1');
    const transfer = okTransfer();
    const realFind = world.fake.affiliateLedgerEntry.findUnique;
    let injected = false;
    world.fake.affiliateLedgerEntry.findUnique = async (args: any) => {
      const out = await realFind(args);
      if (!injected && out?.state === 'ACCRUED') {
        injected = true;
        await settle(world.db, transfer); // claim + transfer + SETTLED, all before the refund's swap
      }
      return out;
    };

    const out = await world.refund('bi_1', 40, 'r1');

    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer.mock.calls[0]![0].amountUsdDollars).toBe(3); // sent in full: the refund had not landed
    expect(out.affiliateDebitRecordedUsdCents).toBe(120); // so the refund MUST be a debit
    expect(world.fake.adjustments.map((a) => a.amountUsdCents)).toEqual([120]);
    expect(world.fake.rows[0]).toMatchObject({ state: 'SETTLED', reversedUsdCents: 120 });
  });

  it('a refund racing a settle of the same row, in every task order, never both shrinks the claim AND debits the same cents', async () => {
    enable();
    for (const order of ['refund-first', 'settle-first', 'together'] as const) {
      const world = refundWorld([{ id: 'bi_1', share: 300 }]);
      await world.accrue('bi_1');
      const transfer = okTransfer();
      if (order === 'refund-first') {
        await world.refund('bi_1', 40, 'r1');
        await settle(world.db, transfer);
      } else if (order === 'settle-first') {
        await settle(world.db, transfer);
        await world.refund('bi_1', 40, 'r1');
      } else {
        await Promise.all([settle(world.db, transfer), world.refund('bi_1', 40, 'r1')]);
        await settle(world.db, transfer); // the cron would pick up a missed claim
      }
      const sent = transfer.mock.calls.reduce((s, c) => s + Math.round(c[0].amountUsdDollars * 100), 0);
      const debits = world.fake.adjustments.reduce((s, a) => s + a.amountUsdCents, 0);
      // Whatever the order, the 120 refunded is accounted for exactly once: either the recruiter was
      // sent 120 less (180), or they were sent the full 300 and carry a 120 debit. Both net to 180.
      expect(sent - debits).toBe(180);
      expect([180, 300]).toContain(sent);
    }
  });
});

describe('a transfer failure after netting never loses or repeats the netting', () => {
  it('a definitive 4xx refusal returns the row to ACCRUED with the debit STILL applied; the retry sends the same net once', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()], adjustments: [debit(120)] });
    const refuse = vi.fn(async () => {
      throw new Error('Whop /transfers failed (422): amount invalid');
    });
    const first = await settle(db, refuse);
    expect(first.failed).toBe(1);
    expect(db.rows[0]).toMatchObject({ state: 'ACCRUED', adjustmentAppliedUsdCents: 120, transferFeeUsdCents: null });
    expect(db.adjustments[0]).toMatchObject({ appliedUsdCents: 120, state: 'APPLIED' });

    const transfer = okTransfer();
    await settle(db, transfer);
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer.mock.calls[0]![0].amountUsdDollars).toBe(1.8);
    expect(db.rows[0]).toMatchObject({ state: 'SETTLED', adjustmentAppliedUsdCents: 120, netPaidUsdCents: 180 });
    expect(db.adjustments[0].appliedUsdCents).toBe(120); // not applied a second time
  });

  it('after a refusal, a NEW debit that arrived meanwhile is netted on top of the relief already applied', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()], adjustments: [debit(120, { id: 'd1' })] });
    const refuse = vi.fn(async () => {
      throw new Error('Whop /transfers failed (400): nope');
    });
    await settle(db, refuse);
    db.adjustments.push({ id: 'd2', recruiterPractitionerId: R, sourceLedgerEntryId: 'x', amountUsdCents: 50, appliedUsdCents: 0, state: 'OPEN', reason: 'REFUND', createdAt: new Date(Date.UTC(2026, 5, 1)), dedupeKey: 'k2' });
    const transfer = okTransfer();
    await settle(db, transfer);
    expect(db.rows[0]).toMatchObject({ adjustmentAppliedUsdCents: 170, netPaidUsdCents: 130 });
    expect(transfer.mock.calls[0]![0].amountUsdDollars).toBe(1.3);
  });

  it('a non-definitive failure (5xx / timeout) parks the row HELD with the debit applied; it is never re-selected or re-netted', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()], adjustments: [debit(120)] });
    const timeout = vi.fn(async () => {
      throw new Error('Whop /transfers failed (502): bad gateway');
    });
    const first = await settle(db, timeout);
    expect(first.held).toBe(1);
    expect(db.rows[0]).toMatchObject({ state: 'HELD', adjustmentAppliedUsdCents: 120 });
    const transfer = okTransfer();
    const second = await settle(db, transfer);
    expect(second.matched).toBe(0);
    expect(transfer).not.toHaveBeenCalled();
    expect(db.adjustments[0].appliedUsdCents).toBe(120);
  });

  it('gives up after the attempt limit with the netting intact', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()], adjustments: [debit(120)] });
    const refuse = vi.fn(async () => {
      throw new Error('Whop /transfers failed (403): forbidden');
    });
    for (let i = 0; i < MAX_TRANSFER_ATTEMPTS + 1; i += 1) await settle(db, refuse);
    expect(db.rows[0].state).toBe('HELD');
    expect(db.rows[0].adjustmentAppliedUsdCents).toBe(120);
    expect(db.adjustments[0].appliedUsdCents).toBe(120);
    expect(refuse).toHaveBeenCalledTimes(MAX_TRANSFER_ATTEMPTS);
  });
});

describe('relief applied by a rejected attempt that a later refund makes too generous is re-opened, not forgotten', () => {
  it('ACCRUED with 120 already netted, then a refund leaves the share worth only 50: SETTLED net 0, and a new 70 debit is opened', async () => {
    enable();
    const db = fakeAffiliateDb({
      practitioners: wallets,
      entries: [entry({ adjustmentAppliedUsdCents: 120, reversedUsdCents: 250 })], // G = 50, relief 120
    });
    const transfer = okTransfer();
    await settle(db, transfer);
    expect(transfer).not.toHaveBeenCalled();
    expect(db.rows[0]).toMatchObject({ state: 'SETTLED', netPaidUsdCents: 0, transferUsdCents: 0 });
    expect(db.adjustments).toHaveLength(1);
    expect(db.adjustments[0]).toMatchObject({ amountUsdCents: 70, appliedUsdCents: 0, state: 'OPEN', recruiterPractitionerId: R });
    // Running it again re-opens nothing.
    await settle(db, transfer);
    expect(db.adjustments).toHaveLength(1);
  });

  it('a share fully refunded after relief was applied: the whole relief becomes a debit', async () => {
    enable();
    const db = fakeAffiliateDb({
      practitioners: wallets,
      entries: [entry({ adjustmentAppliedUsdCents: 120, reversedUsdCents: 300 })],
    });
    await settle(db, okTransfer());
    expect(db.adjustments.map((a) => a.amountUsdCents)).toEqual([120]);
  });
});

/* ------------------------------------------------------------------------------------------ */

/**
 * The whole chain on one fake database: accrual (the real `accrueAffiliateShare`), the refund
 * reversal (the real `reverseReferralOnRefund`), and the settle sweep. Each booking is a $100
 * own-client session whose recruiter share is `share` cents.
 */
function refundWorld(bookings: Array<{ id: string; share: number }>) {
  const fake = fakeAffiliateDb({ practitioners: wallets });
  const fees: Array<Record<string, any>> = bookings.map((b, i) => ({
    kind: 'APPLICATION_FEE',
    whopPaymentId: `pay_${b.id}`,
    bookingIntentId: b.id,
    dedupeKey: `APPLICATION_FEE:${b.id}`,
    seq: i,
  }));
  const db: any = {
    affiliateLedgerEntry: fake.affiliateLedgerEntry,
    affiliateBalanceAdjustment: fake.affiliateBalanceAdjustment,
    $transaction: fake.$transaction,
    bookingFeeSnapshot: {
      findUnique: async (args: any) => {
        const b = bookings.find((x) => x.id === args.where.bookingIntentId);
        return b
          ? { bookingIntentId: b.id, priceUsdCents: 10_000, affiliateShareUsdCents: b.share, recruiterPractitionerId: R }
          : null;
      },
    },
    referralLedgerEntry: { findFirst: async () => null, update: async () => ({}) },
    feeLedgerEntry: {
      upsert: async (args: any) => {
        if (!fees.find((l) => l.dedupeKey === args.where.dedupeKey)) fees.push({ ...args.create });
        return args.create;
      },
      findFirst: async (args: any) =>
        fees.find((l) => l.kind === args.where.kind && l.whopPaymentId === args.where.whopPaymentId) ?? null,
      findMany: async (args: any) => fees.filter((l) => Object.entries(args.where).every(([k, v]) => l[k] === v)),
    },
  };
  return {
    fake,
    db,
    accrue: (id: string, paidAt: Date = NOW) => {
      const b = bookings.find((x) => x.id === id)!;
      return accrueAffiliateShare(db, {
        bookingIntentId: b.id,
        recruitedPractitionerId: Y,
        whopPaymentId: `pay_${b.id}`,
        snapshot: {
          priceUsdCents: 10_000,
          applicationFeeUsdCents: b.share,
          nhpFeeUsdCents: 0,
          affiliateBps: 300,
          affiliateShareUsdCents: b.share,
          recruiterPractitionerId: R,
        },
        holdDays: 0,
        paidAt,
      });
    },
    refund: (id: string, dollars: number, refundId: string) =>
      reverseReferralOnRefund(db, { whopPaymentId: `pay_${id}`, refundAmountUsdDollars: dollars, refundId, at: NOW }),
  };
}

describe('SELF-AUDIT TRACE: a recruited $100 own-client session, end to end', () => {
  it('accrual $3 -> eligible immediately -> settle after the flag -> $40 refund after payout = $1.20 debit -> next $3 share nets to $1.80 (before the fee) -> debit APPLIED', async () => {
    const world = refundWorld([{ id: 'bi_1', share: 300 }, { id: 'bi_2', share: 300 }]);

    // 1. Accrual: $3, and eligible AT PAYMENT (holdUntil = paidAt, holdDays 0).
    const accrued = await world.accrue('bi_1');
    expect(accrued).toMatchObject({ accrued: true, shareUsdCents: 300 });
    expect(world.fake.rows[0]).toMatchObject({ shareUsdCents: 300, state: 'ACCRUED', holdDays: 0 });
    expect(world.fake.rows[0].holdUntil.getTime()).toBe(NOW.getTime());

    // 2. Flag OFF: nothing is read, written or called.
    const off = vi.spyOn(world.fake.affiliateLedgerEntry, 'findMany');
    const transfer = okTransfer();
    expect((await settle(world.db, transfer)).blocked).toBe('skipped: transfers disabled');
    expect(off).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
    off.mockRestore();

    // 3. Flag ON (default 3% fee, charged to the sender): the first $3 is paid at once.
    enable(null);
    await settle(world.db, transfer);
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer.mock.calls[0]![0].amountUsdDollars).toBe(2.91); // S + ceil(3% S) = 300
    expect(world.fake.rows[0]).toMatchObject({ state: 'SETTLED', grossShareUsdCents: 300, transferFeeUsdCents: 9, netPaidUsdCents: 291 });

    // 4. A $40 refund of that $100 payment arrives AFTER the payout: a $1.20 debit, no clawback.
    const out = await world.refund('bi_1', 40, 'ref_1');
    expect(out).toMatchObject({ affiliateReversedUsdCents: 120, affiliateDebitRecordedUsdCents: 120 });
    expect(world.fake.adjustments).toHaveLength(1);
    expect(world.fake.adjustments[0]).toMatchObject({ amountUsdCents: 120, appliedUsdCents: 0, state: 'OPEN' });
    expect(transfer).toHaveBeenCalledTimes(1); // nothing reversed by transfer

    // The webhook is redelivered 3x: still one debit.
    await world.refund('bi_1', 40, 'ref_1');
    await world.refund('bi_1', 40, 'ref_1');
    expect(world.fake.adjustments).toHaveLength(1);

    // 5. The NEXT $3 share: nets $1.20, leaving $1.80 BEFORE the fee helper; the fee helper then
    //    takes $0.06 off that (S + ceil(3% S) <= 180 -> S = 174).
    await world.accrue('bi_2');
    await settle(world.db, transfer);
    const second = world.fake.rows.find((r) => r.bookingIntentId === 'bi_2')!;
    expect(second).toMatchObject({
      state: 'SETTLED',
      grossShareUsdCents: 300,
      adjustmentAppliedUsdCents: 120,
      transferFeeUsdCents: 6,
      netPaidUsdCents: 174,
    });
    expect(transfer.mock.calls[1]![0].amountUsdDollars).toBe(1.74);
    expect(300 - 120).toBe(180); // the pre-fee remainder named in the ruling

    // 6. The debit is APPLIED, exactly once, and a later redelivery of the refund adds nothing.
    expect(world.fake.adjustments[0]).toMatchObject({ appliedUsdCents: 120, state: 'APPLIED' });
    await world.refund('bi_1', 40, 'ref_1');
    await settle(world.db, transfer);
    expect(world.fake.adjustments).toHaveLength(1);
    expect(transfer).toHaveBeenCalledTimes(2);

    // Books close: the recruiter was sent 291 + 174 = 465 of 600 gross, 120 went to the refund, 15 to Whop's fees.
    expect(291 + 174 + 120 + 9 + 6).toBe(600);
  });
});
