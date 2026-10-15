import { describe, expect, it, vi } from 'vitest';

import { resolveBookingFee } from '@/lib/booking-fee';
import { commitPaymentAttribution } from '@/lib/referral-settlement';
import { reverseReferralOnRefund } from '@/lib/referral-refunds';
import { accrueAffiliateShare, applyAffiliateReversal } from '@/lib/affiliate-ledger';
import { V1 } from './helpers/rate-schedule';
import { fakeAffiliateDb } from './helpers/fake-affiliate-db';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * THE AFFILIATE LEDGER (spec v1.5 section 5, ruling O7) — accrual, and refunds applied to it.
 *
 * The first block runs the REAL chain: stored recruiter -> fee rule -> BookingFeeSnapshot ->
 * `payment.succeeded` commit -> AffiliateLedgerEntry. Only Prisma is faked. So "the ledger's share
 * equals the snapshot's share for every spec section 1 row" is proven through the code that ships,
 * not asserted against a hand-copied number.
 */

const R = 'prac_R';
const Y = 'prac_Y';
const X = 'prac_X';
const EMAIL = 'client@example.com';
const D = (day: number) => new Date(Date.UTC(2026, 0, 1 + day));
const PAID_AT = D(5);

/** The fake behind `resolveBookingFee`: Y is recruited by R, R is active. */
function feeDb(attributed: Record<string, unknown> | null, clientListed: boolean, recruited = true) {
  const snapshots: Record<string, any>[] = [];
  return {
    snapshots,
    practitioner: {
      findUnique: async (args: any) =>
        args.select?.recruitedById ? { recruitedById: recruited ? R : null } : { rateSchedule: V1 },
      findFirst: async (args: any) => (recruited && args.where.id === R ? { id: R } : null),
    },
    rateSchedule: { findUnique: async () => V1 },
    attributedClient: { findUnique: async () => attributed },
    clientListEntry: { findFirst: async () => (clientListed ? { addedAt: D(-30) } : null) },
    bookingIntent: { findFirst: async () => ({ createdAt: D(5) }) },
    referralTouch: { findMany: async () => [] },
    bookingFeeSnapshot: {
      upsert: async (args: any) => {
        snapshots.push(args.create);
        return args.create;
      },
    },
  };
}

/** The fake behind `commitPaymentAttribution`, with a REAL in-memory affiliate delegate. */
function commitDb(snapshot: Record<string, any> | null, affiliate = fakeAffiliateDb()) {
  const feeLedger = new Map<string, Record<string, unknown>>();
  const attributed = new Map<string, Record<string, unknown>>();
  const referralLedger = new Map<string, Record<string, unknown>>();
  return {
    affiliate,
    feeLedger,
    referralLedger,
    affiliateLedgerEntry: affiliate.affiliateLedgerEntry,
    affiliateBalanceAdjustment: affiliate.affiliateBalanceAdjustment,
    $transaction: affiliate.$transaction,
    bookingFeeSnapshot: { findUnique: async () => snapshot },
    practitioner: { findUnique: async () => ({ id: X, whopCompanyId: 'biz_x', whopPayoutsEnabled: true }) },
    attributedClient: {
      findUnique: async () => null,
      upsert: async (args: any) => {
        const { practitionerId, emailHash } = args.where.practitionerId_emailHash;
        const k = `${practitionerId}|${emailHash}`;
        if (!attributed.has(k)) attributed.set(k, { ...args.create });
        return attributed.get(k);
      },
      updateMany: async () => ({ count: 0 }),
    },
    referralLedgerEntry: {
      upsert: async (args: any) => {
        const w = args.where.bookingIntentId_referrerPractitionerId;
        const k = `${w.bookingIntentId}|${w.referrerPractitionerId}`;
        if (!referralLedger.has(k)) referralLedger.set(k, { ...args.create });
        return referralLedger.get(k);
      },
    },
    feeLedgerEntry: {
      upsert: async (args: any) => {
        if (!feeLedger.has(args.where.dedupeKey)) feeLedger.set(args.where.dedupeKey, { ...args.create });
        return feeLedger.get(args.where.dedupeKey);
      },
      findMany: async (args: any) =>
        Array.from(feeLedger.values()).filter((l) => Object.entries(args.where).every(([k, v]) => l[k] === v)),
    },
    referralTouch: {
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => null,
      findMany: async () => [],
    },
    clientListEntry: { findFirst: async () => null, upsert: async () => ({ id: 'e' }) },
    bookingIntent: { findFirst: async () => null },
  };
}

const commit = (db: ReturnType<typeof commitDb>, over: Record<string, unknown> = {}) =>
  commitPaymentAttribution(db as any, {
    bookingIntentId: 'bi_1',
    practitionerId: Y,
    email: EMAIL,
    party: 'NHP',
    source: 'DIRECTORY',
    referralTouchId: null,
    termMonths: 8,
    holdDays: 90,
    paidAt: PAID_AT,
    whopPaymentId: 'pay_1',
    ...over,
  });

async function pipeline(opts: {
  plan: 'PLAN_A' | 'PLAN_B';
  attributed?: Record<string, unknown> | null;
  clientListed?: boolean;
  transactedAt?: Date;
  recruited?: boolean;
}) {
  const fdb = feeDb(opts.attributed ?? null, opts.clientListed ?? false, opts.recruited ?? true);
  const fee = await resolveBookingFee(fdb as any, {
    bookingIntentId: 'bi_1',
    practitionerId: Y,
    email: EMAIL,
    plan: opts.plan,
    priceUsdCents: 10_000,
    bookingCreatedAt: D(5),
    transactedAt: opts.transactedAt ?? D(5),
    referralTouchId: null,
  });
  const snapshot = fdb.snapshots[0];
  const db = commitDb(snapshot);
  const result = await commit(db);
  return { fee, snapshot, db, result, entry: db.affiliate.rows[0] as Record<string, any> | undefined };
}

describe('spec section 1: the ledger row equals the snapshot share, on every row of the table', () => {
  it('own client, recruited $100 -> $3 ledger, NHP net $0, the charge is the $3', async () => {
    const { snapshot, entry, fee } = await pipeline({ plan: 'PLAN_A', clientListed: true });
    expect(snapshot).toMatchObject({ nhpFeeUsdCents: 0, affiliateShareUsdCents: 300, nhpNetUsdCents: 0 });
    expect(fee.applicationFeeUsdCents).toBe(300);
    expect(entry).toMatchObject({
      recruiterPractitionerId: R,
      recruitedPractitionerId: Y,
      grossUsdCents: 10_000,
      bps: 300,
      shareUsdCents: 300,
      state: 'ACCRUED',
    });
    expect(entry!.shareUsdCents).toBe(snapshot.affiliateShareUsdCents);
  });

  it('Plan B sourced -> $3 ledger, $27 NHP net (a $30 fee)', async () => {
    const { snapshot, entry } = await pipeline({ plan: 'PLAN_B' });
    expect(snapshot).toMatchObject({ applicationFeeUsdCents: 3_000, nhpNetUsdCents: 2_700 });
    expect(entry!.shareUsdCents).toBe(300);
    expect(entry!.shareUsdCents).toBe(snapshot.affiliateShareUsdCents);
  });

  it('Plan A sourced -> $3 ledger, $7 NHP net (a $10 fee)', async () => {
    const { snapshot, entry } = await pipeline({ plan: 'PLAN_A' });
    expect(snapshot).toMatchObject({ applicationFeeUsdCents: 1_000, nhpNetUsdCents: 700 });
    expect(entry!.shareUsdCents).toBe(300);
  });

  it.each(['PLAN_A', 'PLAN_B'] as const)(
    'referred within 4 months, %s -> $3 ledger, NHP net $7 (the referrer’s $20 is a separate ledger)',
    async (plan) => {
      const { snapshot, entry, db } = await pipeline({
        plan,
        attributed: {
          owner: 'NHP',
          decidedAt: D(0),
          referrerPractitionerId: X,
          termAnchorAt: D(0),
          termEndsAt: D(240),
          termMonths: 8,
          referrerTermMonths: 4,
          rateScheduleId: V1.id,
        },
      });
      expect(snapshot).toMatchObject({
        referrerShareUsdCents: 2_000,
        nhpFeeUsdCents: 1_000,
        applicationFeeUsdCents: 3_000,
        affiliateShareUsdCents: 300,
        nhpNetUsdCents: 700,
      });
      expect(entry!.shareUsdCents).toBe(300);
      expect(db.referralLedger.size).toBe(1);
    },
  );

  it.each([
    ['Plan A', 'PLAN_A' as const, 1_000, 700],
    ['Plan B', 'PLAN_B' as const, 3_000, 2_700],
  ])('referred 4-8 months, %s -> $3 ledger', async (_n, plan, fee, nhpNet) => {
    const { snapshot, entry } = await pipeline({
      plan,
      transactedAt: D(5 + 150),
      attributed: {
        owner: 'NHP',
        decidedAt: D(0),
        referrerPractitionerId: X,
        termAnchorAt: D(0),
        termEndsAt: D(240),
        termMonths: 8,
        referrerTermMonths: 4,
        rateScheduleId: V1.id,
      },
    });
    expect(snapshot).toMatchObject({ applicationFeeUsdCents: fee, nhpNetUsdCents: nhpNet });
    expect(entry!.shareUsdCents).toBe(300);
  });

  it('past the 8-month term -> Y bears the $3, NHP nets $0, ledger $3', async () => {
    const { snapshot, entry } = await pipeline({
      plan: 'PLAN_B',
      attributed: {
        owner: 'NHP',
        decidedAt: D(-300),
        referrerPractitionerId: null,
        termAnchorAt: D(-300),
        termEndsAt: D(-60),
        termMonths: 8,
        rateScheduleId: V1.id,
      },
    });
    expect(snapshot).toMatchObject({ nhpFeeUsdCents: 0, applicationFeeUsdCents: 300, nhpNetUsdCents: 0 });
    expect(entry!.shareUsdCents).toBe(300);
  });

  it('not recruited: no ledger row at all', async () => {
    const { entry, result } = await pipeline({ plan: 'PLAN_A', recruited: false });
    expect(entry).toBeUndefined();
    expect(result.affiliateShareUsdCents).toBe(0);
  });

  it('lane R2: a recruiter row is payable AT PAYMENT by default (holdDays 0, holdUntil = paidAt), NOT after the 90-day referral hold', async () => {
    // `commit()` still passes the referral hold (holdDays: 90); the affiliate row must ignore it.
    const { entry } = await pipeline({ plan: 'PLAN_A' });
    expect(entry!.holdDays).toBe(0);
    expect(entry!.holdUntil.getTime()).toBe(PAID_AT.getTime());
  });

  it('snapshots the AFFILIATE hold at accrual: affiliateHoldDays sets holdDays and holdUntil = paidAt + days', async () => {
    const fdb = feeDb(null, false);
    await resolveBookingFee(fdb as any, {
      bookingIntentId: 'bi_1',
      practitionerId: Y,
      email: EMAIL,
      plan: 'PLAN_A',
      priceUsdCents: 10_000,
      bookingCreatedAt: D(5),
      transactedAt: D(5),
      referralTouchId: null,
    });
    const db = commitDb(fdb.snapshots[0]);
    await commit(db, { affiliateHoldDays: 14 });
    const row = db.affiliate.rows[0];
    expect(row.holdDays).toBe(14);
    expect(row.holdUntil.getTime()).toBe(PAID_AT.getTime() + 14 * 86_400_000);
  });

  it('the commit reports which recruiter was credited, so the caller can settle that one row', async () => {
    const { result } = await pipeline({ plan: 'PLAN_A' });
    expect(result.affiliateRecruiterPractitionerId).toBe(R);
    const none = await pipeline({ plan: 'PLAN_A', recruited: false });
    expect(none.result.affiliateRecruiterPractitionerId).toBeNull();
  });

  it('the ledger is written from the SNAPSHOT: a later schedule change cannot reprice it', async () => {
    const { snapshot } = await pipeline({ plan: 'PLAN_A' });
    // The booking was priced at 3%. Whatever the schedule says today, the row is what was decided.
    const db = commitDb({ ...snapshot, affiliateBps: 300, affiliateShareUsdCents: 300 });
    await commit(db);
    expect(db.affiliate.rows[0]).toMatchObject({ bps: 300, shareUsdCents: 300 });
    // and the commit never reads a rate schedule at all
    expect(Object.keys(db)).not.toContain('rateSchedule');
  });
});

describe('accrual is idempotent on a Whop webhook retry', () => {
  it('three deliveries of payment.succeeded leave one row, and do not reset the hold clock', async () => {
    const { snapshot } = await pipeline({ plan: 'PLAN_A' });
    const db = commitDb(snapshot);
    await commit(db);
    const first = { ...db.affiliate.rows[0] };
    await commit(db, { paidAt: new Date(PAID_AT.getTime() + 70_000) });
    await commit(db, { paidAt: new Date(PAID_AT.getTime() + 140_000) });
    expect(db.affiliate.rows).toHaveLength(1);
    expect(db.affiliate.rows[0].holdUntil).toEqual(first.holdUntil);
  });

  it('a redelivery does not walk a SETTLED row back to ACCRUED', async () => {
    const { snapshot } = await pipeline({ plan: 'PLAN_A' });
    const db = commitDb(snapshot);
    await commit(db);
    Object.assign(db.affiliate.rows[0], { state: 'SETTLED', whopTransferId: 'tr_1' });
    await commit(db);
    expect(db.affiliate.rows[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'tr_1' });
  });

  it('the APPLICATION_FEE row is written even though the affiliate step runs after it', async () => {
    const { db } = await pipeline({ plan: 'PLAN_A' });
    expect(db.feeLedger.has('APPLICATION_FEE:bi_1')).toBe(true);
  });
});

describe('accrual refuses a share the payment could not have funded', () => {
  const base = {
    priceUsdCents: 10_000,
    applicationFeeUsdCents: 1_000,
    affiliateBps: 300,
    affiliateShareUsdCents: 300,
    recruiterPractitionerId: R,
  };
  const run = (snapshot: any) => {
    const db = fakeAffiliateDb();
    return {
      db,
      promise: accrueAffiliateShare(db as any, {
        bookingIntentId: 'bi_1',
        recruitedPractitionerId: Y,
        whopPaymentId: 'pay_1',
        snapshot,
        holdDays: 90,
        paidAt: PAID_AT,
      }),
    };
  };

  it('no snapshot -> nothing is accrued (the hosted-checkout fallback pays no one)', async () => {
    const { db, promise } = run(null);
    await expect(promise).resolves.toEqual({ accrued: false, reason: 'NO_SNAPSHOT' });
    expect(db.rows).toHaveLength(0);
  });

  it('a zero or absent affiliate -> nothing', async () => {
    for (const s of [
      { ...base, affiliateShareUsdCents: 0 },
      { ...base, affiliateShareUsdCents: null },
      { ...base, recruiterPractitionerId: null },
    ]) {
      const { db, promise } = run(s);
      await expect(promise).resolves.toMatchObject({ accrued: false });
      expect(db.rows).toHaveLength(0);
    }
  });

  it('throws, and writes nothing, when the share exceeds the application fee actually collected', async () => {
    const { db, promise } = run({ ...base, applicationFeeUsdCents: 299 });
    await expect(promise).rejects.toThrow(/exceeds the application fee/);
    expect(db.rows).toHaveLength(0);
  });

  it('throws when the share exceeds the gross, or the recruiter is the serving practitioner', async () => {
    await expect(run({ ...base, priceUsdCents: 200 }).promise).rejects.toThrow(/exceeds the gross/);
    await expect(run({ ...base, recruiterPractitionerId: Y }).promise).rejects.toThrow(/own recruiter/);
  });

  it('throws on a fractional or non-positive rate rather than recording it', async () => {
    await expect(run({ ...base, affiliateBps: 0 }).promise).rejects.toThrow(/malformed/);
    await expect(run({ ...base, affiliateShareUsdCents: 2.5 }).promise).rejects.toThrow(/malformed/);
  });
});

/* ------------------------------------------------------------------------------------------ */

/** Fake for the refund path: APPLICATION_FEE row, the snapshot, an append-only fee ledger. */
function refundDb(entry: Record<string, any> | null, snapshotShare = 300) {
  const affiliate = fakeAffiliateDb({ entries: entry ? [entry] : [] });
  const ledger: Record<string, any>[] = [
    { kind: 'APPLICATION_FEE', whopPaymentId: 'pay_1', bookingIntentId: 'bi_1', dedupeKey: 'APPLICATION_FEE:bi_1' },
  ];
  return {
    affiliate,
    ledger,
    affiliateLedgerEntry: affiliate.affiliateLedgerEntry,
    affiliateBalanceAdjustment: affiliate.affiliateBalanceAdjustment,
    $transaction: affiliate.$transaction,
    bookingFeeSnapshot: {
      findUnique: async () => ({
        bookingIntentId: 'bi_1',
        priceUsdCents: 10_000,
        affiliateShareUsdCents: snapshotShare,
        recruiterPractitionerId: R,
      }),
    },
    referralLedgerEntry: { findFirst: async () => null, update: async () => ({}) },
    feeLedgerEntry: {
      upsert: async (args: any) => {
        if (!ledger.find((l) => l.dedupeKey === args.where.dedupeKey)) ledger.push({ ...args.create });
        return args.create;
      },
      findFirst: async (args: any) =>
        ledger.find((l) => l.kind === args.where.kind && l.whopPaymentId === args.where.whopPaymentId) ?? null,
      findMany: async (args: any) =>
        ledger.filter((l) => Object.entries(args.where).every(([k, v]) => l[k] === v)),
    },
  };
}

const entry = (over: Record<string, any> = {}) => ({
  id: 'afl_1',
  bookingIntentId: 'bi_1',
  recruiterPractitionerId: R,
  recruitedPractitionerId: Y,
  grossUsdCents: 10_000,
  bps: 300,
  shareUsdCents: 300,
  holdUntil: D(95),
  ...over,
});

const refund = (db: ReturnType<typeof refundDb>, dollars: number, id = 'ref_1') =>
  reverseReferralOnRefund(db as any, {
    whopPaymentId: 'pay_1',
    refundAmountUsdDollars: dollars,
    refundId: id,
    at: PAID_AT,
  });

describe('refunds reverse the affiliate ledger entry, by the same rule as the referrer', () => {
  it('a FULL refund reverses everything: reversedUsdCents = share, the unpaid row becomes REVERSED', async () => {
    const db = refundDb(entry());
    const out = await refund(db, 100);
    expect(out.affiliateReversedUsdCents).toBe(300);
    expect(db.affiliate.rows[0]).toMatchObject({ reversedUsdCents: 300, state: 'REVERSED', shareUsdCents: 300 });
  });

  it('a partial refund reverses pro rata and FLOORS: 33.33 of 100 -> 99 of 300', async () => {
    const db = refundDb(entry());
    const out = await refund(db, 33.33);
    expect(out.affiliateReversedUsdCents).toBe(99);
    expect(db.affiliate.rows[0]).toMatchObject({ reversedUsdCents: 99, state: 'ACCRUED', shareUsdCents: 300 });
  });

  it('each refund is measured against the ORIGINAL share, capped at what remains: 80% + 80% = 300, never more', async () => {
    const db = refundDb(entry());
    const a = await refund(db, 80, 'r1');
    const b = await refund(db, 80, 'r2');
    expect(a.affiliateReversedUsdCents).toBe(240);
    expect(b.affiliateReversedUsdCents).toBe(60);
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(300);
    expect(db.affiliate.rows[0].state).toBe('REVERSED');
  });

  it('a redelivered refund is a no-op: same answer, one marker, the ledger total unchanged', async () => {
    const db = refundDb(entry());
    const first = await refund(db, 50);
    const second = await refund(db, 50);
    const third = await refund(db, 50);
    expect(first.affiliateReversedUsdCents).toBe(150);
    expect(second.affiliateReversedUsdCents).toBe(150);
    expect(third.affiliateReversedUsdCents).toBe(150);
    expect(db.ledger.filter((l) => l.kind === 'AFFILIATE_REFUND_REVERSAL')).toHaveLength(1);
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(150);
  });

  it('a redelivery of an EARLIER refund after a later one does not change either amount', async () => {
    const db = refundDb(entry());
    await refund(db, 50, 'r1'); // 150
    await refund(db, 100, 'r2'); // the remaining 150
    const again = await refund(db, 50, 'r1');
    expect(again.affiliateReversedUsdCents).toBe(150);
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(300);
  });

  it('is absolute, so a crash after the marker but before the ledger write is repaired by the retry', async () => {
    const db = refundDb(entry());
    // The first delivery wrote the marker and died before touching the ledger row.
    db.ledger.push({
      kind: 'AFFILIATE_REFUND_REVERSAL',
      dedupeKey: 'AFFILIATE_REFUND_REVERSAL:ref_1:bi_1',
      bookingIntentId: 'bi_1',
      amountUsdCents: -150,
    });
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(0);
    await refund(db, 50);
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(150);
  });

  it('never negative and never above the share, whatever total it is handed', async () => {
    const db = fakeAffiliateDb({ entries: [entry()] });
    await applyAffiliateReversal(db as any, {
      bookingIntentId: 'bi_1',
      recruiterPractitionerId: R,
      totalReversedUsdCents: 9_999,
    });
    expect(db.rows[0].reversedUsdCents).toBe(300);
    // MONOTONE: an older, smaller (or nonsense) total can never lower what is stored.
    await applyAffiliateReversal(db as any, {
      bookingIntentId: 'bi_1',
      recruiterPractitionerId: R,
      totalReversedUsdCents: -50,
    });
    expect(db.rows[0].reversedUsdCents).toBe(300);
    await applyAffiliateReversal(db as any, {
      bookingIntentId: 'bi_1',
      recruiterPractitionerId: R,
      totalReversedUsdCents: 120,
    });
    expect(db.rows[0].reversedUsdCents).toBe(300);
  });

  it('a refund that arrives BEFORE the row exists writes its marker, and the row, when created, picks it up', async () => {
    const db = refundDb(null);
    const out = await refund(db, 100);
    expect(out.affiliateReversedUsdCents).toBe(300);
    expect(out.affiliateDebitRecordedUsdCents).toBe(0);
    expect(db.ledger.filter((l) => l.kind === 'AFFILIATE_REFUND_REVERSAL')).toHaveLength(1);
    expect(db.affiliate.rows).toHaveLength(0);

    // The retried payment.succeeded now creates the row.
    await accrueAffiliateShare(db as any, {
      bookingIntentId: 'bi_1',
      recruitedPractitionerId: Y,
      whopPaymentId: 'pay_1',
      snapshot: {
        priceUsdCents: 10_000,
        applicationFeeUsdCents: 300,
        nhpFeeUsdCents: 0,
        affiliateBps: 300,
        affiliateShareUsdCents: 300,
        recruiterPractitionerId: R,
      },
      holdDays: 90,
      paidAt: PAID_AT,
    });
    expect(db.affiliate.rows[0]).toMatchObject({ shareUsdCents: 300, reversedUsdCents: 300, state: 'REVERSED' });
  });

  it('a PARTIAL early refund leaves a live row for the remainder', async () => {
    const db = refundDb(null);
    await refund(db, 50);
    await accrueAffiliateShare(db as any, {
      bookingIntentId: 'bi_1',
      recruitedPractitionerId: Y,
      whopPaymentId: 'pay_1',
      snapshot: { priceUsdCents: 10_000, applicationFeeUsdCents: 300, nhpFeeUsdCents: 0, affiliateBps: 300, affiliateShareUsdCents: 300, recruiterPractitionerId: R },
      holdDays: 90,
      paidAt: PAID_AT,
    });
    expect(db.affiliate.rows[0]).toMatchObject({ reversedUsdCents: 150, state: 'ACCRUED' });
  });

  it('a zero or negative refund touches nothing', async () => {
    const db = refundDb(entry());
    const out = await refund(db, 0);
    expect(out.affiliateReversedUsdCents).toBe(0);
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(0);
  });

  it('a booking with no affiliate share reverses nothing', async () => {
    const db = refundDb(null, 0);
    const out = await refund(db, 100);
    expect(out).toMatchObject({ affiliateReversedUsdCents: 0, affiliateDebitRecordedUsdCents: 0 });
  });
});

describe('a refund after the share has left: a DEBIT against the recruiter, never a clawback (lane R2)', () => {
  const debitsOf = (db: ReturnType<typeof refundDb>) => db.affiliate.adjustments;

  it('SETTLED: a $40 refund of a $100 payment records an OPEN debit of exactly $1.20; the row stays SETTLED', async () => {
    const db = refundDb(entry({ state: 'SETTLED', transferUsdCents: 300, whopTransferId: 'tr_1' }));
    const out = await refund(db, 40);
    expect(out.affiliateReversedUsdCents).toBe(120);
    expect(out.affiliateDebitRecordedUsdCents).toBe(120);
    expect(db.affiliate.rows[0]).toMatchObject({ state: 'SETTLED', reversedUsdCents: 120, whopTransferId: 'tr_1' });
    expect(debitsOf(db)).toHaveLength(1);
    expect(debitsOf(db)[0]).toMatchObject({
      recruiterPractitionerId: R,
      sourceLedgerEntryId: 'afl_1',
      amountUsdCents: 120,
      appliedUsdCents: 0,
      state: 'OPEN',
      reason: 'REFUND',
    });
  });

  it('a redelivery of the same refund neither doubles nor changes the debit', async () => {
    const db = refundDb(entry({ state: 'SETTLED', transferUsdCents: 300 }));
    const a = await refund(db, 50);
    const b = await refund(db, 50);
    const c = await refund(db, 50);
    expect(a.affiliateDebitRecordedUsdCents).toBe(150);
    expect(b.affiliateDebitRecordedUsdCents).toBe(150);
    expect(c.affiliateDebitRecordedUsdCents).toBe(150);
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(150);
    expect(debitsOf(db)).toHaveLength(1);
    expect(debitsOf(db)[0].amountUsdCents).toBe(150);
  });

  it('two partial refunds after the payout record two debits that add up to the reversal, each exactly once', async () => {
    const db = refundDb(entry({ state: 'SETTLED', transferUsdCents: 300 }));
    await refund(db, 40, 'r1'); // 120
    await refund(db, 40, 'r2'); // 120 more
    await refund(db, 40, 'r1'); // redelivery of the first
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(240);
    expect(debitsOf(db).map((d) => d.amountUsdCents)).toEqual([120, 120]);
    expect(new Set(debitsOf(db).map((d) => d.dedupeKey)).size).toBe(2);
  });

  it('SETTLED after an earlier reversal already shrank the claim: only the NEW reversal becomes a debit', async () => {
    // 100 was reversed BEFORE the claim, so the transfer was already reduced. A further 100 now is
    // the only part of the money that has actually left and must come back.
    const db = refundDb(entry({ state: 'SETTLED', transferUsdCents: 200, reversedUsdCents: 100 }));
    db.ledger.push({
      kind: 'AFFILIATE_REFUND_REVERSAL',
      dedupeKey: 'AFFILIATE_REFUND_REVERSAL:r0:bi_1',
      bookingIntentId: 'bi_1',
      amountUsdCents: -100,
    });
    const out = await refund(db, 33.34, 'r1'); // floor(300 * 3334 / 10000) = 100
    expect(out.affiliateReversedUsdCents).toBe(100);
    expect(out.affiliateDebitRecordedUsdCents).toBe(100);
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(200);
    expect(debitsOf(db).map((d) => d.amountUsdCents)).toEqual([100]);
  });

  it('a FULL refund after payout debits the whole reversal (the share), and the row is NOT flipped to REVERSED', async () => {
    const db = refundDb(entry({ state: 'SETTLED', transferUsdCents: 291 }));
    const out = await refund(db, 100);
    expect(out.affiliateDebitRecordedUsdCents).toBe(300);
    expect(db.affiliate.rows[0]).toMatchObject({ state: 'SETTLED', reversedUsdCents: 300 });
  });

  it('SENDING (a transfer is in flight, NOT yet confirmed): the cache rises, no debit yet, never edited into REVERSED', async () => {
    // The debit for a refund in this window is written when the transfer is CONFIRMED
    // (`completeAffiliateTransfer`): if Whop refuses it the row returns to ACCRUED and the retry
    // claims the reduced amount, so a debit now would charge the recruiter twice.
    const db = refundDb(entry({ state: 'SENDING', transferUsdCents: 300, grossShareUsdCents: 300 }));
    const out = await refund(db, 100);
    expect(out.affiliateReversedUsdCents).toBe(300);
    expect(out.affiliateDebitRecordedUsdCents).toBe(0);
    expect(db.affiliate.adjustments).toHaveLength(0);
    expect(db.affiliate.rows[0].state).toBe('SENDING');
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(300);
  });

  it('a row whose whole share was already netted against earlier debits (transfer 0) still debits on a later refund', async () => {
    const db = refundDb(entry({ state: 'SETTLED', transferUsdCents: 0, adjustmentAppliedUsdCents: 300 }));
    const out = await refund(db, 20);
    expect(out.affiliateDebitRecordedUsdCents).toBe(60);
  });

  it('HELD and ACCRUED rows record no debit: nothing left the building', async () => {
    for (const state of ['ACCRUED', 'HELD']) {
      const db = refundDb(entry({ state }));
      const out = await refund(db, 50);
      expect(out.affiliateDebitRecordedUsdCents).toBe(0);
      expect(db.affiliate.rows[0].reversedUsdCents).toBe(150);
      expect(debitsOf(db)).toHaveLength(0);
    }
  });

  it('a fully reversed HELD row leaves the payable set as REVERSED', async () => {
    const db = refundDb(entry({ state: 'HELD' }));
    await refund(db, 100);
    expect(db.affiliate.rows[0].state).toBe('REVERSED');
  });

  it('a fully reversed ACCRUED row that already has debt relief applied is NOT flipped to REVERSED (the sweep re-opens the relief)', async () => {
    const db = refundDb(entry({ state: 'ACCRUED', adjustmentAppliedUsdCents: 120 }));
    await refund(db, 100);
    expect(db.affiliate.rows[0].state).toBe('ACCRUED');
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(300);
  });

  it('the cache raise and its debit are ONE transaction: a failing debit write rolls the raise back', async () => {
    const db = refundDb(entry({ state: 'SETTLED', transferUsdCents: 300 }));
    db.affiliate.affiliateBalanceAdjustment.createMany = async () => {
      throw new Error('db down');
    };
    await expect(refund(db, 40)).rejects.toThrow('db down');
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(0);
    expect(debitsOf(db)).toHaveLength(0);
  });

  it('after such a failure the redelivered refund completes it: the debit lands once', async () => {
    const db = refundDb(entry({ state: 'SETTLED', transferUsdCents: 300 }));
    const real = db.affiliate.affiliateBalanceAdjustment.createMany;
    let fail = true;
    db.affiliate.affiliateBalanceAdjustment.createMany = async (args: any) => {
      if (fail) throw new Error('db down');
      return real(args);
    };
    await expect(refund(db, 40)).rejects.toThrow('db down');
    fail = false;
    await refund(db, 40);
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(120);
    expect(debitsOf(db).map((d) => d.amountUsdCents)).toEqual([120]);
  });

  it('the dedupe key is unique per row and cumulative total: even a forced replay of the same transition writes nothing new', async () => {
    const db = refundDb(entry({ state: 'SETTLED', transferUsdCents: 300 }));
    await refund(db, 40);
    const key = debitsOf(db)[0].dedupeKey;
    expect(key).toBe('REFUND:afl_1:120');
    const res = await db.affiliate.affiliateBalanceAdjustment.createMany({
      data: [{ ...debitsOf(db)[0], id: undefined }],
      skipDuplicates: true,
    });
    expect(res.count).toBe(0);
    expect(debitsOf(db)).toHaveLength(1);
  });
});

describe('concurrent refunds after payout: exactly one debit per cache transition', () => {
  it('two refunds in flight together debit the total reversal once, however they interleave', async () => {
    const db = refundDb(entry({ state: 'SETTLED', transferUsdCents: 300 }));
    await Promise.all([refund(db, 40, 'r1'), refund(db, 40, 'r2')]);
    const total = db.affiliate.adjustments.reduce((s, d) => s + d.amountUsdCents, 0);
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(240);
    expect(total).toBe(240);
  });

  it('three refunds plus redeliveries of each in parallel never debit more than the share', async () => {
    const db = refundDb(entry({ state: 'SETTLED', transferUsdCents: 300 }));
    await Promise.all([
      refund(db, 60, 'r1'),
      refund(db, 60, 'r2'),
      refund(db, 60, 'r3'),
      refund(db, 60, 'r1'),
      refund(db, 60, 'r2'),
    ]);
    const total = db.affiliate.adjustments.reduce((s, d) => s + d.amountUsdCents, 0);
    expect(db.affiliate.rows[0].reversedUsdCents).toBeLessThanOrEqual(300);
    expect(total).toBe(db.affiliate.rows[0].reversedUsdCents);
  });
});

describe('E2E: refund first, retried payment.succeeded second, settle sends nothing', () => {
  it('a fully refunded payment whose accrual was retried is never paid', async () => {
    const { snapshot } = await pipeline({ plan: 'PLAN_A' });
    const db = commitDb(snapshot);
    // The refund webhook beat the (retried) accrual: its marker is already in the fee ledger.
    db.feeLedger.set('AFFILIATE_REFUND_REVERSAL:r1:bi_1', {
      kind: 'AFFILIATE_REFUND_REVERSAL',
      dedupeKey: 'AFFILIATE_REFUND_REVERSAL:r1:bi_1',
      bookingIntentId: 'bi_1',
      amountUsdCents: -300,
    });
    await commit(db);
    expect(db.affiliate.rows[0]).toMatchObject({ shareUsdCents: 300, reversedUsdCents: 300, state: 'REVERSED' });

    process.env.WHOP_TRANSFERS_ENABLED = 'true';
    process.env.WHOP_COMPANY_API_KEY = 'k';
    process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';
    try {
      const { settleAffiliateShares } = await import('@/lib/affiliate-payouts');
      const transfer = vi.fn(async () => ({ transferId: 'tr_x' }));
      db.affiliate.rows[0].holdUntil = new Date(0);
      const live = fakeAffiliateDb({
        practitioners: { [R]: { whopCompanyId: 'biz_R', whopPayoutsEnabled: true } },
        entries: [db.affiliate.rows[0]],
      });
      await settleAffiliateShares(live as any, { transfer, at: new Date(Date.UTC(2030, 0, 1)) });
      expect(transfer).not.toHaveBeenCalled();
    } finally {
      delete process.env.WHOP_TRANSFERS_ENABLED;
      delete process.env.WHOP_COMPANY_API_KEY;
      delete process.env.WHOP_PARENT_COMPANY_ID;
    }
  });
});

/** Pauses the FIRST ledger write that carries a reversed total, until `release()` is called. */
function pauseFirstReversalWrite(db: ReturnType<typeof refundDb>) {
  const inner = db.affiliate.affiliateLedgerEntry.updateMany;
  let reached!: () => void;
  const atWrite = new Promise<void>((r) => (reached = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let paused = false;
  db.affiliate.affiliateLedgerEntry.updateMany = async (args: any) => {
    if (!paused && args.data.reversedUsdCents !== undefined) {
      paused = true;
      reached();
      await gate;
    }
    return inner(args);
  };
  return { atWrite, release };
}

describe('two refunds interleaved never lose one, and never exceed the share', () => {
  it('the older writer, holding a smaller total, cannot overwrite the newer one', async () => {
    const db = refundDb(entry());
    const pause = pauseFirstReversalWrite(db);

    const a = refund(db, 40, 'r1'); // read a sum of 120 and is about to store it
    await pause.atWrite;
    const b = await refund(db, 40, 'r2'); // sees A's marker; 120 more; stores 240 first
    expect(b.affiliateReversedUsdCents).toBe(120);
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(240);

    pause.release(); // now A's stale write of 120 runs
    await a;
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(240);
  });

  it('two refunds in flight together: the stored total never exceeds the share', async () => {
    const db = refundDb(entry());
    await Promise.all([refund(db, 80, 'r1'), refund(db, 80, 'r2')]);
    const row = db.affiliate.rows[0];
    expect(row.reversedUsdCents).toBe(300);
    expect(row.state).toBe('REVERSED');
  });

  it('control: with the monotone clause stripped (last write wins) the same interleaving LOSES a refund', async () => {
    const db = refundDb(entry());
    const stripped = db.affiliate.affiliateLedgerEntry.updateMany;
    db.affiliate.affiliateLedgerEntry.updateMany = async (args: any) =>
      stripped(args.data.reversedUsdCents !== undefined ? { ...args, where: { id: args.where.id } } : args);
    const pause = pauseFirstReversalWrite(db);
    const a = refund(db, 40, 'r1');
    await pause.atWrite;
    await refund(db, 40, 'r2');
    pause.release();
    await a;
    expect(db.affiliate.rows[0].reversedUsdCents).toBe(120); // the lost update the guard prevents
  });
});

describe('the funding guard follows the spec: NHP’s fee when NHP charged one, else the application fee', () => {
  const run = (over: Record<string, unknown>) =>
    accrueAffiliateShare({ ...fakeAffiliateDb(), feeLedgerEntry: { findMany: async () => [] } } as any, {
      bookingIntentId: 'bi_1',
      recruitedPractitionerId: Y,
      whopPaymentId: 'pay_1',
      snapshot: {
        priceUsdCents: 10_000,
        applicationFeeUsdCents: 3_000,
        nhpFeeUsdCents: 1_000,
        affiliateBps: 300,
        affiliateShareUsdCents: 300,
        recruiterPractitionerId: R,
        ...over,
      } as any,
      holdDays: 90,
      paidAt: PAID_AT,
    } as any);

  it('a referred session: appFee 3000 = NHP 1000 + referrer 2000; a corrupt 2500 share passes the old bound and fails this one', async () => {
    await expect(run({ affiliateShareUsdCents: 2_500 })).rejects.toThrow(/exceeds NHP's fee/);
    await expect(run({ affiliateShareUsdCents: 1_001 })).rejects.toThrow(/exceeds NHP's fee/);
    await expect(run({ affiliateShareUsdCents: 1_000 })).resolves.toMatchObject({ accrued: true });
  });

  it('no NHP fee: bounded by the application fee, which is the share itself', async () => {
    await expect(run({ nhpFeeUsdCents: 0, applicationFeeUsdCents: 300 })).resolves.toMatchObject({ accrued: true });
    await expect(run({ nhpFeeUsdCents: 0, applicationFeeUsdCents: 299 })).rejects.toThrow(/application fee/);
  });
});
