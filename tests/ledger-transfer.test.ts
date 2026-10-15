import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PARKED_RETRY_MS,
  STALE_SENDING_AFTER_MS,
  TRANSFERS_DISABLED_REASON,
  UNCONFIRMED_AFTER_MS,
  classifyTransferFailure,
  findUnconfirmedTransfers,
  retryDelayMs,
  settleLedgerEntryBestEffort,
  toTransferDollars,
  transfersAllowlist,
  type LookupFn,
} from '@/lib/ledger-transfer';
import { AFFILIATE_LEDGER, REFERRAL_LEDGER } from '@/lib/ledger-config';
import { settleAffiliateShares } from '@/lib/affiliate-payouts';
import { settlePayableShares } from '@/lib/referral-payouts';
import { WhopNotConfigured } from '@/lib/whop';
import { fakeLedgerDb, type Entry } from './helpers/fake-ledger-db';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * THE SHARED TRANSFER ROUTINE, run against BOTH payout ledgers (recruiter and referrer) with the
 * same assertions. Against a MOCKED transfer API only: nothing here, or in the code it exercises,
 * can reach Whop. `WHOP_TRANSFERS_ENABLED` is flipped only inside this file, on the process env, and
 * restored.
 *
 * Prisma is replaced by an in-memory fake that keeps the properties the code depends on (atomic
 * guarded updates, unique keys, transaction rollback); the money arithmetic is the real code.
 */

const ENV = ['WHOP_TRANSFERS_ENABLED', 'WHOP_TRANSFERS_ALLOWLIST', 'WHOP_COMPANY_API_KEY', 'WHOP_PARENT_COMPANY_ID'];
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
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 60_000;

const VERIFIED = { whopCompanyId: 'biz_R', whopPayoutsEnabled: true };
const wallets = {
  R: VERIFIED,
  S: { whopCompanyId: 'biz_S', whopPayoutsEnabled: true },
  U: { whopCompanyId: null, whopPayoutsEnabled: false },
  P: { whopCompanyId: 'biz_P', whopPayoutsEnabled: false },
};

const okTransfer = () => {
  let n = 0;
  return vi.fn<(args: any) => Promise<{ transferId: string }>>(async () => ({ transferId: `tr_${++n}` }));
};
const noLookup: LookupFn = async () => null;

type Kind = {
  name: 'affiliate' | 'referral';
  cfg: typeof AFFILIATE_LEDGER;
  waiting: 'ACCRUED' | 'PAYABLE';
  payee: 'recruiterPractitionerId' | 'referrerPractitionerId';
  entry(over?: Record<string, any>): Entry;
  settle(db: any, over?: Record<string, any>): ReturnType<typeof settleAffiliateShares>;
  rows(db: any): Entry[];
  adjustments(db: any): Entry[];
  entryDelegate(db: any): any;
  adjustmentDelegate(db: any): any;
  debit(amount: number, over?: Record<string, any>): Entry;
};

const KINDS: Kind[] = [
  {
    name: 'affiliate',
    cfg: AFFILIATE_LEDGER,
    waiting: 'ACCRUED',
    payee: 'recruiterPractitionerId',
    entry: (over = {}) => ({
      bookingIntentId: 'bi_1',
      recruiterPractitionerId: 'R',
      recruitedPractitionerId: 'Y',
      grossUsdCents: 10_000,
      bps: 300,
      shareUsdCents: 300,
      holdDays: 0,
      holdUntil: new Date(Date.UTC(2026, 11, 1)),
      ...over,
    }),
    settle: (db, over = {}) =>
      settleAffiliateShares(db, { transfer: okTransfer(), lookup: noLookup, at: NOW, ...over } as any),
    rows: (db) => db.affiliateRows,
    adjustments: (db) => db.affiliateAdjustments,
    entryDelegate: (db) => db.affiliateLedgerEntry,
    adjustmentDelegate: (db) => db.affiliateBalanceAdjustment,
    debit: (amount, over = {}) => ({ recruiterPractitionerId: 'R', sourceLedgerEntryId: 'afl_old', amountUsdCents: amount, ...over }),
  },
  {
    name: 'referral',
    cfg: REFERRAL_LEDGER as any,
    waiting: 'PAYABLE',
    payee: 'referrerPractitionerId',
    entry: (over = {}) => ({
      bookingIntentId: 'bi_1',
      referrerPractitionerId: 'R',
      servingPractitionerId: 'Y',
      grossUsdCents: 1_500,
      referrerShareUsdCents: 300,
      ...over,
    }),
    settle: (db, over = {}) =>
      settlePayableShares(db, { transfer: okTransfer(), lookup: noLookup, at: NOW, ...over } as any) as any,
    rows: (db) => db.referralRows,
    adjustments: (db) => db.referralAdjustments,
    entryDelegate: (db) => db.referralLedgerEntry,
    adjustmentDelegate: (db) => db.referralBalanceAdjustment,
    debit: (amount, over = {}) => ({ referrerPractitionerId: 'R', sourceLedgerEntryId: 'rfl_old', amountUsdCents: amount, ...over }),
  },
];

function makeDb(k: Kind, o: { practitioners?: Record<string, any>; entries?: Entry[]; adjustments?: Entry[] } = {}) {
  return fakeLedgerDb({
    practitioners: o.practitioners ?? wallets,
    [k.name]: { entries: o.entries, adjustments: o.adjustments },
  } as any);
}

describe('pure helpers', () => {
  it('toTransferDollars converts cents to DOLLARS and refuses anything that is not a whole positive amount', () => {
    expect(toTransferDollars(2_000)).toBe(20);
    expect(toTransferDollars(150)).toBe(1.5);
    expect(() => toTransferDollars(20.5)).toThrow(/whole number of cents/i);
    expect(() => toTransferDollars(0)).toThrow();
    expect(() => toTransferDollars(-100)).toThrow();
    expect(() => toTransferDollars(2_500_001)).toThrow(/25,?000/);
  });

  it('classifyTransferFailure: RETRY only for answers that pass; AMBIGUOUS when a transfer may exist; PARKED for refusals', () => {
    const c = (m: string) => classifyTransferFailure(new Error(m));
    expect(c('Whop /transfers failed (402): insufficient available balance')).toBe('RETRY');
    expect(c('Whop /transfers failed (400): Not enough funds')).toBe('RETRY');
    expect(c('Whop /transfers failed (429): slow down')).toBe('RETRY');
    expect(c('Whop /transfers failed (500): boom')).toBe('AMBIGUOUS');
    expect(c('Whop /transfers failed (504): gateway timeout')).toBe('AMBIGUOUS');
    expect(c('Whop /transfers failed (408): request timeout')).toBe('AMBIGUOUS');
    expect(c('Whop /transfers failed (409): duplicate in flight')).toBe('AMBIGUOUS');
    expect(c('Whop /transfers failed (403): Please verify your business before transferring funds')).toBe('PARKED');
    expect(c('Whop /transfers failed (400): bad request')).toBe('PARKED');
    expect(classifyTransferFailure(new WhopNotConfigured('transfer'))).toBe('PARKED');
    expect(classifyTransferFailure(new TypeError('fetch failed'))).toBe('AMBIGUOUS');
    expect(classifyTransferFailure(new Error('The operation was aborted due to timeout'))).toBe('AMBIGUOUS');
    expect(classifyTransferFailure('weird')).toBe('AMBIGUOUS');
  });

  it('retryDelayMs doubles from a minute and is capped at an hour', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([MIN, 2 * MIN, 4 * MIN, 8 * MIN]);
    expect(retryDelayMs(30)).toBe(60 * MIN);
    expect(retryDelayMs(0)).toBe(MIN);
  });

  it('transfersAllowlist: unset is no restriction; a blank value is an empty list that pays nobody', () => {
    expect(transfersAllowlist({})).toBeNull();
    expect(Array.from(transfersAllowlist({ WHOP_TRANSFERS_ALLOWLIST: ' a , b,,c ' })!)).toEqual(['a', 'b', 'c']);
    expect(transfersAllowlist({ WHOP_TRANSFERS_ALLOWLIST: '' })!.size).toBe(0);
    expect(transfersAllowlist({ WHOP_TRANSFERS_ALLOWLIST: ' , ' })!.size).toBe(0);
  });
});

describe.each(KINDS)('$name ledger: the flag', (k) => {
  it('unset: reports "skipped: transfers disabled", reads nothing, writes nothing, calls nothing', async () => {
    const db = makeDb(k, { entries: [k.entry()] });
    const find = vi.spyOn(k.entryDelegate(db), 'findMany');
    const update = vi.spyOn(k.entryDelegate(db), 'updateMany');
    const tx = vi.spyOn(db, '$transaction');
    const transfer = okTransfer();

    const summary = await k.settle(db, { transfer });

    expect(summary.blocked).toBe(TRANSFERS_DISABLED_REASON);
    expect(summary).toMatchObject({ matched: 0, settled: 0 });
    expect(transfer).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, whopTransferId: null, settledAt: null });
  });

  it.each(['false', '0', 'TRUE', 'True', '1', 'yes', ''])('"%s" is not "true": still disabled', async (value) => {
    process.env.WHOP_COMPANY_API_KEY = 'k';
    process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';
    process.env.WHOP_TRANSFERS_ENABLED = value;
    const db = makeDb(k, { entries: [k.entry()] });
    const transfer = okTransfer();
    const summary = await k.settle(db, { transfer });
    expect(summary.blocked).toBe(TRANSFERS_DISABLED_REASON);
    expect(transfer).not.toHaveBeenCalled();
    expect(k.rows(db)[0].state).toBe(k.waiting);
  });

  it('enabled but Whop is not configured: still nothing, and the reason says so', async () => {
    process.env.WHOP_TRANSFERS_ENABLED = 'true';
    const db = makeDb(k, { entries: [k.entry()] });
    const transfer = okTransfer();
    const summary = await k.settle(db, { transfer });
    expect(summary.blocked).toMatch(/not configured/i);
    expect(transfer).not.toHaveBeenCalled();
  });
});

describe.each(KINDS)('$name ledger: transfer at clearing', (k) => {
  it('sends the FULL share in dollars, from the parent, with the row id as idempotence key and the ids as metadata', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1' })] });
    const transfer = okTransfer();

    const summary = await k.settle(db, { transfer });

    expect(summary).toMatchObject({ matched: 1, settled: 1, failed: 0, skipped: 0, blocked: null });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer).toHaveBeenCalledWith({
      originId: 'biz_parent',
      destinationId: 'biz_R',
      amountUsdDollars: 3, // 300 CENTS -> 3 DOLLARS: the 100x trap
      metadata: { kind: k.name, ledger_entry_id: 'led_1', booking_intent_id: 'bi_1' },
      idempotenceKey: 'led_1',
    });
    expect(k.rows(db)[0]).toMatchObject({
      state: 'SETTLED',
      whopTransferId: 'tr_1',
      settledAt: NOW,
      grossShareUsdCents: 300,
      transferUsdCents: 300,
      netPaidUsdCents: 300,
      adjustmentAppliedUsdCents: null,
      lastError: null,
      transferFeeUsdCents: null, // no fee is modelled or recorded anywhere
    });
  });

  it('a settled row is never paid again by a later run', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    await k.settle(db, { transfer });
    await k.settle(db, { transfer, at: at(24 * 60 * MIN) });
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it('there is no hold: a row is paid at the instant it exists, whatever holdUntil/holdDays say', async () => {
    enable();
    const db = makeDb(k, {
      entries: [k.entry({ holdUntil: at(90 * 24 * 60 * MIN), holdDays: 90 })],
    });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it('transfers the amount NET of refunds already applied, in dollars', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ reversedUsdCents: 99 })] });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ amountUsdDollars: 2.01 }));
    expect(k.rows(db)[0]).toMatchObject({ grossShareUsdCents: 201, transferUsdCents: 201, netPaidUsdCents: 201 });
  });

  it('a fully reversed row is never sent as a zero transfer; it is healed to REVERSED', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ reversedUsdCents: 300 })] });
    const transfer = okTransfer();
    const summary = await k.settle(db, { transfer });
    expect(transfer).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(k.rows(db)[0].state).toBe('REVERSED');
  });

  it('a row that cannot pay does not starve the rows behind it: 60 reversed rows, then a payable one', async () => {
    enable();
    const dead = Array.from({ length: 60 }, (_, i) =>
      k.entry({ id: `dead${i}`, bookingIntentId: `bd_${i}`, reversedUsdCents: 300, createdAt: new Date(Date.UTC(2026, 0, 1) + i) }),
    );
    const db = makeDb(k, { entries: [...dead, k.entry({ id: 'live', bookingIntentId: 'bi_live', createdAt: new Date(Date.UTC(2026, 0, 2)) })] });
    const transfer = okTransfer();
    await k.settle(db, { transfer }); // clears the first 50 dead rows
    await k.settle(db, { transfer }); // clears the rest and reaches `live`
    await k.settle(db, { transfer });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(k.rows(db).find((r) => r.id === 'live')!.state).toBe('SETTLED');
  });

  it('a payee WITHOUT a verified wallet stays waiting: nothing is forfeited, nothing is sent', async () => {
    enable();
    const db = makeDb(k, {
      entries: [
        k.entry({ id: 'a', [k.payee]: 'U' }), // no Whop company at all
        k.entry({ id: 'b', bookingIntentId: 'bi_2', [k.payee]: 'P' }), // connected, payouts not enabled
      ],
    });
    const transfer = okTransfer();
    const summary = await k.settle(db, { transfer });
    expect(summary.matched).toBe(0);
    expect(transfer).not.toHaveBeenCalled();
    expect(k.rows(db).map((r) => r.state)).toEqual([k.waiting, k.waiting]);
  });

  it('is retroactive: the same row settles the moment its payee becomes verified', async () => {
    enable();
    const w = { R: { whopCompanyId: null as string | null, whopPayoutsEnabled: false } };
    const db = makeDb(k, { practitioners: w, entries: [k.entry()] });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(transfer).not.toHaveBeenCalled();
    w.R = { whopCompanyId: 'biz_R', whopPayoutsEnabled: true };
    await k.settle(db, { transfer });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(k.rows(db)[0].state).toBe('SETTLED');
  });

  it('SENDING (fresh), REVERSED and SETTLED rows are never selected', async () => {
    enable();
    const db = makeDb(k, {
      entries: ['SENDING', 'REVERSED', 'SETTLED'].map((state, i) =>
        k.entry({ id: `x${i}`, bookingIntentId: `bi_${i}`, state, lastAttemptAt: NOW, transferUsdCents: 300, ...(state === 'SETTLED' ? { settledAt: NOW } : {}) }),
      ),
    });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(transfer).not.toHaveBeenCalled();
  });
});

describe.each(KINDS)('$name ledger: a failed attempt never pays twice and never sits in limbo', (k) => {
  it('RETRY (insufficient balance): back to waiting with a backoff; not tried before it is due; then settles ONCE with the same key', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1' })] });
    const transfer = vi
      .fn()
      .mockRejectedValueOnce(new Error('Whop /transfers failed (402): insufficient available balance'))
      .mockResolvedValue({ transferId: 'tr_ok' });

    const first = await k.settle(db, { transfer });
    expect(first).toMatchObject({ failed: 1, retrying: 1, parked: 0, settled: 0 });
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, transferAttempts: 1, nextAttemptAt: at(MIN) });
    expect(k.rows(db)[0].lastError).toMatch(/402/);

    await k.settle(db, { transfer, at: at(30_000) }); // not due yet
    expect(transfer).toHaveBeenCalledTimes(1);

    const second = await k.settle(db, { transfer, at: at(MIN) });
    expect(second.settled).toBe(1);
    expect(transfer).toHaveBeenCalledTimes(2);
    const [a, b] = transfer.mock.calls;
    expect(b[0]).toEqual(a[0]); // the same request: same amount, destination, metadata and idempotence key
    expect(b[0].idempotenceKey).toBe('led_1');
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'tr_ok', transferAttempts: 2, nextAttemptAt: null, lastError: null });

    await k.settle(db, { transfer, at: at(10 * MIN) });
    expect(transfer).toHaveBeenCalledTimes(2); // never a third
  });

  it.each([
    ['a network error', new TypeError('fetch failed')],
    ['a timeout', new Error('The operation was aborted due to timeout')],
    ['a 5xx (Whop may have executed it)', new Error('Whop /transfers failed (502): bad gateway')],
  ])('%s is AMBIGUOUS: waiting again, and the next attempt LOOKS UP the transfer before sending', async (_n, err) => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1' })] });
    const transfer = vi.fn().mockRejectedValueOnce(err).mockResolvedValue({ transferId: 'tr_ok' });
    const lookup = vi.fn<LookupFn>(async () => null);

    const first = await k.settle(db, { transfer, lookup });
    expect(first).toMatchObject({ failed: 1, retrying: 1 });
    expect(lookup).not.toHaveBeenCalled(); // the first attempt has nothing to look up
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, transferUsdCents: 300, transferAttempts: 1 });

    await k.settle(db, { transfer, lookup, at: at(MIN) });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({ originId: 'biz_parent', destinationId: 'biz_R', ledgerEntryId: 'led_1' }),
    );
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(transfer.mock.calls[1][0]).toEqual(transfer.mock.calls[0][0]);
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'tr_ok' });
  });

  it('the earlier attempt DID reach Whop: the lookup finds it, the row is SETTLED with that id, and nothing is sent again', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1' })] });
    const transfer = vi.fn().mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));
    const lookup = vi.fn<LookupFn>(async () => ({ transferId: 'tr_found', amountUsdDollars: 3 }));

    await k.settle(db, { transfer, lookup });
    const second = await k.settle(db, { transfer, lookup, at: at(MIN) });

    expect(second).toMatchObject({ settled: 1, recovered: 1 });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'tr_found', netPaidUsdCents: 300 });
  });

  it('a lookup that cannot run sends NOTHING: the row waits and is retried later', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    const transfer = vi.fn().mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue({ transferId: 'tr_ok' });
    const lookup = vi.fn<LookupFn>().mockRejectedValueOnce(new Error('Whop /transfers lookup failed (503)')).mockResolvedValue(null);

    await k.settle(db, { transfer, lookup });
    const second = await k.settle(db, { transfer, lookup, at: at(MIN) });
    expect(second).toMatchObject({ failed: 1, retrying: 1, settled: 0 });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, transferAttempts: 2 });
    expect(k.rows(db)[0].lastError).toMatch(/lookup failed/);

    const third = await k.settle(db, { transfer, lookup, at: at(MIN + 2 * MIN) });
    expect(third.settled).toBe(1);
    expect(transfer).toHaveBeenCalledTimes(2);
  });

  it('PARKED (not verified): back to waiting with a reason, a long retry delay and an alert; retried when the delay passes', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    const transfer = vi
      .fn()
      .mockRejectedValueOnce(new Error('Whop /transfers failed (403): Please verify your business before transferring funds'))
      .mockResolvedValue({ transferId: 'tr_ok' });

    const first = await k.settle(db, { transfer });
    expect(first).toMatchObject({ failed: 1, parked: 1, retrying: 0 });
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, nextAttemptAt: at(PARKED_RETRY_MS) });
    expect(k.rows(db)[0].lastError).toMatch(/^PARKED: .*verify your business/);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('TRANSFER PARKED'), expect.stringContaining('led'));

    await k.settle(db, { transfer, at: at(PARKED_RETRY_MS - 1) });
    expect(transfer).toHaveBeenCalledTimes(1);
    await k.settle(db, { transfer, at: at(PARKED_RETRY_MS) });
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(k.rows(db)[0].state).toBe('SETTLED');
  });

  it('the amount is FIXED at the first claim: a refund after a failed attempt is a debit, and the retry sends the original amount', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    const transfer = vi.fn().mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue({ transferId: 'tr_ok' });
    await k.settle(db, { transfer });
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, transferUsdCents: 300 });

    // The refund path (compare-and-swap on state/reversed/claim) sees a claimed row.
    const { applyLedgerReversal } = await import('@/lib/ledger-reversal');
    await applyLedgerReversal(db as any, k.cfg, { bookingIntentId: 'bi_1', payeeId: 'R', totalReversedUsdCents: 120 });
    expect(k.adjustments(db)).toHaveLength(1);
    expect(k.adjustments(db)[0]).toMatchObject({ amountUsdCents: 120, state: 'OPEN' });

    await k.settle(db, { transfer, at: at(MIN) });
    expect(transfer.mock.calls[1][0].amountUsdDollars).toBe(3);
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', netPaidUsdCents: 300 });
  });

  it('a crash AFTER the money moved (the receipt cannot be written) leaves SENDING; an hour-fresh SENDING is left alone', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1' })] });
    const delegate = k.entryDelegate(db);
    const real = delegate.updateMany;
    delegate.updateMany = async (args: any) => {
      if (args.data.state === 'SETTLED') throw new Error('connection reset');
      return real(args);
    };
    const transfer = okTransfer();

    const first = await k.settle(db, { transfer });
    expect(first.failed).toBe(1);
    expect(k.rows(db)[0].state).toBe('SENDING');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('TRANSFER SENT BUT NOT RECORDED'), expect.stringContaining('tr_1'));

    delegate.updateMany = real;
    await k.settle(db, { transfer, at: at(STALE_SENDING_AFTER_MS - 1) });
    expect(transfer).toHaveBeenCalledTimes(1); // still inside the recovery window: not touched
    expect(k.rows(db)[0].state).toBe('SENDING');
  });

  it('...and once stale it is recovered by LOOKUP: SETTLED with the real transfer id, nothing re-sent', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1' })] });
    const delegate = k.entryDelegate(db);
    const real = delegate.updateMany;
    delegate.updateMany = async (args: any) => {
      if (args.data.state === 'SETTLED') throw new Error('connection reset');
      return real(args);
    };
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    delegate.updateMany = real;

    const lookup = vi.fn<LookupFn>(async () => ({ transferId: 'tr_1', amountUsdDollars: 3 }));
    const summary = await k.settle(db, { transfer, lookup, at: at(STALE_SENDING_AFTER_MS) });
    expect(summary).toMatchObject({ settled: 1, recovered: 1 });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'tr_1', netPaidUsdCents: 300 });
  });

  it('a stale SENDING row that Whop has no transfer for is re-sent with the SAME key and amount', async () => {
    enable();
    const db = makeDb(k, {
      entries: [k.entry({ id: 'led_1', state: 'SENDING', transferUsdCents: 300, transferAttempts: 1, lastAttemptAt: NOW })],
    });
    const transfer = okTransfer();
    const summary = await k.settle(db, { transfer, lookup: noLookup, at: at(STALE_SENDING_AFTER_MS) });
    expect(summary.settled).toBe(1);
    expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ amountUsdDollars: 3, idempotenceKey: 'led_1' }));
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', transferAttempts: 2 });
  });

  it('a found transfer whose amount differs from the claim is recorded as found, loudly', async () => {
    enable();
    const db = makeDb(k, {
      entries: [k.entry({ id: 'led_1', state: 'SENDING', transferUsdCents: 300, transferAttempts: 1, lastAttemptAt: NOW })],
    });
    const lookup = vi.fn<LookupFn>(async () => ({ transferId: 'tr_odd', amountUsdDollars: 2.5 }));
    await k.settle(db, { transfer: okTransfer(), lookup, at: at(STALE_SENDING_AFTER_MS) });
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'tr_odd', netPaidUsdCents: 250 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('FOUND TRANSFER DIFFERS'), expect.stringContaining('tr_odd'));
  });

  it('a malformed amount is parked before any claim; nothing is sent', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ [k.cfg.shareKey]: 2_500_001, grossUsdCents: 99_999_999 })] });
    const transfer = okTransfer();
    const summary = await k.settle(db, { transfer });
    expect(summary).toMatchObject({ parked: 1, failed: 1 });
    expect(transfer).not.toHaveBeenCalled();
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, transferUsdCents: null });
    expect(k.rows(db)[0].lastError).toMatch(/^PARKED: .*ceiling/);
  });

  it('one row failing does not stop the batch: the others are still paid', async () => {
    enable();
    const db = makeDb(k, {
      entries: [k.entry({ id: 'a' }), k.entry({ id: 'b', bookingIntentId: 'bi_2' }), k.entry({ id: 'c', bookingIntentId: 'bi_3' })],
    });
    const transfer = vi
      .fn()
      .mockResolvedValueOnce({ transferId: 'tr_a' })
      .mockRejectedValueOnce(new Error('Whop /transfers failed (402): insufficient available balance'))
      .mockResolvedValueOnce({ transferId: 'tr_c' });
    const summary = await k.settle(db, { transfer });
    expect(summary).toMatchObject({ settled: 2, failed: 1 });
    expect(k.rows(db).map((r) => r.state)).toEqual(['SETTLED', k.waiting, 'SETTLED']);
  });
});

describe.each(KINDS)('$name ledger: two runs at once pay once', (k) => {
  it('both runs read the row, exactly one wins the guarded claim, one transfer is made', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const transfer = vi.fn(async () => {
      await gate; // hold the winner mid-flight so the loser runs entirely inside the window
      return { transferId: 'tr_race' };
    });

    const a = k.settle(db, { transfer });
    const b = k.settle(db, { transfer });
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [sa, sb] = await Promise.all([a, b]);

    expect(transfer).toHaveBeenCalledTimes(1);
    expect(sa.settled + sb.settled).toBe(1);
    expect(sa.skipped + sb.skipped).toBe(1);
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'tr_race' });
  });

  it('the payment-webhook trigger and the cron backstop on the SAME row: one transfer', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    const transfer = okTransfer();
    const only = { bookingIntentId: 'bi_1', [k.cfg.kind === 'affiliate' ? 'recruiterPractitionerId' : 'referrerPractitionerId']: 'R' };
    await Promise.all([
      k.settle(db, { transfer, only }),
      k.settle(db, { transfer }),
      k.settle(db, { transfer }),
      k.settle(db, { transfer, only }),
    ]);
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(k.rows(db)[0].state).toBe('SETTLED');
  });

  it('five concurrent runs over several rows pay each row exactly once', async () => {
    enable();
    const db = makeDb(k, { entries: [0, 1, 2].map((i) => k.entry({ id: `e${i}`, bookingIntentId: `bi_${i}` })) });
    const transfer = vi.fn(async () => ({ transferId: `tr_${Math.random()}` }));
    await Promise.all([1, 2, 3, 4, 5].map(() => k.settle(db, { transfer })));
    expect(transfer).toHaveBeenCalledTimes(3);
    expect(k.rows(db).every((r) => r.state === 'SETTLED')).toBe(true);
  });

  it('two runs racing to RECLAIM the same failed row send once', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    const bad = vi.fn().mockRejectedValue(new Error('fetch failed'));
    await k.settle(db, { transfer: bad });
    const transfer = okTransfer();
    await Promise.all([k.settle(db, { transfer, at: at(MIN) }), k.settle(db, { transfer, at: at(MIN) })]);
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(k.rows(db)[0].state).toBe('SETTLED');
  });
});

describe.each(KINDS)('$name ledger: stale guards (every compare-and-swap names what it read)', (k) => {
  it('a run that read the row as FRESH cannot claim it after another run claimed it and FAILED (state is waiting again, but the amount is fixed)', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1' })] });
    const delegate = k.entryDelegate(db);
    const realFind = delegate.findMany;
    let injected = false;
    const bad = vi.fn().mockRejectedValue(new Error('fetch failed'));
    delegate.findMany = async (args: any) => {
      const out = await realFind(args);
      if (!injected) {
        injected = true;
        await k.settle(db, { transfer: bad }); // claims, fails ambiguously, releases to waiting with the amount pinned
      }
      return out;
    };
    const transfer = okTransfer();

    const second = await k.settle(db, { transfer });

    expect(second.skipped).toBe(1); // the stale claim MISSED
    expect(transfer).not.toHaveBeenCalled(); // no unchecked re-send
    expect(bad).toHaveBeenCalledTimes(1);
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, transferUsdCents: 300, transferAttempts: 1 });
  });

  it('two runs racing to reclaim the same STALE SENDING row send once (the attempt count is the token)', async () => {
    enable();
    const db = makeDb(k, {
      entries: [k.entry({ id: 'led_1', state: 'SENDING', transferUsdCents: 300, transferAttempts: 1, lastAttemptAt: NOW })],
    });
    const transfer = okTransfer();
    await Promise.all([
      k.settle(db, { transfer, at: at(STALE_SENDING_AFTER_MS) }),
      k.settle(db, { transfer, at: at(STALE_SENDING_AFTER_MS) }),
      k.settle(db, { transfer, at: at(STALE_SENDING_AFTER_MS) }),
    ]);
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', transferAttempts: 2 });
  });

  it('a late failure of a slow attempt cannot undo a row another run already SETTLED', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1' })] });
    let fail!: () => void;
    const gate = new Promise<void>((_, rej) => (fail = () => rej(new Error('fetch failed'))));
    let onWire!: () => void;
    const reached = new Promise<void>((r) => (onWire = r));
    const slow = vi.fn(async () => {
      onWire();
      await gate;
      return { transferId: 'never' };
    });
    const run = k.settle(db, { transfer: slow });
    await reached;
    Object.assign(k.rows(db)[0], { state: 'SETTLED', settledAt: NOW, whopTransferId: 'tr_other_run' }); // another run found the transfer and settled it
    fail();
    await run;
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'tr_other_run', lastError: null });
  });

  it('the allowlist is enforced in code as well as in the query', async () => {
    enable();
    process.env.WHOP_TRANSFERS_ALLOWLIST = 'X';
    const db = makeDb(k, { entries: [k.entry()] });
    const delegate = k.entryDelegate(db);
    const realFind = delegate.findMany;
    delegate.findMany = async (args: any) => {
      const where = { ...args.where };
      delete where[k.payee]; // a query that forgot the filter
      return realFind({ ...args, where });
    };
    const transfer = okTransfer();
    const summary = await k.settle(db, { transfer });
    expect(transfer).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, transferUsdCents: null });
  });

  it('a refund that read the row as unclaimed cannot win after a claim that FAILED put the row back to waiting: it books a debit', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1' })] });
    const { applyLedgerReversal } = await import('@/lib/ledger-reversal');
    const delegate = k.entryDelegate(db);
    const realFindUnique = delegate.findUnique;
    let injected = false;
    delegate.findUnique = async (args: any) => {
      const row = await realFindUnique(args);
      if (!injected) {
        injected = true;
        await k.settle(db, { transfer: vi.fn().mockRejectedValue(new Error('fetch failed')) });
      }
      return row;
    };
    await applyLedgerReversal(db as any, k.cfg, { bookingIntentId: 'bi_1', payeeId: 'R', totalReversedUsdCents: 120 });

    // The row is waiting again with the same state and refund total it had when read, but a transfer is now fixed for it.
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, transferUsdCents: 300, reversedUsdCents: 120 });
    expect(k.adjustments(db)).toHaveLength(1);
    expect(k.adjustments(db)[0].amountUsdCents).toBe(120);
    const transfer = okTransfer();
    await k.settle(db, { transfer, at: at(MIN) });
    expect(transfer.mock.calls[0][0].amountUsdDollars).toBe(3); // the fixed amount; the refund is the debit
  });
});

describe.each(KINDS)('$name ledger: refunds that cross the claim', (k) => {
  const reverse = async (db: any, total: number) => {
    const { applyLedgerReversal } = await import('@/lib/ledger-reversal');
    return applyLedgerReversal(db, k.cfg, { bookingIntentId: 'bi_1', payeeId: 'R', totalReversedUsdCents: total });
  };

  it('refund BEFORE the claim: the share is reduced, no debit, and the transfer is smaller', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    const out = await reverse(db, 120);
    expect(out.debitRecordedUsdCents).toBe(0);
    expect(k.adjustments(db)).toHaveLength(0);

    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(transfer.mock.calls[0][0].amountUsdDollars).toBe(1.8);
    expect(k.rows(db)[0]).toMatchObject({ grossShareUsdCents: 180, netPaidUsdCents: 180 });
  });

  it('refund BEFORE the claim that reverses the whole share: REVERSED, nothing is ever sent', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    await reverse(db, 300);
    expect(k.rows(db)[0].state).toBe('REVERSED');
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(transfer).not.toHaveBeenCalled();
  });

  it('refund lands between the sweep reading the row and claiming it: the claim MISSES; the next run sends the reduced amount', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    const delegate = k.entryDelegate(db);
    const realFind = delegate.findMany;
    let injected = false;
    delegate.findMany = async (args: any) => {
      const out = await realFind(args);
      if (!injected) {
        injected = true;
        await reverse(db, 120);
      }
      return out;
    };
    const transfer = okTransfer();

    const first = await k.settle(db, { transfer });
    expect(first.settled).toBe(0);
    expect(first.skipped).toBe(1);
    expect(transfer).not.toHaveBeenCalled();
    expect(k.adjustments(db)).toHaveLength(0);

    await k.settle(db, { transfer });
    expect(transfer.mock.calls[0][0].amountUsdDollars).toBe(1.8);
    expect(k.adjustments(db)).toHaveLength(0);
  });

  it('refund while SENDING: the debit is booked IMMEDIATELY (no waiting for the confirmation) and the in-flight amount is untouched', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    let reached!: () => void;
    const onWire = new Promise<void>((r) => (reached = r));
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const transfer = vi.fn(async () => {
      reached();
      await gate;
      return { transferId: 'tr_1' };
    });

    const run = k.settle(db, { transfer });
    await onWire;
    expect(k.rows(db)[0].state).toBe('SENDING');
    await reverse(db, 120);
    expect(k.adjustments(db)).toHaveLength(1);
    expect(k.adjustments(db)[0]).toMatchObject({ amountUsdCents: 120, appliedUsdCents: 0, state: 'OPEN', dedupeKey: `${k.cfg.dedupePrefix}:${k.rows(db)[0].id}:120` });
    finish();
    await run;
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', netPaidUsdCents: 300 });
    expect(k.adjustments(db)).toHaveLength(1); // not booked a second time at the receipt
  });

  it('SENDING then the transfer is REFUSED, then a refund: one debit, and the retry still sends the claimed amount (charged ONCE)', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    const transfer = vi
      .fn()
      .mockRejectedValueOnce(new Error('Whop /transfers failed (402): insufficient available balance'))
      .mockResolvedValue({ transferId: 'tr_ok' });
    await k.settle(db, { transfer });
    await reverse(db, 120);
    await k.settle(db, { transfer, at: at(MIN) });
    expect(transfer.mock.calls[1][0].amountUsdDollars).toBe(3);
    expect(k.adjustments(db)).toHaveLength(1);
    expect(k.adjustments(db)[0].amountUsdCents).toBe(120);
  });

  it('refund AFTER the receipt: a debit for exactly that refund; a redelivery of it adds nothing', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    await k.settle(db, { transfer: okTransfer() });
    await reverse(db, 120);
    await reverse(db, 120);
    expect(k.adjustments(db)).toHaveLength(1);
    expect(k.adjustments(db)[0]).toMatchObject({ amountUsdCents: 120, state: 'OPEN' });
    await reverse(db, 200); // a second refund: only the increase is debited
    expect(k.adjustments(db).map((a) => a.amountUsdCents)).toEqual([120, 80]);
  });

  it('the refund read the row as waiting, then the whole transfer lands before its swap: the swap MISSES, re-reads, and books the debit', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    const delegate = k.entryDelegate(db);
    const realFindUnique = delegate.findUnique;
    let paid = false;
    delegate.findUnique = async (args: any) => {
      const row = await realFindUnique(args);
      if (!paid) {
        paid = true;
        await k.settle(db, { transfer: okTransfer() }); // settles the row between the read and the swap
      }
      return row;
    };
    const out = await reverse(db, 120);
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', reversedUsdCents: 120 });
    expect(k.adjustments(db)).toHaveLength(1);
    expect(out.debitRecordedUsdCents).toBe(120);
  });

  it('a refund racing a settle, in either task order, never both shrinks the claim AND debits the same cents', async () => {
    enable();
    for (const order of ['refund-first', 'settle-first'] as const) {
      const db = makeDb(k, { entries: [k.entry()] });
      const transfer = okTransfer();
      const tasks =
        order === 'refund-first'
          ? [reverse(db, 120), k.settle(db, { transfer })]
          : [k.settle(db, { transfer }), reverse(db, 120)];
      await Promise.all(tasks);
      await k.settle(db, { transfer }); // a follow-up run settles anything the race skipped
      const sent = transfer.mock.calls.reduce((s, c) => s + Math.round(c[0].amountUsdDollars * 100), 0);
      const debits = k.adjustments(db).reduce((s, a) => s + a.amountUsdCents, 0);
      // The payee ends with exactly share - refund in value: sent + still-owed-back = 300 - 120 + ... conservation:
      expect(sent - debits).toBe(180);
    }
  });
});

describe.each(KINDS)('$name ledger: netting open debits against the next transfer', (k) => {
  it('SELF-AUDIT: $10 session, share $0.30 sent in full; $4 refund -> $0.12 debit; the next $0.30 share is netted to $0.18', async () => {
    enable();
    const session = (over: Record<string, any> = {}) => k.entry({ grossUsdCents: 1_000, [k.cfg.shareKey]: 30, ...over });
    const db = makeDb(k, { entries: [session({ id: 'led_1' })] });
    const transfer = okTransfer();

    await k.settle(db, { transfer });
    expect(transfer.mock.calls[0][0].amountUsdDollars).toBe(0.3);
    expect(k.rows(db)[0]).toMatchObject({ grossShareUsdCents: 30, netPaidUsdCents: 30, transferFeeUsdCents: null });

    const { applyLedgerReversal } = await import('@/lib/ledger-reversal');
    await applyLedgerReversal(db as any, k.cfg, { bookingIntentId: 'bi_1', payeeId: 'R', totalReversedUsdCents: 12 });
    expect(k.adjustments(db)).toHaveLength(1);
    expect(k.adjustments(db)[0]).toMatchObject({ amountUsdCents: 12, state: 'OPEN' });
    expect(transfer).toHaveBeenCalledTimes(1); // nothing was pulled back

    await k.entryDelegate(db).upsert({
      where: { [k.cfg.uniqueKey]: { bookingIntentId: 'bi_2', [k.payee]: 'R' } },
      create: session({ id: 'led_2', bookingIntentId: 'bi_2' }),
      update: {},
    });
    await k.settle(db, { transfer });

    expect(transfer).toHaveBeenCalledTimes(2);
    expect(transfer.mock.calls[1][0].amountUsdDollars).toBe(0.18);
    expect(k.rows(db).find((r) => r.id === 'led_2')).toMatchObject({
      state: 'SETTLED',
      grossShareUsdCents: 30,
      adjustmentAppliedUsdCents: 12,
      transferUsdCents: 18,
      netPaidUsdCents: 18,
    });
    expect(k.adjustments(db)[0]).toMatchObject({ appliedUsdCents: 12, state: 'APPLIED' });
  });

  it('a debit SMALLER than the share: the remainder is sent and the debit is APPLIED', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()], adjustments: [k.debit(120)] });
    const transfer = okTransfer();
    const summary = await k.settle(db, { transfer });
    expect(transfer.mock.calls[0][0].amountUsdDollars).toBe(1.8);
    expect(k.adjustments(db)[0]).toMatchObject({ appliedUsdCents: 120, state: 'APPLIED' });
    expect(summary).toMatchObject({ settled: 1, netted: 1, debitAppliedUsdCents: 120 });
  });

  it('a debit LARGER than the share: swallowed whole, NO transfer, and the rest carries to the next row', async () => {
    enable();
    const db = makeDb(k, {
      entries: [k.entry({ id: 'r1' }), k.entry({ id: 'r2', bookingIntentId: 'bi_2' })],
      adjustments: [k.debit(500)],
    });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(k.rows(db)[0]).toMatchObject({
      state: 'SETTLED',
      grossShareUsdCents: 300,
      adjustmentAppliedUsdCents: 300,
      transferUsdCents: 0,
      netPaidUsdCents: 0,
      whopTransferId: null,
    });
    expect(k.rows(db)[1]).toMatchObject({ state: 'SETTLED', adjustmentAppliedUsdCents: 200, netPaidUsdCents: 100 });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer.mock.calls[0][0].amountUsdDollars).toBe(1);
    expect(k.adjustments(db)[0]).toMatchObject({ appliedUsdCents: 500, state: 'APPLIED' });
  });

  it('a debit that outlasts the only share stays OPEN with its remainder; nothing is ever sent negative', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()], adjustments: [k.debit(1_000)] });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(transfer).not.toHaveBeenCalled();
    expect(k.adjustments(db)[0]).toMatchObject({ appliedUsdCents: 300, state: 'OPEN' });
  });

  it('applies debits OLDEST FIRST', async () => {
    enable();
    const db = makeDb(k, {
      entries: [k.entry({ [k.cfg.shareKey]: 150 })],
      adjustments: [k.debit(100, { id: 'd_old' }), k.debit(100, { id: 'd_new' })],
    });
    await k.settle(db, { transfer: okTransfer() });
    expect(k.adjustments(db).find((a) => a.id === 'd_old')).toMatchObject({ appliedUsdCents: 100, state: 'APPLIED' });
    expect(k.adjustments(db).find((a) => a.id === 'd_new')).toMatchObject({ appliedUsdCents: 50, state: 'OPEN' });
  });

  it('only the payee’s OWN open debits are netted', async () => {
    enable();
    const db = makeDb(k, {
      entries: [k.entry()],
      adjustments: [k.debit(100, { [k.payee]: 'S' }), k.debit(50, { state: 'APPLIED', appliedUsdCents: 50 })],
    });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(transfer.mock.calls[0][0].amountUsdDollars).toBe(3);
    expect(k.adjustments(db).map((a) => a.appliedUsdCents)).toEqual([0, 50]);
  });

  it('INTERLEAVED: A reads the open debit and pauses, B nets it first; A’s swap misses, its claim ROLLS BACK, and it retries without the debit', async () => {
    enable();
    const db = makeDb(k, {
      entries: [k.entry({ bookingIntentId: 'bi_1' }), k.entry({ bookingIntentId: 'bi_2' })],
      adjustments: [k.debit(120)],
    });
    const transfer = okTransfer();
    const onlyFor = (id: string) => ({ bookingIntentId: id, [k.payee]: 'R' });

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

    const a = k.settle(db, { transfer, only: onlyFor('bi_1') });
    await atRead;
    await k.settle(db, { transfer, only: onlyFor('bi_2') });
    expect(k.adjustments(db)[0]).toMatchObject({ appliedUsdCents: 120, state: 'APPLIED' });
    release();
    await a;

    const sent = transfer.mock.calls.map((c) => Math.round(c[0].amountUsdDollars * 100)).sort((x, y) => x - y);
    expect(sent).toEqual([180, 300]);
    expect(k.rows(db).find((r) => r.bookingIntentId === 'bi_1')).toMatchObject({ state: 'SETTLED', netPaidUsdCents: 300 });
    expect(k.adjustments(db)[0].appliedUsdCents).toBe(120); // applied ONCE
  });

  it('the rollback really un-claims: a conflicting swap leaves no SENDING row and no half-applied debit', async () => {
    enable();
    const db = makeDb(k, {
      entries: [k.entry()],
      adjustments: [k.debit(100, { id: 'd1' }), k.debit(100, { id: 'd2' })],
    });
    const delegate = k.adjustmentDelegate(db);
    const real = delegate.updateMany;
    delegate.updateMany = async (args: any) => (args.where.id === 'd2' ? { count: 0 } : real(args));
    const transfer = okTransfer();

    const summary = await k.settle(db, { transfer });

    expect(transfer).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, transferUsdCents: null, adjustmentAppliedUsdCents: null, transferAttempts: 0 });
    expect(k.adjustments(db).map((a) => a.appliedUsdCents)).toEqual([0, 0]);
  });

  it('a transfer that FAILS after netting keeps the netting: the retry sends the same net once and applies nothing twice', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()], adjustments: [k.debit(120)] });
    const transfer = vi.fn().mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue({ transferId: 'tr_ok' });
    await k.settle(db, { transfer });
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, adjustmentAppliedUsdCents: 120, transferUsdCents: 180 });
    expect(k.adjustments(db)[0]).toMatchObject({ appliedUsdCents: 120, state: 'APPLIED' });
    await k.settle(db, { transfer, at: at(MIN) });
    expect(transfer.mock.calls[1][0].amountUsdDollars).toBe(1.8);
    expect(k.adjustments(db)[0].appliedUsdCents).toBe(120);
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', netPaidUsdCents: 180 });
  });

  it('conservation over 200 random scenarios: sent + applied = shares, applied <= debits, payouts > 0', async () => {
    enable();
    let seed = 20_261_015;
    const rand = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    for (let n = 0; n < 200; n += 1) {
      const shares = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => 1 + Math.floor(rand() * 900));
      const debits = Array.from({ length: Math.floor(rand() * 4) }, () => 1 + Math.floor(rand() * 1_200));
      const db = makeDb(k, {
        entries: shares.map((s, i) => k.entry({ bookingIntentId: `bi_${i}`, [k.cfg.shareKey]: s })),
        adjustments: debits.map((d) => k.debit(d)),
      });
      const transfer = okTransfer();
      await k.settle(db, { transfer });
      const sent = transfer.mock.calls.reduce((sum, c) => sum + Math.round(c[0].amountUsdDollars * 100), 0);
      const appliedOnRows = k.rows(db).reduce((sum, r) => sum + (r.adjustmentAppliedUsdCents ?? 0), 0);
      const appliedOnDebits = k.adjustments(db).reduce((sum, a) => sum + a.appliedUsdCents, 0);
      const totalShares = shares.reduce((a, b) => a + b, 0);
      const totalDebits = debits.reduce((a, b) => a + b, 0);
      expect(appliedOnRows).toBe(appliedOnDebits);
      expect(appliedOnDebits).toBe(Math.min(totalShares, totalDebits));
      expect(sent + appliedOnRows).toBe(totalShares);
      for (const c of transfer.mock.calls) expect(c[0].amountUsdDollars).toBeGreaterThan(0);
    }
  });
});

describe.each(KINDS)('$name ledger: WHOP_TRANSFERS_ALLOWLIST', (k) => {
  it('unset: behaviour is unchanged, every payable payee is paid', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'a' }), k.entry({ id: 'b', bookingIntentId: 'bi_2', [k.payee]: 'S' })] });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(transfer).toHaveBeenCalledTimes(2);
  });

  it('set: ONLY the listed payees are ever transferred to; the others stay waiting and are not touched', async () => {
    enable();
    process.env.WHOP_TRANSFERS_ALLOWLIST = 'R, X';
    const db = makeDb(k, { entries: [k.entry({ id: 'a' }), k.entry({ id: 'b', bookingIntentId: 'bi_2', [k.payee]: 'S' })] });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    await k.settle(db, { transfer, at: at(60 * MIN) });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer.mock.calls[0][0].destinationId).toBe('biz_R');
    expect(k.rows(db).find((r) => r.id === 'b')).toMatchObject({ state: k.waiting, transferUsdCents: null, transferAttempts: 0 });
  });

  it('set to a value that names nobody: nobody is paid', async () => {
    enable();
    process.env.WHOP_TRANSFERS_ALLOWLIST = ' , ';
    const db = makeDb(k, { entries: [k.entry()] });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(transfer).not.toHaveBeenCalled();
    expect(k.rows(db)[0].state).toBe(k.waiting);
  });

  it('applies to the immediate trigger too, and a debit owed by a payee outside the list is not netted', async () => {
    enable();
    process.env.WHOP_TRANSFERS_ALLOWLIST = 'R';
    const db = makeDb(k, { entries: [k.entry({ [k.payee]: 'S' })], adjustments: [k.debit(100, { [k.payee]: 'S' })] });
    const transfer = okTransfer();
    const out = await settleLedgerEntryBestEffort(db as any, k.cfg, { bookingIntentId: 'bi_1', payeeId: 'S' }, { transfer, lookup: noLookup, at: NOW });
    expect(out).toMatchObject({ matched: 0 });
    expect(transfer).not.toHaveBeenCalled();
    expect(k.adjustments(db)[0].appliedUsdCents).toBe(0);
  });
});

describe.each(KINDS)('$name ledger: the best-effort trigger', (k) => {
  const only = { bookingIntentId: 'bi_1', payeeId: 'R' };

  it('settles ONLY the named row, leaving other eligible rows to the cron', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry(), k.entry({ id: 'other', bookingIntentId: 'bi_b' })] });
    const transfer = okTransfer();
    const summary = await settleLedgerEntryBestEffort(db as any, k.cfg, only, { transfer, lookup: noLookup, at: NOW });
    expect(summary).toMatchObject({ matched: 1, settled: 1 });
    expect(k.rows(db).find((r) => r.id === 'other')!.state).toBe(k.waiting);
  });

  it('flag not exactly "true": zero reads, zero writes, zero calls, returns null', async () => {
    process.env.WHOP_TRANSFERS_ENABLED = 'TRUE';
    const db = makeDb(k, { entries: [k.entry()] });
    const spies = [vi.spyOn(k.entryDelegate(db), 'findMany'), vi.spyOn(k.entryDelegate(db), 'updateMany'), vi.spyOn(db, '$transaction')];
    const transfer = okTransfer();
    expect(await settleLedgerEntryBestEffort(db as any, k.cfg, only, { transfer, lookup: noLookup })).toBeNull();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });

  it('NEVER throws: a database failure is logged loudly with the row ids, and returns null', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    k.entryDelegate(db).findMany = async () => {
      throw new Error('connection refused');
    };
    const out = await settleLedgerEntryBestEffort(db as any, k.cfg, only, { transfer: okTransfer(), lookup: noLookup, at: NOW });
    expect(out).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('IMMEDIATE SETTLE THREW'), expect.stringContaining('bi_1'));
  });

  it('NEVER rejects when the transfer blows up: the row goes back to waiting and the failure is logged', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    const transfer = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const out = await settleLedgerEntryBestEffort(db as any, k.cfg, only, { transfer, lookup: noLookup, at: NOW });
    expect(out).toMatchObject({ failed: 1, retrying: 1 });
    expect(k.rows(db)[0].state).toBe(k.waiting);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('IMMEDIATE SETTLE FAILED'), expect.any(String));
  });

  it('a configuration block (flag on, Whop unconfigured) is logged loudly, not swallowed', async () => {
    process.env.WHOP_TRANSFERS_ENABLED = 'true';
    const db = makeDb(k, { entries: [k.entry()] });
    const out = await settleLedgerEntryBestEffort(db as any, k.cfg, only, { transfer: okTransfer(), lookup: noLookup, at: NOW });
    expect(out?.blocked).toMatch(/not configured/i);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('IMMEDIATE SETTLE BLOCKED'), expect.any(String));
  });
});

describe('the affiliate ledger only: "while both are active"', () => {
  const k = KINDS[0];

  it('an ARCHIVED recruiter stays ACCRUED, unsent; reinstated, the same row pays', async () => {
    enable();
    const w: any = { R: { ...VERIFIED, archivedAt: new Date(Date.UTC(2026, 11, 15)) } };
    const db = makeDb(k, { practitioners: w, entries: [k.entry()] });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(transfer).not.toHaveBeenCalled();
    expect(k.rows(db)[0].state).toBe('ACCRUED');
    w.R = { ...VERIFIED, archivedAt: null };
    await k.settle(db, { transfer });
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it('a RETIRED recruiter (trial backdated to the epoch sentinel) is not paid either', async () => {
    enable();
    const w: any = { R: { ...VERIFIED, archivedAt: null, trialEndsAt: new Date('1971-01-01T00:00:00.000Z') } };
    const db = makeDb(k, { practitioners: w, entries: [k.entry()] });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(transfer).not.toHaveBeenCalled();
    expect(k.rows(db)[0].state).toBe('ACCRUED');
  });

  it('the activity predicate is in the QUERY, so inactive rows cannot fill the batch either', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry()] });
    const find = vi.spyOn(k.entryDelegate(db), 'findMany');
    await k.settle(db);
    const where = (find.mock.calls[0] as any)[0].where;
    expect(where.recruiterPractitioner).toMatchObject({ archivedAt: null });
    expect(where.state).toBe('ACCRUED');
  });
});

describe('the referral ledger only: the unclaimed-share window is kept', () => {
  const k = KINDS[1];

  it('a HELD share (its referrer cannot receive money yet) is never sent; once the referrer is payable the sweep promotes and then pays it', async () => {
    enable();
    const w = { R: { whopCompanyId: null as string | null, whopPayoutsEnabled: false } };
    const db = makeDb(k, {
      practitioners: w,
      entries: [k.entry({ state: 'HELD', holdCreatedAt: NOW, holdExpiresAt: at(90 * 24 * 60 * MIN) })],
    });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(transfer).not.toHaveBeenCalled();
    expect(k.rows(db)[0].state).toBe('HELD');

    w.R = { whopCompanyId: 'biz_R', whopPayoutsEnabled: true };
    await k.settle(db, { transfer });
    expect(transfer).not.toHaveBeenCalled(); // still HELD until promoted

    const { promoteHeldToPayable } = await import('@/lib/referral-payouts');
    const promoted = await promoteHeldToPayable({
      referralLedgerEntry: db.referralLedgerEntry,
      practitioner: { findMany: async () => [{ id: 'R', ...w.R }] },
    } as any);
    expect(promoted).toBe(1);
    await k.settle(db, { transfer });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(k.rows(db)[0].state).toBe('SETTLED');
  });

  it('EXPIRED_UNCLAIMED rows are never swept into a payment', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ state: 'EXPIRED_UNCLAIMED' })] });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(transfer).not.toHaveBeenCalled();
  });

  it('a settled referral share leaves its append-only fee-ledger receipt', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1' })] });
    await k.settle(db);
    expect(db.fees).toHaveLength(1);
    expect(db.fees[0]).toMatchObject({
      dedupeKey: 'REFERRER_TRANSFER:led_1',
      kind: 'REFERRER_TRANSFER',
      status: 'SETTLED',
      amountUsdCents: 300,
      whopTransferId: 'tr_1',
    });
  });

  it('a failed fee-ledger receipt write does not undo or hide the settled transfer', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1' })] });
    db.feeLedgerEntry.upsert = async () => {
      throw new Error('fee ledger down');
    };
    const summary = await k.settle(db);
    expect(summary.settled).toBe(1);
    expect(k.rows(db)[0].state).toBe('SETTLED');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('FEE LEDGER RECEIPT NOT WRITTEN'), expect.any(String));
  });
});

describe('findUnconfirmedTransfers: a share with no receipt is an alert', () => {
  const old = new Date(NOW.getTime() - UNCONFIRMED_AFTER_MS - 1);
  const fresh = new Date(NOW.getTime() - 60_000);

  const world = () =>
    fakeLedgerDb({
      practitioners: wallets,
      affiliate: {
        entries: [
          { id: 'a_old_waiting', bookingIntentId: 'b1', recruiterPractitionerId: 'R', shareUsdCents: 300, state: 'ACCRUED', createdAt: old },
          { id: 'a_fresh_waiting', bookingIntentId: 'b2', recruiterPractitionerId: 'R', shareUsdCents: 300, state: 'ACCRUED', createdAt: fresh },
          { id: 'a_old_unpayable', bookingIntentId: 'b3', recruiterPractitionerId: 'U', shareUsdCents: 300, state: 'ACCRUED', createdAt: old },
          { id: 'a_old_sending', bookingIntentId: 'b4', recruiterPractitionerId: 'U', shareUsdCents: 300, state: 'SENDING', transferUsdCents: 300, createdAt: old },
          { id: 'a_old_settled', bookingIntentId: 'b5', recruiterPractitionerId: 'R', shareUsdCents: 300, state: 'SETTLED', settledAt: NOW, createdAt: old },
        ],
      },
      referral: {
        entries: [
          { id: 'r_old_payable', bookingIntentId: 'b6', referrerPractitionerId: 'S', referrerShareUsdCents: 500, state: 'PAYABLE', transferAttempts: 2, lastError: 'fetch failed', createdAt: old },
          { id: 'r_old_held', bookingIntentId: 'b7', referrerPractitionerId: 'S', referrerShareUsdCents: 500, state: 'HELD', createdAt: old },
        ],
      },
    });

  it('flag off: nothing is expected to move, so nothing is listed', async () => {
    expect(await findUnconfirmedTransfers(world() as any, { at: NOW })).toEqual([]);
  });

  it('lists SENDING and waiting-with-a-payable-payee rows older than 30 minutes, with their numbers; nothing else', async () => {
    enable();
    const out = await findUnconfirmedTransfers(world() as any, { at: NOW });
    expect(out.map((r) => r.id).sort()).toEqual(['a_old_sending', 'a_old_waiting', 'r_old_payable']);
    expect(out.find((r) => r.id === 'r_old_payable')).toMatchObject({ ledger: 'referral', amountUsdCents: 500, attempts: 2, lastError: 'fetch failed' });
    expect(out.find((r) => r.id === 'a_old_sending')).toMatchObject({ ledger: 'affiliate', state: 'SENDING', amountUsdCents: 300 });
  });

  it('respects the allowlist: a row for a payee outside it is not expected to move', async () => {
    enable();
    process.env.WHOP_TRANSFERS_ALLOWLIST = 'S';
    const out = await findUnconfirmedTransfers(world() as any, { at: NOW });
    expect(out.map((r) => r.id)).toEqual(['r_old_payable']);
  });

  it('after a successful settle there is nothing left to list; after a failed one the row is listed', async () => {
    enable();
    const w = fakeLedgerDb({ practitioners: wallets, affiliate: { entries: [{ id: 'a1', bookingIntentId: 'b1', recruiterPractitionerId: 'R', shareUsdCents: 300, createdAt: old }] } });
    await settleAffiliateShares(w as any, { transfer: vi.fn().mockRejectedValue(new Error('fetch failed')), lookup: noLookup, at: NOW });
    expect((await findUnconfirmedTransfers(w as any, { at: NOW })).map((r) => r.id)).toEqual(['a1']);
    await settleAffiliateShares(w as any, { transfer: okTransfer(), lookup: noLookup, at: at(MIN) });
    expect(await findUnconfirmedTransfers(w as any, { at: at(MIN) })).toEqual([]);
  });
});
