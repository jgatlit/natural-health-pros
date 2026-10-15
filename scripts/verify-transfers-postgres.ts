/**
 * PROVES THE TRANSFER-AT-CLEARING GUARANTEES AGAINST A REAL POSTGRES (throwaway local database only).
 *
 * The unit tests run the money code against an in-memory fake. This script runs the same code through
 * Prisma against a real database, where the guarded updates, the netting transactions and the
 * compare-and-swaps are enforced by Postgres under true concurrency, with a MOCKED transfer function
 * (nothing here can reach Whop).
 *
 *   docker run --rm -d --name nhp-pg-r4 -e POSTGRES_PASSWORD=x -p 55460:5432 postgres:16
 *   (create the database, CREATE EXTENSION pg_trgm, apply the migrations in prisma/migrations)
 *   hhe_directory_DATABASE_URL=postgresql://postgres:x@localhost:55460/<db> \
 *   hhe_directory_DATABASE_URL_UNPOOLED=postgresql://postgres:x@localhost:55460/<db> \
 *     npx tsx scripts/verify-transfers-postgres.ts
 *
 * REFUSES to run unless the database host is localhost/127.0.0.1/::1. It reads no env file.
 * It writes rows (users, practitioners, bookings, ledger rows) and leaves them; use a throwaway DB.
 */

import { PrismaClient } from '@prisma/client';

import { applyLedgerReversal, type ReversalDb } from '../src/lib/ledger-reversal';
import { AFFILIATE_LEDGER, REFERRAL_LEDGER, type LedgerConfig } from '../src/lib/ledger-config';
import {
  STALE_SENDING_AFTER_MS,
  findUnconfirmedTransfers,
  settleLedger,
  type LedgerTransferDb,
  type LookupFn,
  type TransferFn,
} from '../src/lib/ledger-transfer';
import { reverseReferralOnRefund, type RefundDb } from '../src/lib/referral-refunds';
import { resolveTransferAttention } from '../src/lib/transfer-attention';
import { fakeWhop } from '../tests/helpers/fake-whop';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function assertLocalDatabase(): void {
  const urls = [process.env.hhe_directory_DATABASE_URL, process.env.hhe_directory_DATABASE_URL_UNPOOLED];
  if (!urls[0] || !urls[1]) throw new Error('set hhe_directory_DATABASE_URL and hhe_directory_DATABASE_URL_UNPOOLED to the local throwaway database');
  for (const u of urls) {
    const host = new URL(u!).hostname;
    if (!LOCAL.has(host.toLowerCase())) throw new Error(`refusing to run: database host ${host} is not local`);
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
}

const run = `pg${Date.now().toString(36)}`;
let seq = 0;
const uid = (p: string) => `${run}_${p}_${++seq}`;

const prisma = new PrismaClient();
const db = prisma as unknown as LedgerTransferDb;

async function newPractitioner(label: string) {
  const id = uid(label);
  const user = await prisma.user.create({ data: { email: `${id}@example.test`, name: id } });
  return prisma.practitioner.create({
    data: {
      id,
      userId: user.id,
      slug: id,
      displayName: id,
      whopCompanyId: `biz_${id}`,
      whopPayoutsEnabled: true,
    },
  });
}

async function newBooking(practitionerId: string) {
  return prisma.bookingIntent.create({
    data: { practitionerId, entryPoint: 'OFFERING_CARD', name: 'Client', email: `${uid('c')}@example.test`, status: 'PAID', paidAt: new Date() },
  });
}

type Seeded = { id: string; bookingId: string };

async function seedRow(cfg: LedgerConfig, payeeId: string, servingId: string, shareCents: number, grossCents = 1_000): Promise<Seeded> {
  const booking = await newBooking(servingId);
  const base = { bookingIntentId: booking.id, grossUsdCents: grossCents, whopPaymentId: `pay_${booking.id}` };
  if (cfg.kind === 'affiliate') {
    const r = await prisma.affiliateLedgerEntry.create({
      data: {
        ...base,
        recruiterPractitionerId: payeeId,
        recruitedPractitionerId: servingId,
        bps: 300,
        shareUsdCents: shareCents,
        grossShareUsdCents: shareCents,
        holdDays: 0,
        holdUntil: new Date(),
      },
    });
    return { id: r.id, bookingId: booking.id };
  }
  const r = await prisma.referralLedgerEntry.create({
    data: {
      ...base,
      referrerPractitionerId: payeeId,
      servingPractitionerId: servingId,
      clientEmailHash: uid('h'),
      referrerShareUsdCents: shareCents,
      grossShareUsdCents: shareCents,
      referrerRateBps: 2_000,
      collectedFeeUsdCents: shareCents,
      state: 'PAYABLE',
    },
  });
  return { id: r.id, bookingId: booking.id };
}

const rowOf = (cfg: LedgerConfig, id: string): Promise<Record<string, any> | null> => // eslint-disable-line @typescript-eslint/no-explicit-any
  (prisma as any)[cfg.entry].findUnique({ where: { id } }); // eslint-disable-line @typescript-eslint/no-explicit-any
const debitsOf = (cfg: LedgerConfig, payeeId: string): Promise<Array<Record<string, any>>> => // eslint-disable-line @typescript-eslint/no-explicit-any
  (prisma as any)[cfg.adjustment].findMany({ where: { [cfg.payeeKey]: payeeId }, orderBy: { createdAt: 'asc' } }); // eslint-disable-line @typescript-eslint/no-explicit-any

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noLookup: LookupFn = async () => ({ kind: 'not-found' });

/** A mock transfer that records every call and answers after a short delay (so runs genuinely overlap). */
function mockTransfer() {
  const calls: Array<Parameters<TransferFn>[0]> = [];
  let n = 0;
  const fn: TransferFn = async (args) => {
    calls.push(args);
    await sleep(40);
    return { transferId: `tr_${run}_${++n}` };
  };
  return { fn, calls };
}

const sentCents = (calls: Array<Parameters<TransferFn>[0]>) => calls.reduce((s, c) => s + Math.round(c.amountUsdDollars * 100), 0);

async function scenarioFor(cfg: LedgerConfig): Promise<void> {
  const tag = cfg.kind;
  const payee = await newPractitioner('payee');
  const serving = await newPractitioner('serving');
  const NOW = new Date();
  const settle = (transfer: TransferFn, lookup: LookupFn = noLookup, over: Record<string, unknown> = {}) =>
    settleLedger(db, cfg, { transfer, lookup, at: NOW, only: undefined, ...over } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

  // ---- A. the payment-webhook trigger and the cron backstop racing on ONE row: one transfer
  {
    const row = await seedRow(cfg, payee.id, serving.id, 300);
    const { fn, calls } = mockTransfer();
    const only = { bookingIntentId: row.bookingId, payeeId: payee.id };
    await Promise.all([
      settle(fn, noLookup, { only }),
      settle(fn),
      settle(fn),
      settle(fn, noLookup, { only }),
      settle(fn),
      settle(fn, noLookup, { only }),
    ]);
    const r = await rowOf(cfg, row.id);
    check(`${tag}: webhook trigger + cron backstop racing on one row send exactly one transfer`, calls.length === 1 && r?.state === 'SETTLED', { calls: calls.length, state: r?.state });
    check(`${tag}: the transfer is the full share, with the row id as idempotence key and the ids as metadata`,
      calls[0]?.amountUsdDollars === 3 && calls[0]?.idempotenceKey === row.id && calls[0]?.metadata?.ledger_entry_id === row.id && calls[0]?.metadata?.booking_intent_id === row.bookingId,
      calls[0]);
    check(`${tag}: net = gross = share and no fee is recorded`, r?.grossShareUsdCents === 300 && r?.netPaidUsdCents === 300 && r?.transferFeeUsdCents == null, r);
  }

  // ---- B. an ambiguous failure is retried with the SAME key; a found transfer is never re-sent
  {
    const row = await seedRow(cfg, payee.id, serving.id, 300);
    const only = { bookingIntentId: row.bookingId, payeeId: payee.id };
    const bad: TransferFn = async () => {
      throw new Error('The operation was aborted due to timeout');
    };
    await settle(bad, noLookup, { only });
    let r = await rowOf(cfg, row.id);
    check(`${tag}: a timed-out attempt goes back to waiting with attempts=1 and a retry time`, r?.state === cfg.waiting && r?.transferAttempts === 1 && r?.nextAttemptAt != null && r?.transferUsdCents === 300, r);

    const { fn, calls } = mockTransfer();
    const lookups: Array<unknown> = [];
    const lookup: LookupFn = async (a) => {
      lookups.push(a);
      return { kind: 'not-found' };
    };
    const later = new Date(NOW.getTime() + 2 * 60_000);
    await Promise.all([settle(fn, lookup, { only, at: later }), settle(fn, lookup, { only, at: later })]);
    r = await rowOf(cfg, row.id);
    check(`${tag}: the retry looks the transfer up first, then sends once with the same key and amount`, calls.length === 1 && lookups.length === 1 && calls[0]?.idempotenceKey === row.id && calls[0]?.amountUsdDollars === 3 && r?.state === 'SETTLED', { calls: calls.length, lookups: lookups.length, state: r?.state });

    const row2 = await seedRow(cfg, payee.id, serving.id, 300);
    const only2 = { bookingIntentId: row2.bookingId, payeeId: payee.id };
    await settle(bad, noLookup, { only: only2 });
    const { fn: fn2, calls: calls2 } = mockTransfer();
    await settle(fn2, async () => ({ kind: 'found' as const, transferId: 'tr_found', amountUsdDollars: 3 }), { only: only2, at: later });
    const r2 = await rowOf(cfg, row2.id);
    check(`${tag}: when Whop already has the transfer the row is settled from it and nothing is sent`, calls2.length === 0 && r2?.state === 'SETTLED' && r2?.whopTransferId === 'tr_found', { calls: calls2.length, r2 });
  }

  // ---- C. a SENDING row whose run died is recovered by lookup once stale, never before
  {
    const row = await seedRow(cfg, payee.id, serving.id, 300);
    await (prisma as any)[cfg.entry].update({ where: { id: row.id }, data: { state: 'SENDING', transferUsdCents: 300, transferAttempts: 1, lastAttemptAt: NOW } }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const only = { bookingIntentId: row.bookingId, payeeId: payee.id };
    const { fn, calls } = mockTransfer();
    await settle(fn, async () => ({ kind: 'found' as const, transferId: 'tr_recovered', amountUsdDollars: 3 }), { only, at: new Date(NOW.getTime() + STALE_SENDING_AFTER_MS - 1) });
    let r = await rowOf(cfg, row.id);
    check(`${tag}: a fresh SENDING row is left alone`, r?.state === 'SENDING' && calls.length === 0, r);
    await settle(fn, async () => ({ kind: 'found' as const, transferId: 'tr_recovered', amountUsdDollars: 3 }), { only, at: new Date(NOW.getTime() + STALE_SENDING_AFTER_MS) });
    r = await rowOf(cfg, row.id);
    check(`${tag}: a stale SENDING row is settled from the transfer Whop has, with nothing re-sent`, r?.state === 'SETTLED' && r?.whopTransferId === 'tr_recovered' && calls.length === 0, r);
  }

  // ---- D. refund interleavings
  const reverse = (bookingId: string, total: number) =>
    applyLedgerReversal(prisma as unknown as ReversalDb, cfg, { bookingIntentId: bookingId, payeeId: payee.id, totalReversedUsdCents: total });
  {
    // D1. refund before the claim: smaller transfer, no debit
    const row = await seedRow(cfg, payee.id, serving.id, 300);
    await reverse(row.bookingId, 120);
    const { fn, calls } = mockTransfer();
    await settle(fn, noLookup, { only: { bookingIntentId: row.bookingId, payeeId: payee.id } });
    check(`${tag}: a refund before the claim shrinks the transfer (180) and books no debit`, calls.length === 1 && calls[0]?.amountUsdDollars === 1.8, calls);

    // D2. refund after the receipt: a debit; the next transfer nets it
    const d0 = (await debitsOf(cfg, payee.id)).length;
    await reverse(row.bookingId, 150);
    const debits = await debitsOf(cfg, payee.id);
    check(`${tag}: a refund after the receipt books a debit for exactly its cents, once even when repeated`, debits.length === d0 + 1 && debits.at(-1)?.amountUsdCents === 30, debits.at(-1));
    await reverse(row.bookingId, 150);
    check(`${tag}: a redelivered refund adds no second debit`, (await debitsOf(cfg, payee.id)).length === d0 + 1);

    const next = await seedRow(cfg, payee.id, serving.id, 300);
    const t2 = mockTransfer();
    await settle(t2.fn, noLookup, { only: { bookingIntentId: next.bookingId, payeeId: payee.id } });
    const nr = await rowOf(cfg, next.id);
    check(`${tag}: the next transfer is netted by the open debit (300 - 30 = 270) and the debit is APPLIED`, t2.calls[0]?.amountUsdDollars === 2.7 && nr?.adjustmentAppliedUsdCents === 30 && nr?.netPaidUsdCents === 270, { call: t2.calls[0], nr });
  }
  {
    // D3. refund racing the settle, both orders, many times: conservation holds
    let ok = true;
    let detail: unknown = null;
    for (let i = 0; i < 12; i += 1) {
      const racePayee = await newPractitioner('race');
      const row = await seedRow(cfg, racePayee.id, serving.id, 300);
      const { fn, calls } = mockTransfer();
      const rev = () => applyLedgerReversal(prisma as unknown as ReversalDb, cfg, { bookingIntentId: row.bookingId, payeeId: racePayee.id, totalReversedUsdCents: 120 });
      const st = () => settleLedger(db, cfg, { transfer: fn, lookup: noLookup, at: NOW, only: { bookingIntentId: row.bookingId, payeeId: racePayee.id } });
      await (i % 2 === 0 ? Promise.all([rev(), st()]) : Promise.all([st(), rev()]));
      // a follow-up run settles whatever the race skipped
      await settleLedger(db, cfg, { transfer: fn, lookup: noLookup, at: NOW, only: { bookingIntentId: row.bookingId, payeeId: racePayee.id } });
      const sent = sentCents(calls);
      const debited = (await debitsOf(cfg, racePayee.id)).reduce((s, d) => s + d.amountUsdCents, 0);
      if (sent - debited !== 180 || calls.length !== 1) {
        ok = false;
        detail = { i, sent, debited, calls: calls.length };
        break;
      }
    }
    check(`${tag}: a refund racing the settle (12 runs, both orders): sent - debited = share - refund, one transfer`, ok, detail);
  }

  // ---- E. netting concurrency: two rows, one open debit, concurrent settles apply the debit once
  {
    const netPayee = await newPractitioner('net');
    const r1 = await seedRow(cfg, netPayee.id, serving.id, 300);
    const r2 = await seedRow(cfg, netPayee.id, serving.id, 300);
    const src = await seedRow(cfg, netPayee.id, serving.id, 300);
    await (prisma as any)[cfg.adjustment].create({ data: { [cfg.payeeKey]: netPayee.id, sourceLedgerEntryId: src.id, amountUsdCents: 120, dedupeKey: uid('seeddebit') } }); // eslint-disable-line @typescript-eslint/no-explicit-any
    await (prisma as any)[cfg.entry].update({ where: { id: src.id }, data: { state: 'SETTLED', settledAt: NOW, transferUsdCents: 300 } }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const { fn, calls } = mockTransfer();
    await Promise.all([1, 2, 3, 4].map(() => settleLedger(db, cfg, { transfer: fn, lookup: noLookup, at: NOW })));
    const debits = await debitsOf(cfg, netPayee.id);
    const rows = await Promise.all([rowOf(cfg, r1.id), rowOf(cfg, r2.id)]);
    const applied = rows.reduce((s, r) => s + (r?.adjustmentAppliedUsdCents ?? 0), 0);
    check(`${tag}: concurrent settles over two rows apply the open debit exactly once (applied 120, sent 480)`,
      debits[0]?.appliedUsdCents === 120 && debits[0]?.state === 'APPLIED' && applied === 120 && sentCents(calls) === 480 && calls.length === 2,
      { debit: debits[0], applied, sent: sentCents(calls), calls: calls.length });
  }

  // ---- F. alerts: a row stuck without a receipt is listed once it is 30 minutes old, and not before
  {
    const alertPayee = await newPractitioner('alert');
    const row = await seedRow(cfg, alertPayee.id, serving.id, 300);
    const bad: TransferFn = async () => {
      throw new Error('fetch failed');
    };
    await settleLedger(db, cfg, { transfer: bad, lookup: noLookup, at: NOW, only: { bookingIntentId: row.bookingId, payeeId: alertPayee.id } });
    const soon = await findUnconfirmedTransfers(db, { at: NOW });
    const later = await findUnconfirmedTransfers(db, { at: new Date(NOW.getTime() + 31 * 60_000) });
    check(`${tag}: an unconfirmed row is not an alert at once, and is one after 30 minutes`, !soon.some((r) => r.id === row.id) && later.some((r) => r.id === row.id), { soon: soon.length, later: later.length });
  }
}

async function outcomesFor(cfg: LedgerConfig): Promise<void> {
  const tag = cfg.kind;
  const payee = await newPractitioner('opayee');
  const serving = await newPractitioner('oserving');
  const NOW = new Date();
  const only = (r: Seeded) => ({ bookingIntentId: r.bookingId, payeeId: payee.id });
  const gate = (on: boolean) => {
    if (on) process.env.WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED = 'true';
    else delete process.env.WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED;
  };
  const sweep = (row: Seeded, whop: ReturnType<typeof fakeWhop>, at: Date, lookup: LookupFn = whop.lookup) =>
    settleLedger(db, cfg, { transfer: whop.transfer, lookup, at, only: only(row) });
  const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

  // ---- G. the reviewer's mock: key ignored, list omits metadata, 502 after the transfer exists
  {
    gate(false);
    const row = await seedRow(cfg, payee.id, serving.id, 3_000, 10_000);
    const whop = fakeWhop({ honourKey: false, listShows: 'no-metadata', afterCreate: ['bad-gateway'] });
    await sweep(row, whop, NOW);
    for (const m of [2, 61, 25 * 60]) await sweep(row, whop, later(m));
    let r = await rowOf(cfg, row.id);
    check(`${tag}: a 502 after the transfer exists, key ignored, metadata not listed: ONE transfer ($30.00) and a needs-attention row`,
      whop.transfers.length === 1 && whop.posts === 1 && r?.attentionReason === 'ambiguous-unverified' && r?.state === cfg.waiting, { transfers: whop.transfers.length, posts: whop.posts, r });

    // the admin records that it went out
    const res = await resolveTransferAttention(db, { ledger: cfg.kind, rowId: row.id, outcome: 'went-out', transferId: 'wt_1', reason: 'seen in the dashboard', adminUserId: null, at: later(30) });
    r = await rowOf(cfg, row.id);
    const audit = await prisma.feeLedgerEntry.findFirst({ where: { kind: 'TRANSFER_RESOLUTION', practitionerId: payee.id, bookingIntentId: row.bookingId } });
    check(`${tag}: "it went out" settles the row with the recorded id, audited in the same transaction`, res.ok && r?.state === 'SETTLED' && r?.whopTransferId === 'wt_1' && audit?.whopTransferId === 'wt_1', { res, r, audit });
    await sweep(row, whop, later(60));
    check(`${tag}: nothing is sent after the decision`, whop.posts === 1);
  }

  // ---- H. "it did not go out" returns a fresh row (debits restored) that is then sent once
  {
    gate(false);
    const src = await seedRow(cfg, payee.id, serving.id, 300);
    const debitRow = await (prisma as any)[cfg.adjustment].create({ data: { [cfg.payeeKey]: payee.id, sourceLedgerEntryId: src.id, amountUsdCents: 120, dedupeKey: uid('hdebit') } }); // eslint-disable-line @typescript-eslint/no-explicit-any
    await (prisma as any)[cfg.entry].update({ where: { id: src.id }, data: { state: 'SETTLED', settledAt: NOW, transferUsdCents: 300 } }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const row = await seedRow(cfg, payee.id, serving.id, 300);
    const whop = fakeWhop({ honourKey: false, listShows: 'no-metadata', afterCreate: ['timeout'] });
    await sweep(row, whop, NOW);
    let r = await rowOf(cfg, row.id);
    let d = (await debitsOf(cfg, payee.id)).find((x) => x.id === debitRow.id);
    check(`${tag}: the flagged row had netted the open debit (applied 120) at its claim`, r?.attentionReason != null && r?.adjustmentAppliedUsdCents === 120 && d?.appliedUsdCents === 120, { r, d });
    const res = await resolveTransferAttention(db, { ledger: cfg.kind, rowId: row.id, outcome: 'did-not-go-out', reason: 'checked, none', adminUserId: null, at: later(10) });
    r = await rowOf(cfg, row.id);
    d = (await debitsOf(cfg, payee.id)).find((x) => x.id === debitRow.id);
    check(`${tag}: "it did not go out" makes the row fresh and restores the debit exactly`, res.ok && r?.transferUsdCents == null && r?.attentionReason == null && d?.appliedUsdCents === 0 && d?.state === 'OPEN', { res, r, d });
    await sweep(row, whop, later(11));
    r = await rowOf(cfg, row.id);
    check(`${tag}: the next sweep sends it once, netting the debit again ($1.80)`, whop.posts === 2 && r?.state === 'SETTLED' && r?.netPaidUsdCents === 180, { posts: whop.posts, r });
  }

  // ---- I. gate true, key honoured, list lags: one retry with the same key, one transfer
  {
    gate(true);
    const row = await seedRow(cfg, payee.id, serving.id, 3_000, 10_000);
    const whop = fakeWhop({ honourKey: true, afterCreate: ['timeout'] });
    const lagging: LookupFn = async () => ({ kind: 'not-found' });
    await sweep(row, whop, NOW, lagging);
    await sweep(row, whop, later(1), lagging);
    const r = await rowOf(cfg, row.id);
    check(`${tag}: gate true + key honoured: retried once with the same key, one transfer, settled`, whop.posts === 2 && whop.transfers.length === 1 && r?.state === 'SETTLED', { posts: whop.posts, r });
  }

  // ---- J. a refund after a REFUSED attempt reduces the share; the claim's debits are restored
  {
    gate(true);
    const refusing = (): import('../src/lib/ledger-transfer').TransferFn => {
      let first = true;
      return async (args) => {
        if (first) {
          first = false;
          throw new Error('Whop /transfers failed (402): insufficient available balance');
        }
        calls.push(args);
        return { transferId: `tr_${run}_j${calls.length}` };
      };
    };
    const calls: Array<Parameters<import('../src/lib/ledger-transfer').TransferFn>[0]> = [];
    const row = await seedRow(cfg, payee.id, serving.id, 3_000, 10_000);
    const t = refusing();
    await settleLedger(db, cfg, { transfer: t, lookup: noLookup, at: NOW, only: only(row) });
    let r = await rowOf(cfg, row.id);
    check(`${tag}: a refused attempt leaves the row fresh (no fixed amount)`, r?.state === cfg.waiting && r?.transferUsdCents == null && r?.adjustmentAllocations == null, r);
    await applyLedgerReversal(prisma as unknown as ReversalDb, cfg, { bookingIntentId: row.bookingId, payeeId: payee.id, totalReversedUsdCents: 1_000 });
    await settleLedger(db, cfg, { transfer: t, lookup: noLookup, at: later(2), only: only(row) });
    r = await rowOf(cfg, row.id);
    const rowDebits = (await debitsOf(cfg, payee.id)).filter((x) => x.sourceLedgerEntryId === row.id);
    check(`${tag}: refund (1000) after the refusal: the retry sends 2000 and books no debit`, calls.length === 1 && calls[0]?.amountUsdDollars === 20 && rowDebits.length === 0 && r?.state === 'SETTLED', { calls, rowDebits, r });

    const full = await seedRow(cfg, payee.id, serving.id, 3_000, 10_000);
    const t2 = refusing();
    await settleLedger(db, cfg, { transfer: t2, lookup: noLookup, at: NOW, only: only(full) });
    await applyLedgerReversal(prisma as unknown as ReversalDb, cfg, { bookingIntentId: full.bookingId, payeeId: payee.id, totalReversedUsdCents: 3_000 });
    const fr = await rowOf(cfg, full.id);
    check(`${tag}: the reviewer's sequence (refused, then a FULL refund) ends REVERSED and sends nothing`, fr?.state === 'REVERSED' && calls.length === 1, { fr, calls: calls.length });
  }
  gate(true);
}

async function referralRefundPipeline(): Promise<void> {
  // The whole refund path (markers, absolute reversal, debit) through reverseReferralOnRefund on real tables.
  const payee = await newPractitioner('rpayee');
  const serving = await newPractitioner('rserving');
  const row = await seedRow(REFERRAL_LEDGER, payee.id, serving.id, 30, 1_000);
  const { fn, calls } = mockTransfer();
  await settleLedger(db, REFERRAL_LEDGER, { transfer: fn, lookup: noLookup, at: new Date(), only: { bookingIntentId: row.bookingId, payeeId: payee.id } });
  const payment = `pay_${row.bookingId}`;
  const refund = (id: string) => reverseReferralOnRefund(prisma as unknown as RefundDb, { whopPaymentId: payment, refundAmountUsdDollars: 4, refundId: id, at: new Date() });
  const out = await refund('ref_1');
  await refund('ref_1');
  await refund('ref_1');
  const debits = await debitsOf(REFERRAL_LEDGER, payee.id);
  check('referral: $4 refund of a $10 payment after a $0.30 transfer = one $0.12 debit, however often it is redelivered', out.referrerDebitRecordedUsdCents === 12 && debits.length === 1 && debits[0]?.amountUsdCents === 12 && calls.length === 1, { out, debits });
  const next = await seedRow(REFERRAL_LEDGER, payee.id, serving.id, 30, 1_000);
  const t2 = mockTransfer();
  await settleLedger(db, REFERRAL_LEDGER, { transfer: t2.fn, lookup: noLookup, at: new Date(), only: { bookingIntentId: next.bookingId, payeeId: payee.id } });
  check('referral: the next $0.30 share is sent as $0.18', t2.calls[0]?.amountUsdDollars === 0.18, t2.calls);
}

async function main(): Promise<void> {
  assertLocalDatabase();
  console.log(`run ${run} against ${new URL(process.env.hhe_directory_DATABASE_URL!).host}`);
  process.env.WHOP_TRANSFERS_ENABLED = 'true';
  process.env.WHOP_COMPANY_API_KEY = 'pg-check-not-a-real-key';
  process.env.WHOP_PARENT_COMPANY_ID = 'biz_pg_parent';
  delete process.env.WHOP_TRANSFERS_ALLOWLIST;
  delete process.env.WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED;

  // The scenarios above G run with the lookup verified; G..J set the gate themselves.
  process.env.WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED = 'true';
  await scenarioFor(AFFILIATE_LEDGER);
  await scenarioFor(REFERRAL_LEDGER);
  await outcomesFor(AFFILIATE_LEDGER);
  await outcomesFor(REFERRAL_LEDGER);
  await referralRefundPipeline();

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.stack : e);
    failures += 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
