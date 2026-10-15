import { describe, expect, it, vi } from 'vitest';

import { findUnconfirmedTransfers, lookupVerified, type LookupFn } from '@/lib/ledger-transfer';
import { resolveTransferAttention } from '@/lib/transfer-attention';
import { type Entry } from './helpers/fake-ledger-db';
import { fakeWhop } from './helpers/fake-whop';
import {
  KINDS,
  MIN,
  NOW,
  at,
  enable,
  enableBoth,
  enableKeyHonoured,
  enableUnverified,
  installTransferTestEnv,
  makeDb,
  okTransfer,
} from './helpers/ledger-kinds';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * WHAT MAY BE BELIEVED ABOUT AN UNKNOWN OUTCOME. Two independent proofs, each set by the operator from
 * one canary result:
 *
 *   WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED  a repeated request with the same key created no second transfer
 *   WHOP_TRANSFERS_LOOKUP_VERIFIED       GET /transfers found the known canary transfer by metadata
 *
 * With neither, an attempt that ended with an unknown outcome is never re-sent, whatever the lookup says.
 */

installTransferTestEnv();

describe('the lookup flag', () => {
  it('is exactly the string "true"', () => {
    expect(lookupVerified({ WHOP_TRANSFERS_LOOKUP_VERIFIED: 'true' })).toBe(true);
    for (const v of [undefined, '', 'TRUE', 'True', '1', 'yes', 'false', ' true']) {
      expect(lookupVerified({ WHOP_TRANSFERS_LOOKUP_VERIFIED: v })).toBe(false);
    }
  });
});

const SHAPES = ['no-metadata', 'bad-envelope', 'full-page-no-cursor', 'empty', 'null-metadata'] as const;

describe.each(KINDS)('$name ledger: the key is IGNORED by Whop and the list cannot show the transfer', (k) => {
  const bigShare = (over: Record<string, any> = {}) => k.entry({ id: 'led_1', [k.cfg.shareKey]: 3_000, grossUsdCents: 10_000, ...over });
  const sweeps = [2 * MIN, 61 * MIN, 3 * 60 * MIN, 25 * 60 * MIN];

  async function run(shape: (typeof SHAPES)[number]) {
    const whop = fakeWhop({ honourKey: false, listShows: shape, afterCreate: ['bad-gateway'] });
    const db = makeDb(k, { entries: [bigShare()] });
    await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup });
    for (const later of sweeps) await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup, at: at(later) });
    return { whop, db };
  }

  it.each(SHAPES)('NEITHER flag, list shows %s: ONE transfer, the row is flagged for a person', async (shape) => {
    enableUnverified();
    const { whop, db } = await run(shape);
    expect(whop.transfers).toHaveLength(1);
    expect(whop.posts).toBe(1);
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, attentionReason: 'ambiguous-unverified', transferUsdCents: 3_000, settledAt: null });
  });

  it.each(['no-metadata', 'bad-envelope', 'full-page-no-cursor'] as const)(
    'LOOKUP flag only, list shows %s (a list that cannot answer): ONE transfer, the row keeps retrying the lookup',
    async (shape) => {
      enable();
      const { whop, db } = await run(shape);
      expect(whop.transfers).toHaveLength(1);
      expect(whop.posts).toBe(1);
      expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, attentionReason: null, transferUsdCents: 3_000 });
      expect(k.rows(db)[0].maybeSentAt).not.toBeNull();
    },
  );

  it.each(['empty', 'null-metadata'] as const)(
    'LOOKUP flag only, list shows %s: the flag attests that the list shows our transfers, so an empty answer is believed (the runbook says when to set it)',
    async (shape) => {
      enable();
      const whop = fakeWhop({ honourKey: false, listShows: shape, afterCreate: ['bad-gateway'] });
      const db = makeDb(k, { entries: [bigShare()] });
      await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup });
      await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup, at: at(MIN) });
      expect(whop.posts).toBe(2);
    },
  );
});

describe.each(KINDS)('$name ledger: each proof allows exactly what it proves', (k) => {
  const bigShare = (over: Record<string, any> = {}) => k.entry({ id: 'led_1', [k.cfg.shareKey]: 3_000, grossUsdCents: 10_000, ...over });
  const blind: LookupFn = async () => ({ kind: 'unknown', reason: 'the list cannot answer' });
  const empty: LookupFn = async () => ({ kind: 'not-found' });

  it('IDEMPOTENCE flag, key honoured: re-sent ONCE with the same key whatever the lookup says (unknown or empty)', async () => {
    for (const lookup of [blind, empty]) {
      enableKeyHonoured();
      const whop = fakeWhop({ honourKey: true, afterCreate: ['timeout'] });
      const db = makeDb(k, { entries: [bigShare()] });
      await k.settle(db, { transfer: whop.transfer, lookup });
      expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, attentionReason: null });
      await k.settle(db, { transfer: whop.transfer, lookup, at: at(MIN) });
      expect(whop.posts).toBe(2);
      expect(whop.transfers).toHaveLength(1);
      expect(whop.transfers[0]!.key).toBe('led_1');
      expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'wt_1' });
    }
  });

  it('IDEMPOTENCE flag: a transfer the lookup does find settles the row without a second POST', async () => {
    enableKeyHonoured();
    const whop = fakeWhop({ honourKey: true, listShows: 'metadata', afterCreate: ['timeout'] });
    const db = makeDb(k, { entries: [bigShare()] });
    await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup });
    await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup, at: at(MIN) });
    expect(whop.posts).toBe(1);
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'wt_1' });
  });

  it('LOOKUP flag, a mock whose list shows our metadata: the lookup settles the row, one POST', async () => {
    enable();
    const whop = fakeWhop({ honourKey: false, listShows: 'metadata', afterCreate: ['bad-gateway'] });
    const db = makeDb(k, { entries: [bigShare()] });
    await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup });
    const out = await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup, at: at(MIN) });
    expect(out.recovered).toBe(1);
    expect(whop.posts).toBe(1);
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'wt_1' });
  });

  it('LOOKUP flag: a not-found that reached the end of the list counts as "it did not go out" and the row is re-sent once', async () => {
    enable();
    const whop = fakeWhop({ honourKey: false, afterCreate: [] });
    const db = makeDb(k, { entries: [bigShare()] });
    // The first attempt never reached Whop at all: the connection dropped before the request was served.
    const dropped = vi.fn().mockRejectedValueOnce(new Error('fetch failed')).mockImplementation(whop.transfer);
    await k.settle(db, { transfer: dropped, lookup: whop.lookup });
    await k.settle(db, { transfer: dropped, lookup: whop.lookup, at: at(MIN) });
    expect(whop.posts).toBe(1);
    expect(whop.transfers).toHaveLength(1);
    expect(k.rows(db)[0].state).toBe('SETTLED');
  });

  it('BOTH flags behave as the idempotence flag (a found transfer still settles first)', async () => {
    enableBoth();
    const whop = fakeWhop({ honourKey: true, afterCreate: ['timeout'] });
    const db = makeDb(k, { entries: [bigShare()] });
    await k.settle(db, { transfer: whop.transfer, lookup: blind });
    await k.settle(db, { transfer: whop.transfer, lookup: blind, at: at(MIN) });
    expect(whop.transfers).toHaveLength(1);
    expect(k.rows(db)[0].state).toBe('SETTLED');
  });

  it('NEITHER flag: an unknown outcome stays flagged however the lookup answers (not-found, unknown, throws)', async () => {
    for (const lookup of [empty, blind, (async () => { throw new Error('down'); }) as LookupFn]) {
      enableUnverified();
      const whop = fakeWhop({ honourKey: true, afterCreate: ['timeout'] });
      const db = makeDb(k, { entries: [bigShare()] });
      await k.settle(db, { transfer: whop.transfer, lookup });
      await k.settle(db, { transfer: whop.transfer, lookup, at: at(2 * MIN) });
      await k.settle(db, { transfer: whop.transfer, lookup, at: at(30 * MIN) });
      expect(whop.posts).toBe(1);
      expect(k.rows(db)[0].attentionReason).toBe('ambiguous-unverified');
    }
  });
});

describe.each(KINDS)('$name ledger: a flagged row is excluded from selection and from re-claim', (k) => {
  const bigShare = (over: Record<string, any> = {}) => k.entry({ id: 'led_1', [k.cfg.shareKey]: 3_000, grossUsdCents: 10_000, ...over });

  it('flagged with neither proof, then the proofs are set and the key-ignoring mock answers an empty list: still flagged, no extra POST', async () => {
    enableUnverified();
    const whop = fakeWhop({ honourKey: false, listShows: 'empty', afterCreate: ['bad-gateway'] });
    const db = makeDb(k, { entries: [bigShare()] });
    await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup });
    expect(k.rows(db)[0].attentionReason).toBe('ambiguous-unverified');

    for (const set of [enableBoth, enableKeyHonoured, enable]) {
      set();
      for (const later of [5 * MIN, 90 * MIN, 30 * 60 * MIN]) {
        await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup, at: at(later) });
      }
    }
    expect(whop.posts).toBe(1);
    expect(whop.transfers).toHaveLength(1);
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, attentionReason: 'ambiguous-unverified' });
  });

  it('the retry selection names attentionReason = null', async () => {
    enable();
    const db = makeDb(k, { entries: [bigShare()] });
    const find = vi.spyOn(k.entryDelegate(db), 'findMany');
    await k.settle(db);
    const due = find.mock.calls.map((c: any) => c[0].where).find((w: any) => w.state === k.waiting && w.attentionReason === null);
    expect(due).toBeTruthy();
    const flaggedQuery = find.mock.calls.map((c: any) => c[0].where).find((w: any) => w.attentionReason?.not === null);
    expect(flaggedQuery).toBeTruthy(); // the separate lookup-only pass
  });

  it('the re-claim of a waiting row names attentionReason = null', async () => {
    enable();
    const whop = fakeWhop({ honourKey: true, afterCreate: ['timeout'] });
    const db = makeDb(k, { entries: [bigShare()] });
    await k.settle(db, { transfer: whop.transfer, lookup: async () => ({ kind: 'not-found' }) });
    const update = vi.spyOn(k.entryDelegate(db), 'updateMany');
    await k.settle(db, { transfer: whop.transfer, lookup: async () => ({ kind: 'not-found' }), at: at(MIN) });
    const reclaim = update.mock.calls.map((c: any) => c[0]).find((a: any) => a.data.state === 'SENDING');
    expect(reclaim.where).toMatchObject({ attentionReason: null, transferAttempts: 1 });
  });
});

describe.each(KINDS)('$name ledger: every lookup carries the sweep deadline', (k) => {
  const bigShare = (over: Record<string, any> = {}) => k.entry({ id: 'led_1', [k.cfg.shareKey]: 3_000, grossUsdCents: 10_000, ...over });

  it('the lookup for a retrying row and the lookup for a flagged row both receive deadlineMs', async () => {
    const deadlineMs = Date.now() + 100_000;
    const spy = vi.fn<LookupFn>(async () => ({ kind: 'unknown', reason: 'x' }));

    enable();
    const retrying = makeDb(k, { entries: [bigShare({ transferUsdCents: 3_000, transferAttempts: 1, maybeSentAt: NOW })] });
    await k.settle(retrying, { lookup: spy, deadlineMs, at: at(5 * MIN) });
    expect(spy.mock.calls[0]![0]).toMatchObject({ ledgerEntryId: 'led_1', deadlineMs });

    spy.mockClear();
    const flagged = makeDb(k, { entries: [bigShare({ transferUsdCents: 3_000, transferAttempts: 1, maybeSentAt: NOW, attentionReason: 'ambiguous-unverified' })] });
    await k.settle(flagged, { lookup: spy, deadlineMs, at: at(5 * MIN) });
    expect(spy.mock.calls[0]![0]).toMatchObject({ ledgerEntryId: 'led_1', deadlineMs });
  });
});

describe.each(KINDS)('$name ledger: a success status without a transfer id', (k) => {
  const bigShare = (over: Record<string, any> = {}) => k.entry({ id: 'led_1', [k.cfg.shareKey]: 3_000, grossUsdCents: 10_000, ...over });
  const noId = (async () => ({ transferId: undefined as unknown as string })) as any;

  it('never settles the row: with neither proof it is flagged, with a proof it is retried', async () => {
    enableUnverified();
    const db = makeDb(k, { entries: [bigShare()] });
    await k.settle(db, { transfer: noId });
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, attentionReason: 'ambiguous-unverified', whopTransferId: null, settledAt: null });

    enable();
    const db2 = makeDb(k, { entries: [bigShare()] });
    await k.settle(db2, { transfer: noId });
    expect(k.rows(db2)[0]).toMatchObject({ state: k.waiting, attentionReason: null, whopTransferId: null, settledAt: null });
    expect(k.rows(db2)[0].maybeSentAt).not.toBeNull();
  });
});

describe.each(KINDS)('$name ledger: the admin resolves any row whose transfer may have gone out', (k) => {
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

  async function retrying() {
    enable();
    const whop = fakeWhop({ honourKey: false, listShows: 'no-metadata', afterCreate: ['bad-gateway'] });
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1' })] });
    await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup });
    return { db, whop };
  }

  it('a row retrying under a lookup that cannot answer (not flagged, an attempt with an unknown outcome) can be resolved', async () => {
    const { db, whop } = await retrying();
    expect(k.rows(db)[0]).toMatchObject({ attentionReason: null });
    expect(k.rows(db)[0].maybeSentAt).not.toBeNull();
    expect(await resolve(db)).toEqual({ ok: true });
    expect(k.rows(db)[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'wt_1' });
    await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup, at: at(60 * MIN) });
    expect(whop.posts).toBe(1);
  });

  it('"it did not go out" on such a row returns it to retry, sent once', async () => {
    const { db, whop } = await retrying();
    expect(await resolve(db, { outcome: 'did-not-go-out', transferId: undefined })).toEqual({ ok: true });
    expect(k.rows(db)[0]).toMatchObject({ state: k.waiting, maybeSentAt: null, attentionReason: null, transferUsdCents: null });
    await k.settle(db, { transfer: whop.transfer, lookup: whop.lookup, at: at(11 * MIN) });
    expect(whop.posts).toBe(2);
  });

  it('a stale SENDING row can be resolved; a fresh one (its run may still be working) cannot', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1', state: 'SENDING', transferUsdCents: 300, transferAttempts: 1, lastAttemptAt: NOW })] });
    expect(await resolve(db, { at: at(MIN) })).toMatchObject({ ok: false });
    expect(await resolve(db, { at: at(11 * MIN) })).toEqual({ ok: true });
    expect(k.rows(db)[0].state).toBe('SETTLED');
  });

  it('a row with no attempt of unknown outcome (fresh, or refused outright) cannot be resolved', async () => {
    enable();
    const db = makeDb(k, { entries: [k.entry({ id: 'led_1' })] });
    expect(await resolve(db)).toMatchObject({ ok: false });
    const claimedRefused = makeDb(k, { entries: [k.entry({ id: 'led_1', transferUsdCents: 300, transferAttempts: 1 })] });
    expect(await resolve(claimedRefused)).toMatchObject({ ok: false });
  });

  it('"it went out" refuses a transfer id already recorded on ANOTHER ledger row (either ledger), and audits the refusal', async () => {
    const { db } = await retrying();
    const other = KINDS.find((o) => o.name !== k.name)!;
    // the same id on a row of the other ledger
    other.rows(db).push({ id: 'other_row', whopTransferId: 'wt_1', state: 'SETTLED', bookingIntentId: 'bx' } as Entry);
    const out = await resolve(db);
    expect(out).toMatchObject({ ok: false, message: expect.stringMatching(/already recorded/) });
    expect(k.rows(db)[0].state).toBe(k.waiting);
    const refused = db.fees.find((f: any) => f.kind === 'TRANSFER_RESOLUTION_REFUSED');
    expect(refused).toMatchObject({ whopTransferId: 'wt_1' });
    expect(JSON.parse(refused!.note)).toMatchObject({ refusedBecause: expect.stringMatching(/already recorded/), adminUserId: 'usr_admin' });
    // ...and the same ledger
    other.rows(db).pop();
    k.rows(db).push({ ...k.entry({ id: 'same_ledger_row', bookingIntentId: 'by' }), whopTransferId: 'wt_1', state: 'SETTLED' } as Entry);
    expect(await resolve(db)).toMatchObject({ ok: false, message: expect.stringMatching(/already recorded/) });
    // a different id is accepted
    expect(await resolve(db, { transferId: 'wt_2' })).toEqual({ ok: true });
  });
});

describe('the affiliate ledger only: shares owed to an inactive recruiter are information, not an alarm', () => {
  const k = KINDS[0];
  const old = new Date(NOW.getTime() - 40 * MIN);

  it('listed with severity "info" and no resolve action, while a claimed row of the same recruiter is an alert', async () => {
    enable();
    const w: any = { R: { whopCompanyId: 'biz_R', whopPayoutsEnabled: true, archivedAt: new Date(Date.UTC(2026, 11, 15)) } };
    const db = makeDb(k, {
      practitioners: w,
      entries: [
        k.entry({ id: 'plain', createdAt: old }),
        k.entry({ id: 'claimed', bookingIntentId: 'b2', createdAt: old, transferUsdCents: 300, transferAttempts: 1 }),
      ],
    });
    const out = await findUnconfirmedTransfers(db as any, { at: NOW });
    expect(out.map((r) => [r.id, r.severity, r.reason, r.canResolve])).toEqual([
      ['claimed', 'alert', 'waiting', false],
      ['plain', 'info', 'payee-inactive', false],
    ]);
  });

  it('many inactive rows do not crowd real alerts out of the listing', async () => {
    enable();
    const w: any = {
      R: { whopCompanyId: 'biz_R', whopPayoutsEnabled: true, archivedAt: new Date(Date.UTC(2026, 11, 15)) },
      S: { whopCompanyId: 'biz_S', whopPayoutsEnabled: true },
    };
    const inactive = Array.from({ length: 250 }, (_, i) => k.entry({ id: `i${i}`, bookingIntentId: `bi${i}`, createdAt: new Date(old.getTime() - 100 * MIN + i) }));
    const real = k.entry({ id: 'real', bookingIntentId: 'br', recruiterPractitionerId: 'S', createdAt: old, transferUsdCents: 300, attentionReason: 'ambiguous-unverified' });
    const db = makeDb(k, { practitioners: w, entries: [...inactive, real] });
    const out = await findUnconfirmedTransfers(db as any, { at: NOW });
    expect(out.find((r) => r.id === 'real')).toMatchObject({ severity: 'alert', reason: 'needs-attention', canResolve: true });
  });
});
