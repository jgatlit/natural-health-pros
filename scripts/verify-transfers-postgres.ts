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
const noLookup: LookupFn = async () => null;

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
      return null;
    };
    const later = new Date(NOW.getTime() + 2 * 60_000);
    await Promise.all([settle(fn, lookup, { only, at: later }), settle(fn, lookup, { only, at: later })]);
    r = await rowOf(cfg, row.id);
    check(`${tag}: the retry looks the transfer up first, then sends once with the same key and amount`, calls.length === 1 && lookups.length === 1 && calls[0]?.idempotenceKey === row.id && calls[0]?.amountUsdDollars === 3 && r?.state === 'SETTLED', { calls: calls.length, lookups: lookups.length, state: r?.state });

    const row2 = await seedRow(cfg, payee.id, serving.id, 300);
    const only2 = { bookingIntentId: row2.bookingId, payeeId: payee.id };
    await settle(bad, noLookup, { only: only2 });
    const { fn: fn2, calls: calls2 } = mockTransfer();
    await settle(fn2, async () => ({ transferId: 'tr_found', amountUsdDollars: 3 }), { only: only2, at: later });
    const r2 = await rowOf(cfg, row2.id);
    check(`${tag}: when Whop already has the transfer the row is settled from it and nothing is sent`, calls2.length === 0 && r2?.state === 'SETTLED' && r2?.whopTransferId === 'tr_found', { calls: calls2.length, r2 });
  }

  // ---- C. a SENDING row whose run died is recovered by lookup once stale, never before
  {
    const row = await seedRow(cfg, payee.id, serving.id, 300);
    await (prisma as any)[cfg.entry].update({ where: { id: row.id }, data: { state: 'SENDING', transferUsdCents: 300, transferAttempts: 1, lastAttemptAt: NOW } }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const only = { bookingIntentId: row.bookingId, payeeId: payee.id };
    const { fn, calls } = mockTransfer();
    await settle(fn, async () => ({ transferId: 'tr_recovered', amountUsdDollars: 3 }), { only, at: new Date(NOW.getTime() + STALE_SENDING_AFTER_MS - 1) });
    let r = await rowOf(cfg, row.id);
    check(`${tag}: a fresh SENDING row is left alone`, r?.state === 'SENDING' && calls.length === 0, r);
    await settle(fn, async () => ({ transferId: 'tr_recovered', amountUsdDollars: 3 }), { only, at: new Date(NOW.getTime() + STALE_SENDING_AFTER_MS) });
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

  await scenarioFor(AFFILIATE_LEDGER);
  await scenarioFor(REFERRAL_LEDGER);
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
