import { describe, expect, it, vi } from 'vitest';

import {
  PARKED_RETRY_MS,
  STALE_SENDING_AFTER_MS,
  UNCONFIRMED_AFTER_MS,
  findUnconfirmedTransfers,
  idempotenceVerified,
  type LookupFn,
} from '@/lib/ledger-transfer';
import { resolveTransferAttention } from '@/lib/transfer-attention';
import { type Entry } from './helpers/fake-ledger-db';
import { fakeWhop } from './helpers/fake-whop';
import {
  KINDS,
  MIN,
  NOW,
  VERIFIED,
  at,
  enable,
  enableUnverified,
  installTransferTestEnv,
  makeDb,
  noLookup,
  okTransfer,
  wallets,
} from './helpers/ledger-kinds';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * WHAT HAPPENS WHEN WHOP DOES NOT BEHAVE AS THE CODE WOULD LIKE, on both payout ledgers.
 *
 *   1. An attempt with an UNKNOWN outcome is never blindly re-sent. "No row matched" is not "no
 *      transfer exists" unless the list could have shown it AND the operator has recorded that the
 *      canary proved the lookup (`WHOP_TRANSFERS_LOOKUP_VERIFIED`); a proven idempotence key
 *      (`WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED`) is the other way to allow a re-send
 *      (tests/transfer-proofs.test.ts). With neither, the row waits for an admin, who records whether
 *      it went out. These tests run with the lookup flag set unless they say otherwise.
 *   2. A refund after a REFUSED attempt (nothing was created) reduces the share.
 *   3. The alert covers every row that holds money back; the sweep stops cleanly at its budget.
 */

installTransferTestEnv();

describe('the idempotence flag', () => {
  it('is exactly the string "true"', () => {
    expect(idempotenceVerified({ WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED: 'true' })).toBe(true);
    for (const v of [undefined, '', 'TRUE', 'True', '1', 'yes', 'false', ' true']) {
      expect(idempotenceVerified({ WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED: v })).toBe(false);
    }
  });
});

describe.each(KINDS)('$name ledger: an unknown outcome is never blindly re-sent', (k) => {
  const bigShare = (over: Record<string, any> = {}) => k.entry({ id: 'led_1', [k.cfg.shareKey]: 3_000, grossUsdCents: 10_000, ...over });

  it.each(['no-metadata', 'bad-envelope'] as const)(
    'key ignored, list shows %s, 502 after the transfer exists: ONE transfer and a needs-attention row, however many sweeps follow',
    async (shape) => {
      enableUnverified();
      const whop = fakeWhop({ honourKey: false, listShows: shape, afterCreate: ['bad-gateway'] });
      const db = makeDb(k, { entries: [bigShare()] });

      await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup });
      for (const later of [2 * MIN, 61 * MIN, 25 * 60 * MIN]) {
        await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup, at: at(later) });
      }

      expect(whop.transfers).toHaveLength(1); // Whop holds one transfer: $30.00 for a $30.00 share
      expect(whop.posts).toBe(1);
      expect(k.rows(db)[0]).toMatchObject({
        state: k.waiting,
        attentionReason: 'ambiguous-unverified',
        transferUsdCents: 3_000,
        settledAt: null,
      });
      expect(k.rows(db)[0].maybeSentAt).toEqual(NOW);
    },
  );

  it('the same mock with the lookup flag set and a list that cannot answer: still no second POST (the unknown lookup is retried later)', async () => {
    enable();
    const whop = fakeWhop({ honourKey: false, listShows: 'no-metadata', afterCreate: ['bad-gateway'] });
    const db = makeDb(k, { entries: [bigShare()] });
    await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup });
    for (const later of [2 * MIN, 10 * MIN, 61 * MIN, 3 * 60 * MIN]) {
      await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup, at: at(later) });
    }
    expect(whop.posts).toBe(1);
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, attentionReason: null, transferUsdCents: 3_000 });
    expect(k.rows(db)[0].maybeSentAt).not.toBeNull();
    expect(k.rows(db)[0].lastError).toMatch(/no metadata field/);
  });

  it('neither proof recorded and a lookup that says not-found (the list lags): still not re-sent; the row waits for a person', async () => {
    enableUnverified();
    const whop = fakeWhop({ honourKey: false, afterCreate: ['timeout'] });
    const db = makeDb(k, { entries: [bigShare()] });
    const lagging: LookupFn = async () => ({ kind: 'not-found' });
    await k.settle(db, { transfer: whop.transfer, lookup: lagging });
    await k.settle(db, { transfer: whop.transfer, lookup: lagging, at: at(5 * MIN) });
    expect(whop.posts).toBe(1);
    expect(k.rows(db)[0].attentionReason).toBe('ambiguous-unverified');
  });

  it('lookup flag set and a mock that honours the key (stale list): one retry with the SAME key, one transfer, settled', async () => {
    enable();
    const whop = fakeWhop({ honourKey: true, afterCreate: ['timeout'] });
    const db = makeDb(k, { entries: [bigShare()] });
    const lagging: LookupFn = async () => ({ kind: 'not-found' });

    await k.settle(db, { transfer: whop.transfer, lookup: lagging });
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, attentionReason: null, transferUsdCents: 3_000 });
    await k.settle(db, { transfer: whop.transfer, lookup: lagging, at: at(MIN) });

    expect(whop.posts).toBe(2);
    expect(whop.transfers).toHaveLength(1);
    expect(whop.transfers[0]!.key).toBe('led_1');
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'wt_1', netPaidUsdCents: 3_000 });
  });

  it('lookup flag set, key ignored but the list shows our metadata: the transfer is FOUND and never re-posted', async () => {
    enable();
    const whop = fakeWhop({ honourKey: false, listShows: 'metadata', afterCreate: ['bad-gateway'] });
    const db = makeDb(k, { entries: [bigShare()] });
    await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup });
    const out = await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup, at: at(MIN) });
    expect(out.recovered).toBe(1);
    expect(whop.posts).toBe(1);
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'wt_1' });
  });

  it('a transfer that Whop SHOWS settles a flagged row at any setting; a list that cannot answer leaves it alone', async () => {
    enableUnverified();
    const whop = fakeWhop({ honourKey: false, listShows: 'metadata', afterCreate: ['timeout'] });
    const db = makeDb(k, { entries: [bigShare()] });
    const unknown: LookupFn = async () => ({ kind: 'unknown', reason: 'x' });
    await k.settle(db, { transfer: whop.transfer, lookup: unknown });
    expect(k.rows(db)[0].attentionReason).toBe('ambiguous-unverified');
    await k.settle(db, { transfer: whop.transfer, lookup: unknown, at: at(MIN) });
    expect(k.rows(db)[0].state).toBe(k.waiting);

    const out = await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup, at: at(2 * MIN) });
    expect(out).toMatchObject({ recovered: 1, settled: 1 });
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'wt_1', attentionReason: null });
    expect(whop.posts).toBe(1);
  });

  it('a stale SENDING row (its run died) is not re-sent either while the lookup is unverified', async () => {
    enableUnverified();
    const db = makeDb(k, {
      entries: [bigShare({ state: 'SENDING', transferUsdCents: 3_000, transferAttempts: 1, lastAttemptAt: NOW })],
    });
    const transfer = okTransfer();
    await k.settle(db, { transfer, lookup: noLookup, at: at(STALE_SENDING_AFTER_MS) });
    expect(transfer).not.toHaveBeenCalled();
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, attentionReason: 'ambiguous-unverified' });
  });

  it('the FIRST send of a fresh row is unaffected by the flags', async () => {
    enableUnverified();
    const whop = fakeWhop();
    const db = makeDb(k, { entries: [bigShare()] });
    const out = await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup });
    expect(out.settled).toBe(1);
    expect(whop.posts).toBe(1);
  });

  it('definitive refusals need no verification: they are retried at any setting', async () => {
    enableUnverified();
    const db = makeDb(k, { entries: [bigShare()] });
    const transfer = vi.fn().mockRejectedValueOnce(new Error('Whop /transfers failed (402): insufficient available balance')).mockResolvedValue({ transferId: 'tr_ok' });
    await k.settle(db, { transfer, lookup: noLookup });
    expect(k.rows(db)[0].attentionReason).toBeNull();
    await k.settle(db, { transfer, lookup: noLookup, at: at(MIN) });
    expect(k.rows(db)[0].state).toBe('SETTLED');
  });
});

describe.each(KINDS)('$name ledger: a refund after a REFUSED attempt reduces the share', (k) => {
  const refusing = () =>
    vi
      .fn()
      .mockRejectedValueOnce(new Error('Whop /transfers failed (402): insufficient available balance'))
      .mockResolvedValue({ transferId: 'tr_ok' });
  const bigShare = (over: Record<string, any> = {}) => k.entry({ id: 'led_1', [k.cfg.shareKey]: 3_000, grossUsdCents: 10_000, ...over });
  const reverse = async (db: any, total: number) => {
    const { applyLedgerReversal } = await import('@/lib/ledger-reversal');
    return applyLedgerReversal(db, k.cfg, { bookingIntentId: 'bi_1', payeeId: 'R', totalReversedUsdCents: total });
  };

  it('3000c share, refused attempt, FULL refund -> REVERSED, nothing is ever sent, no debit', async () => {
    enable();
    const db = makeDb(k, { entries: [bigShare()] });
    const transfer = refusing();
    await k.settle(db, { transfer });
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, transferUsdCents: null, grossShareUsdCents: 3_000, adjustmentAppliedUsdCents: null });

    const out = await reverse(db, 3_000);
    expect(out.debitRecordedUsdCents).toBe(0);
    expect(k.rows(db)[0].state).toBe('REVERSED');
    await k.settle(db, { transfer, at: at(MIN) });
    await k.settle(db, { transfer, at: at(2 * MIN) });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(k.adjustments(db)).toHaveLength(0);
  });

  it('a PARTIAL refund after a refused attempt: the retry sends share - refund and books no debit', async () => {
    enable();
    const db = makeDb(k, { entries: [bigShare()] });
    const transfer = refusing();
    await k.settle(db, { transfer });
    await reverse(db, 1_000);
    expect(k.adjustments(db)).toHaveLength(0);
    await k.settle(db, { transfer, at: at(MIN) });
    expect(transfer.mock.calls[1][0].amountUsdDollars).toBe(20);
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', grossShareUsdCents: 2_000, netPaidUsdCents: 2_000 });
    expect(k.adjustments(db)).toHaveLength(0);
  });

  it('the same after a PARKED refusal (not verified / not allowed)', async () => {
    enable();
    const db = makeDb(k, { entries: [bigShare()] });
    const transfer = vi
      .fn()
      .mockRejectedValueOnce(new Error('Whop /transfers failed (403): Please verify your business before transferring funds'))
      .mockResolvedValue({ transferId: 'tr_ok' });
    await k.settle(db, { transfer });
    expect(k.rows(db)[0]).toMatchObject({ transferUsdCents: null, nextAttemptAt: at(PARKED_RETRY_MS) });
    await reverse(db, 1_000);
    await k.settle(db, { transfer, at: at(PARKED_RETRY_MS) });
    expect(transfer.mock.calls[1][0].amountUsdDollars).toBe(20);
    expect(k.adjustments(db)).toHaveLength(0);
  });

  it('the debits the refused claim applied are RESTORED exactly, so the retry nets them once (no loss, no double netting)', async () => {
    enable();
    const db = makeDb(k, { entries: [bigShare()], adjustments: [k.debit(500, { id: 'd1' }), k.debit(300, { id: 'd2' })] });
    const transfer = refusing();
    await k.settle(db, { transfer });
    expect(k.adjustments(db).map((a) => [a.id, a.appliedUsdCents, a.state])).toEqual([['d1', 0, 'OPEN'], ['d2', 0, 'OPEN']]);
    expect(k.rows(db)[0]).toMatchObject({ transferUsdCents: null, adjustmentAppliedUsdCents: null, adjustmentAllocations: null });

    await reverse(db, 200);
    await k.settle(db, { transfer, at: at(MIN) });
    expect(transfer.mock.calls[1][0].amountUsdDollars).toBe(20); // 3000 - 200 refund - 800 debits
    expect(k.adjustments(db).map((a) => [a.id, a.appliedUsdCents, a.state])).toEqual([['d1', 500, 'APPLIED'], ['d2', 300, 'APPLIED']]);
    expect(k.rows(db)[0]).toMatchObject({ grossShareUsdCents: 2_800, adjustmentAppliedUsdCents: 800, netPaidUsdCents: 2_000 });
  });

  it('a partly applied debit is restored to its earlier applied amount, not to zero', async () => {
    enable();
    const db = makeDb(k, { entries: [bigShare()], adjustments: [k.debit(1_000, { id: 'd1', appliedUsdCents: 400 })] });
    const transfer = refusing();
    await k.settle(db, { transfer });
    expect(k.adjustments(db)[0]).toMatchObject({ appliedUsdCents: 400, state: 'OPEN' });
  });

  it('a restore that cannot put a debit back (it moved) leaves the row claimed: the fixed amount is kept, nothing is lost', async () => {
    enable();
    const db = makeDb(k, { entries: [bigShare()], adjustments: [k.debit(500, { id: 'd1' })] });
    const real = k.adjustmentDelegate(db).updateMany;
    let failRestore = false;
    k.adjustmentDelegate(db).updateMany = async (args: any) => {
      if (failRestore && args.data.appliedUsdCents === 0) return { count: 0 };
      return real(args);
    };
    const transfer = vi.fn(async () => {
      failRestore = true;
      throw new Error('Whop /transfers failed (402): insufficient available balance');
    });
    await k.settle(db, { transfer });
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, transferUsdCents: 2_500, adjustmentAppliedUsdCents: 500 });
    expect(k.adjustments(db)[0]).toMatchObject({ appliedUsdCents: 500, state: 'APPLIED' });
  });

  it('after an unknown outcome the row keeps its fixed amount, even if a later retry is refused outright (a transfer may exist)', async () => {
    enable();
    const db = makeDb(k, { entries: [bigShare()] });
    const transfer = vi
      .fn()
      .mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
      .mockRejectedValueOnce(new Error('Whop /transfers failed (400): duplicate'))
      .mockResolvedValue({ transferId: 'tr_ok' });
    await k.settle(db, { transfer });
    await k.settle(db, { transfer, at: at(MIN) });
    expect(k.rows(db)[0]).toMatchObject({ transferUsdCents: 3_000 });
    expect(k.rows(db)[0].maybeSentAt).not.toBeNull();
    const out = await reverse(db, 1_000);
    expect(out.debitRecordedUsdCents).toBe(1_000); // a debit: the amount stays fixed
  });

  it('the share on the books is conserved over a refused attempt, a refund and a retry: sent + refunded = share', async () => {
    enable();
    for (const refund of [0, 1, 999, 1_500, 2_999, 3_000]) {
      const db = makeDb(k, { entries: [bigShare()] });
      const transfer = refusing();
      await k.settle(db, { transfer });
      if (refund > 0) await reverse(db, refund);
      await k.settle(db, { transfer, at: at(MIN) });
      const sent = transfer.mock.calls.slice(1).reduce((s, c) => s + Math.round(c[0].amountUsdDollars * 100), 0);
      expect(sent + refund).toBe(3_000);
      expect(k.adjustments(db)).toHaveLength(0);
    }
  });
});

describe.each(KINDS)('$name ledger: the admin resolves a row that waits for a person', (k) => {
  const flagged = async (over: Record<string, any> = {}, adjustments: Entry[] = []) => {
    enableUnverified();
    const whop = fakeWhop({ honourKey: false, listShows: 'no-metadata', afterCreate: ['timeout'] });
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1', ...over })], adjustments });
    await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup });
    expect(k.rows(db)[0].attentionReason).toBe('ambiguous-unverified');
    return { db, whop };
  };
  const resolve = (db: any, over: Record<string, any> = {}) =>
    resolveTransferAttention(db, {
      ledger: k.name,
      rowId: 'led_1',
      outcome: 'went-out',
      transferId: 'wt_1',
      reason: 'seen in the Whop dashboard',
      adminUserId: 'usr_admin',
      at: at(10 * MIN),
      ...over,
    });

  it('"it went out": the row is SETTLED with the id the admin recorded, nothing is sent, and the decision is audited', async () => {
    const { db, whop } = await flagged();
    expect(await resolve(db)).toEqual({ ok: true });
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'wt_1', netPaidUsdCents: 300, attentionReason: null, settledAt: at(10 * MIN) });
    const audit = db.fees.find((f: any) => f.kind === 'TRANSFER_RESOLUTION')!;
    expect(audit).toMatchObject({ status: 'SETTLED', whopTransferId: 'wt_1', amountUsdCents: 300 });
    expect(JSON.parse(audit.note)).toMatchObject({ ledger: k.name, ledgerEntryId: 'led_1', outcome: 'went-out', reason: 'seen in the Whop dashboard', adminUserId: 'usr_admin' });
    await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup, at: at(30 * MIN) });
    expect(whop.posts).toBe(1);
    if (k.name === 'referral') expect(db.fees.find((f: any) => f.kind === 'REFERRER_TRANSFER')).toMatchObject({ whopTransferId: 'wt_1' });
  });

  it('"it did not go out": the row is fresh again (fixed amount cleared, claim-applied debits restored) and the next sweep sends it ONCE', async () => {
    const { db, whop } = await flagged({}, [k.debit(120, { id: 'd1' })]);
    expect(k.rows(db)[0]).toMatchObject({ transferUsdCents: 180, adjustmentAppliedUsdCents: 120 });
    expect(k.adjustments(db)[0]).toMatchObject({ appliedUsdCents: 120, state: 'APPLIED' });

    expect(await resolve(db, { outcome: 'did-not-go-out', transferId: undefined, reason: 'checked, no transfer' })).toEqual({ ok: true });
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, transferUsdCents: null, attentionReason: null, maybeSentAt: null, nextAttemptAt: null });
    expect(k.adjustments(db)[0]).toMatchObject({ appliedUsdCents: 0, state: 'OPEN' });
    expect(JSON.parse(db.fees.find((f: any) => f.kind === 'TRANSFER_RESOLUTION')!.note)).toMatchObject({ outcome: 'did-not-go-out', reason: 'checked, no transfer' });

    const out = await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup, at: at(11 * MIN) });
    expect(out.settled).toBe(1);
    expect(whop.posts).toBe(2);
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', adjustmentAppliedUsdCents: 120, netPaidUsdCents: 180 });
  });

  it('"it did not go out" after a refund landed in flight: unflagged and retried at its fixed amount, the refund staying a single debit', async () => {
    const { db } = await flagged();
    const { applyLedgerReversal } = await import('@/lib/ledger-reversal');
    await applyLedgerReversal(db, k.cfg, { bookingIntentId: 'bi_1', payeeId: 'R', totalReversedUsdCents: 100 });
    expect(await resolve(db, { outcome: 'did-not-go-out', transferId: undefined })).toEqual({ ok: true });
    expect(k.rows(db)[0]).toMatchObject({ attentionReason: null, transferUsdCents: 300 });
    expect(k.adjustments(db)).toHaveLength(1);
  });

  it('refuses without a reason, without a plausible transfer id, for a row that is not waiting for a decision, and a second time', async () => {
    const { db } = await flagged();
    expect(await resolve(db, { reason: ' x ' })).toMatchObject({ ok: false });
    expect(await resolve(db, { transferId: '' })).toMatchObject({ ok: false, message: expect.stringMatching(/transfer id/) });
    expect(await resolve(db, { transferId: 'wt 1; drop' })).toMatchObject({ ok: false });
    expect(k.rows(db)[0].attentionReason).toBe('ambiguous-unverified'); // none of the refusals touched it
    expect(await resolve(db)).toEqual({ ok: true });
    expect(await resolve(db)).toMatchObject({ ok: false, message: expect.stringMatching(/not waiting for a decision/) });
    expect(db.fees.filter((f: any) => f.kind === 'TRANSFER_RESOLUTION')).toHaveLength(1);

    const fresh = makeDb(k, { entries: [k.entry({ id: 'led_1' })] });
    expect(await resolve(fresh)).toMatchObject({ ok: false });
    expect(k.rows(fresh)[0].state).toBe(k.waiting);
  });

  it('a decision that read the row before a different decision completed loses: the flag is part of the swap', async () => {
    const { db } = await flagged();
    const delegate = k.entryDelegate(db);
    const realFindUnique = delegate.findUnique;
    let injected = false;
    delegate.findUnique = async (args: any) => {
      const row = await realFindUnique(args);
      if (!injected) {
        injected = true;
        await resolve(db, { outcome: 'did-not-go-out', transferId: undefined, reason: 'checked, none' });
      }
      return row;
    };
    const late = await resolve(db); // "it went out", decided on a stale read
    expect(late).toMatchObject({ ok: false, message: expect.stringMatching(/changed/) });
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, whopTransferId: null, attentionReason: null });
    expect(db.fees.filter((f: any) => f.kind === 'TRANSFER_RESOLUTION')).toHaveLength(1);
  });

  it('two admins at once: one decision wins, the other is told the row changed', async () => {
    const { db } = await flagged();
    const [a, b] = await Promise.all([resolve(db), resolve(db, { outcome: 'did-not-go-out', transferId: undefined })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(db.fees.filter((f: any) => f.kind === 'TRANSFER_RESOLUTION')).toHaveLength(1);
  });
});

describe.each(KINDS)('$name ledger: the unconfirmed-row alert covers every row that holds money back', (k) => {
  const old = new Date(NOW.getTime() - UNCONFIRMED_AFTER_MS - 1);

  it('a row waiting for a person is listed AT ONCE, however young, with its reason', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1', createdAt: NOW, transferUsdCents: 300, attentionReason: 'ambiguous-unverified', lastError: 'timeout' })] });
    const out = await findUnconfirmedTransfers(db as any, { at: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ledger: k.name, id: 'led_1', reason: 'needs-attention', attentionReason: 'ambiguous-unverified', amountUsdCents: 300 });
  });

  it('a CLAIMED row whose payee can no longer receive money is listed (the transfer may exist); an UNCLAIMED one is not', async () => {
    enable();
    const w = { R: { whopCompanyId: 'biz_R', whopPayoutsEnabled: false } };
    const db = makeDb(k, {
      practitioners: w,
      entries: [
        k.entry({ id: 'claimed', bookingIntentId: 'b1', transferUsdCents: 300, transferAttempts: 1, maybeSentAt: old, createdAt: old }),
        k.entry({ id: 'unclaimed', bookingIntentId: 'b2', createdAt: old }),
      ],
    });
    const out = await findUnconfirmedTransfers(db as any, { at: NOW });
    expect(out.map((r) => [r.id, r.reason])).toEqual([['claimed', 'payee-unpayable']]);
  });
});

describe('the affiliate ledger only: an inactive recruiter’s row is listed, not hidden', () => {
  const k = KINDS[0];
  const old = new Date(NOW.getTime() - UNCONFIRMED_AFTER_MS - 1);

  it('an ARCHIVED or RETIRED recruiter with a payable wallet: listed as payee-inactive (and still not paid)', async () => {
    enable();
    const w: any = {
      R: { ...VERIFIED, archivedAt: new Date(Date.UTC(2026, 11, 15)) },
      S: { ...wallets.S, archivedAt: null, trialEndsAt: new Date('1971-01-01T00:00:00.000Z') },
    };
    const db = makeDb(k, {
      practitioners: w,
      entries: [k.entry({ id: 'a', createdAt: old }), k.entry({ id: 'b', bookingIntentId: 'bi_2', recruiterPractitionerId: 'S', createdAt: old })],
    });
    const transfer = okTransfer();
    await k.settle(db, { transfer });
    expect(transfer).not.toHaveBeenCalled();
    const out = await findUnconfirmedTransfers(db as any, { at: NOW });
    expect(out.map((r) => [r.id, r.reason])).toEqual([['a', 'payee-inactive'], ['b', 'payee-inactive']]);
  });
});

describe.each(KINDS)('$name ledger: the wall-clock budget', (k) => {
  it('processes oldest first and stops cleanly when the budget is spent, leaving the rest untouched and saying so', async () => {
    enable();
    const db = makeDb(k, {
      entries: [
        k.entry({ id: 'newer', bookingIntentId: 'b2', createdAt: new Date(Date.UTC(2026, 0, 2)) }),
        k.entry({ id: 'oldest', bookingIntentId: 'b1', createdAt: new Date(Date.UTC(2026, 0, 1)) }),
        k.entry({ id: 'newest', bookingIntentId: 'b3', createdAt: new Date(Date.UTC(2026, 0, 3)) }),
      ],
    });
    const base = Date.now();
    let reads = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (reads++ === 0 ? base : base + 1_000)); // in budget once, then out
    const transfer = okTransfer();
    const out = await k.settle(db, { transfer, deadlineMs: base + 500 });
    expect(out).toMatchObject({ budgetExhausted: true, deferred: 2, settled: 1 });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(k.rows(db).find((r) => r.id === 'oldest')!.state).toBe('SETTLED');
    expect(k.rows(db).filter((r) => r.state === k.waiting).map((r) => r.id).sort()).toEqual(['newer', 'newest']);
  });

  it('no deadline, no limit', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'a' }), k.entry({ id: 'b', bookingIntentId: 'b2' })] });
    const out = await k.settle(db, { transfer: okTransfer() });
    expect(out).toMatchObject({ budgetExhausted: false, deferred: 0, settled: 2 });
  });
});
