import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_TRANSFER_ATTEMPTS,
  TRANSFERS_DISABLED_REASON,
  isDefinitiveTransferRejection,
  settleAffiliateShares,
} from '@/lib/affiliate-payouts';
import { WhopNotConfigured } from '@/lib/whop';
import { fakeAffiliateDb } from './helpers/fake-affiliate-db';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * SETTLING RECRUITERS (spec v1.5 section 5; criterion e14). Against a MOCKED transfer API only:
 * nothing here, or in the code it exercises, can reach Whop. `WHOP_TRANSFERS_ENABLED` is false in
 * production and these tests flip it only inside this file, on the process env, then restore it.
 *
 * `POST /transfers` has no idempotency key, so the properties that matter are the ones that make a
 * double payment impossible without one: a guarded claim, a SENDING state nothing re-selects, and
 * a failure that is classified before it is retried.
 */

const ENV = ['WHOP_TRANSFERS_ENABLED', 'WHOP_COMPANY_API_KEY', 'WHOP_PARENT_COMPANY_ID'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

const enable = () => {
  process.env.WHOP_TRANSFERS_ENABLED = 'true';
  process.env.WHOP_COMPANY_API_KEY = 'test-key';
  process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';
};

const NOW = new Date(Date.UTC(2027, 0, 1));
const PAST = new Date(Date.UTC(2026, 11, 1));
const FUTURE = new Date(Date.UTC(2027, 1, 1));

const VERIFIED = { whopCompanyId: 'biz_R', whopPayoutsEnabled: true };
const wallets = {
  R: VERIFIED,
  U: { whopCompanyId: null, whopPayoutsEnabled: false },
  P: { whopCompanyId: 'biz_P', whopPayoutsEnabled: false },
};

const entry = (over: Record<string, any> = {}) => ({
  bookingIntentId: 'bi_1',
  recruiterPractitionerId: 'R',
  recruitedPractitionerId: 'Y',
  grossUsdCents: 10_000,
  bps: 300,
  shareUsdCents: 300,
  holdUntil: PAST,
  holdDays: 90,
  ...over,
});

const okTransfer = () => vi.fn(async () => ({ transferId: 'tr_1' }));

describe('the flag: WHOP_TRANSFERS_ENABLED stays false and the job is inert', () => {
  it('unset: reports "skipped: transfers disabled", reads nothing, writes nothing, calls nothing', async () => {
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()] });
    const find = vi.spyOn(db.affiliateLedgerEntry, 'findMany');
    const update = vi.spyOn(db.affiliateLedgerEntry, 'updateMany');
    const transfer = okTransfer();

    const summary = await settleAffiliateShares(db as any, { transfer, at: NOW });

    expect(summary.blocked).toBe('skipped: transfers disabled');
    expect(TRANSFERS_DISABLED_REASON).toBe('skipped: transfers disabled');
    expect(summary).toMatchObject({ matched: 0, settled: 0 });
    expect(transfer).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(db.rows[0]).toMatchObject({ state: 'ACCRUED', whopTransferId: null, settledAt: null });
  });

  it.each(['false', '0', 'TRUE', 'True', '1', 'yes', ''])('"%s" is not "true": still disabled', async (value) => {
    process.env.WHOP_COMPANY_API_KEY = 'k';
    process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';
    process.env.WHOP_TRANSFERS_ENABLED = value;
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()] });
    const transfer = okTransfer();
    const summary = await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(summary.blocked).toBe(TRANSFERS_DISABLED_REASON);
    expect(transfer).not.toHaveBeenCalled();
    expect(db.rows[0].state).toBe('ACCRUED');
  });

  it('enabled but Whop is not configured: still nothing, and the reason says so', async () => {
    process.env.WHOP_TRANSFERS_ENABLED = 'true';
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()] });
    const transfer = okTransfer();
    const summary = await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(summary.blocked).toMatch(/not configured/i);
    expect(transfer).not.toHaveBeenCalled();
  });
});

describe('e14: an accrued entry settles through the mocked transfer path', () => {
  it('past the hold, recruiter verified: transfers DOLLARS, marks SETTLED with the receipt', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()] });
    const transfer = okTransfer();

    const summary = await settleAffiliateShares(db as any, { transfer, at: NOW });

    expect(summary).toMatchObject({ matched: 1, settled: 1, failed: 0, skipped: 0, blocked: null });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer).toHaveBeenCalledWith({
      originId: 'biz_parent',
      destinationId: 'biz_R',
      amountUsdDollars: 3, // 300 CENTS -> 3 DOLLARS: the 100x trap
    });
    expect(db.rows[0]).toMatchObject({
      state: 'SETTLED',
      whopTransferId: 'tr_1',
      settledAt: NOW,
      transferUsdCents: 300,
      lastError: null,
    });
  });

  it('a settled row is never paid again by a later run', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()] });
    const transfer = okTransfer();
    await settleAffiliateShares(db as any, { transfer, at: NOW });
    await settleAffiliateShares(db as any, { transfer, at: NOW });
    await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it('transfers the amount NET of refunds already applied, in dollars', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry({ reversedUsdCents: 99 })] });
    const transfer = okTransfer();
    await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ amountUsdDollars: 2.01 }));
    expect(db.rows[0].transferUsdCents).toBe(201);
  });

  it('a fully reversed row is never sent as a zero transfer', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry({ reversedUsdCents: 300 })] });
    const transfer = okTransfer();
    const summary = await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(transfer).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(db.rows[0].state).toBe('ACCRUED');
  });
});

describe('who is paid, and when', () => {
  it('a recruiter WITHOUT a verified wallet stays ACCRUED: nothing is forfeited, nothing is sent', async () => {
    enable();
    const db = fakeAffiliateDb({
      practitioners: wallets,
      entries: [
        entry({ id: 'a', recruiterPractitionerId: 'U' }), // no Whop company at all
        entry({ id: 'b', bookingIntentId: 'bi_2', recruiterPractitionerId: 'P' }), // connected, payouts not enabled
      ],
    });
    const transfer = okTransfer();
    const summary = await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(summary.matched).toBe(0);
    expect(transfer).not.toHaveBeenCalled();
    expect(db.rows.map((r) => r.state)).toEqual(['ACCRUED', 'ACCRUED']);
  });

  it('is retroactive: the same entry settles the moment its recruiter becomes verified', async () => {
    enable();
    const w = { R: { whopCompanyId: null as string | null, whopPayoutsEnabled: false } };
    const db = fakeAffiliateDb({ practitioners: w, entries: [entry()] });
    const transfer = okTransfer();
    await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(transfer).not.toHaveBeenCalled();
    w.R = { whopCompanyId: 'biz_R', whopPayoutsEnabled: true };
    await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(db.rows[0].state).toBe('SETTLED');
  });

  it('inside the hold nothing is paid; at the instant it lapses it is', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry({ holdUntil: FUTURE })] });
    const transfer = okTransfer();
    await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(transfer).not.toHaveBeenCalled();
    await settleAffiliateShares(db as any, { transfer, at: FUTURE });
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it('HELD, SENDING, REVERSED and SETTLED rows are never selected', async () => {
    enable();
    const db = fakeAffiliateDb({
      practitioners: wallets,
      entries: ['HELD', 'SENDING', 'REVERSED', 'SETTLED'].map((state, i) =>
        entry({ id: `x${i}`, bookingIntentId: `bi_${i}`, state }),
      ),
    });
    const transfer = okTransfer();
    await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(transfer).not.toHaveBeenCalled();
  });
});

describe('a transfer failure never pays twice', () => {
  it('a definitive 4xx refusal returns the row to ACCRUED; the retry settles it ONCE', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()] });
    const transfer = vi
      .fn()
      .mockRejectedValueOnce(new Error('Whop /transfers failed (402): insufficient balance'))
      .mockResolvedValue({ transferId: 'tr_ok' });

    const first = await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(first).toMatchObject({ failed: 1, settled: 0, held: 0 });
    expect(db.rows[0]).toMatchObject({ state: 'ACCRUED', transferAttempts: 1 });
    expect(db.rows[0].lastError).toMatch(/402/);

    const second = await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(second.settled).toBe(1);
    await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(transfer).toHaveBeenCalledTimes(2); // one refused, one paid, never a third
    expect(db.rows[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'tr_ok', transferAttempts: 2 });
  });

  it.each([
    ['a network error', new TypeError('fetch failed')],
    ['a timeout', new Error('The operation was aborted due to timeout')],
    ['a 5xx (Whop may have executed it)', new Error('Whop /transfers failed (502): bad gateway')],
  ])('%s is AMBIGUOUS: the row is parked HELD and the next run does NOT retry it', async (_n, err) => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()] });
    const transfer = vi.fn().mockRejectedValue(err);

    const first = await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(first).toMatchObject({ failed: 1, held: 1 });
    expect(db.rows[0].state).toBe('HELD');

    await settleAffiliateShares(db as any, { transfer, at: NOW });
    await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it('gives up after repeated definitive refusals instead of retrying forever', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()] });
    const transfer = vi.fn().mockRejectedValue(new Error('Whop /transfers failed (429): slow down'));
    for (let i = 0; i < MAX_TRANSFER_ATTEMPTS + 2; i++) {
      await settleAffiliateShares(db as any, { transfer, at: NOW });
    }
    expect(transfer).toHaveBeenCalledTimes(MAX_TRANSFER_ATTEMPTS);
    expect(db.rows[0].state).toBe('HELD');
  });

  it('a crash AFTER the money moved (the receipt cannot be written) leaves SENDING, which is never re-sent', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()] });
    const real = db.affiliateLedgerEntry.updateMany;
    db.affiliateLedgerEntry.updateMany = async (args: any) => {
      if (args.data.state === 'SETTLED') throw new Error('connection reset');
      return real(args);
    };
    const transfer = okTransfer();

    const first = await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(first.failed).toBe(1);
    expect(db.rows[0].state).toBe('SENDING');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('TRANSFER SENT BUT NOT RECORDED'),
      expect.stringContaining('tr_1'),
    );

    db.affiliateLedgerEntry.updateMany = real;
    await settleAffiliateShares(db as any, { transfer, at: NOW });
    await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it('a refund that lands between the read and the claim makes the claim MISS; no stale amount is sent', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()] });
    const realFind = db.affiliateLedgerEntry.findMany;
    db.affiliateLedgerEntry.findMany = async (args: any) => {
      const rows = await realFind(args);
      // The refund path writes after the sweep has read the row.
      db.rows[0].reversedUsdCents = 300;
      return rows;
    };
    const transfer = okTransfer();
    const summary = await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(summary.skipped).toBe(1);
    expect(transfer).not.toHaveBeenCalled();
    expect(db.rows[0].state).toBe('ACCRUED');
  });
});

describe('a race: two settle runs at once pay once', () => {
  it('both runs read the row, exactly one wins the guarded claim, one transfer is made', async () => {
    enable();
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const transfer = vi.fn(async () => {
      await gate; // hold the winner mid-flight so the loser runs entirely inside the window
      return { transferId: 'tr_race' };
    });

    const a = settleAffiliateShares(db as any, { transfer, at: NOW });
    const b = settleAffiliateShares(db as any, { transfer, at: NOW });
    // let both reach the claim, then let the transfer finish
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [sa, sb] = await Promise.all([a, b]);

    expect(transfer).toHaveBeenCalledTimes(1);
    expect(sa.settled + sb.settled).toBe(1);
    expect(sa.skipped + sb.skipped).toBe(1);
    expect(db.rows[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'tr_race' });
  });

  it('five concurrent runs over several rows pay each row exactly once', async () => {
    enable();
    const db = fakeAffiliateDb({
      practitioners: wallets,
      entries: [0, 1, 2].map((i) => entry({ id: `e${i}`, bookingIntentId: `bi_${i}` })),
    });
    const transfer = vi.fn(async () => ({ transferId: `tr_${Math.random()}` }));
    await Promise.all([1, 2, 3, 4, 5].map(() => settleAffiliateShares(db as any, { transfer, at: NOW })));
    expect(transfer).toHaveBeenCalledTimes(3);
    expect(db.rows.every((r) => r.state === 'SETTLED')).toBe(true);
  });
});

describe('isDefinitiveTransferRejection', () => {
  it('is true only for a response that proves Whop refused the request', () => {
    expect(isDefinitiveTransferRejection(new Error('Whop /transfers failed (400): bad'))).toBe(true);
    expect(isDefinitiveTransferRejection(new Error('Whop /transfers failed (403): verify your business'))).toBe(true);
    expect(isDefinitiveTransferRejection(new WhopNotConfigured('transfer'))).toBe(true);
    expect(isDefinitiveTransferRejection(new Error('Whop /transfers failed (500): boom'))).toBe(false);
    expect(isDefinitiveTransferRejection(new Error('Whop /transfers failed (504): timeout'))).toBe(false);
    expect(isDefinitiveTransferRejection(new TypeError('fetch failed'))).toBe(false);
    expect(isDefinitiveTransferRejection('weird')).toBe(false);
  });
});
