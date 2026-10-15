/**
 * THE RECRUITING-AFFILIATE LEDGER (spec v1.5 section 5, operator ruling O7).
 *
 * Mirrors `ReferralLedgerEntry` / `commitPaymentAttribution`'s referral half, with one deliberate
 * difference in what it trusts: the amount and the payee come from the booking's
 * `BookingFeeSnapshot` ALONE. The affiliate overlay in `resolveSessionFee` already decided the
 * share at mint (floor(gross x affiliateBps), funded from NHP's fee when there is one, otherwise
 * added to the application fee), so nothing here recomputes it from the CURRENT rate schedule. A
 * schedule edit must never reprice a payment that has already been taken.
 *
 * Every write is keyed on a unique constraint. Whop redelivers `payment.succeeded`, and a second
 * row is a second payout; the database refuses it instead of the handler remembering to check.
 *
 * NO MONEY MOVES HERE. This file records debts, and applies refunds to them. Paying is
 * `affiliate-payouts.ts` / `ledger-transfer.ts`, behind `WHOP_TRANSFERS_ENABLED`.
 *
 * TIMING (operator ruling 2026-10-14): a recruiter is paid as each client payment clears, so a new
 * row is created ACCRUED with `holdDays` 0 and `holdUntil` = the payment instant, and the payment
 * webhook settles it right after it is written.
 *
 * REFUND AFTER A TRANSFER WAS CLAIMED: the money is never clawed back by transfer. The amount
 * becomes an `AffiliateBalanceAdjustment` debit against the recruiter, netted off their next
 * transfer by `ledger-transfer.ts`. See `ledger-reversal.ts`.
 */

import { AFFILIATE_LEDGER } from './ledger-config';
import { applyLedgerReversal, type ReversalDb } from './ledger-reversal';

export type AffiliateAccrualDb = AffiliateReversalDb & {
  affiliateLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(args: any): Promise<any>;
  };
  /** Read for the refund markers that may have arrived BEFORE this row existed. */
  feeLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any[]>;
  };
};

export type AffiliateSnapshot = {
  priceUsdCents: number;
  applicationFeeUsdCents: number;
  /** NHP's own fee on this payment. When absent (older callers) the funding check falls back to the application fee. */
  nhpFeeUsdCents?: number | null;
  affiliateBps: number | null;
  affiliateShareUsdCents: number | null;
  recruiterPractitionerId: string | null;
} | null;

export type AccrualResult =
  | { accrued: true; shareUsdCents: number; recruiterPractitionerId: string }
  | { accrued: false; reason: 'NO_SNAPSHOT' | 'NO_AFFILIATE' };

/**
 * Record the recruiter's share of one payment. Create-only: a redelivery must not walk a row that
 * has SETTLED or is SENDING back to ACCRUED.
 *
 * Throws (so the webhook reports it on /admin/whop-webhooks) when the snapshot describes a share
 * that could not have been collected from this payment. Paying out money Whop never took is the
 * failure this guards, and it is far cheaper to refuse a row than to claw one back.
 */
export async function accrueAffiliateShare(
  db: AffiliateAccrualDb,
  input: {
    bookingIntentId: string;
    /** The practitioner who served the client, the one the recruiter brought in. */
    recruitedPractitionerId: string;
    whopPaymentId: string | null;
    snapshot: AffiliateSnapshot;
    paidAt: Date;
  },
): Promise<AccrualResult> {
  const snap = input.snapshot;
  // A missing snapshot is reachable (hosted-checkout fallback mints none). The amount defaults to
  // NOTHING: a share we cannot prove Whop collected must never become a payable debt.
  if (!snap) return { accrued: false, reason: 'NO_SNAPSHOT' };

  const share = snap.affiliateShareUsdCents ?? 0;
  const recruiterId = snap.recruiterPractitionerId;
  if (!recruiterId || share <= 0) return { accrued: false, reason: 'NO_AFFILIATE' };

  if (recruiterId === input.recruitedPractitionerId) {
    throw new Error('affiliate snapshot names the serving practitioner as their own recruiter');
  }
  const bps = snap.affiliateBps;
  if (!Number.isInteger(share) || !Number.isInteger(bps) || (bps as number) <= 0) {
    throw new Error(`affiliate snapshot is malformed (share=${share}, bps=${bps})`);
  }
  if (share > snap.priceUsdCents) {
    throw new Error(`affiliate share ${share} exceeds the gross payment ${snap.priceUsdCents}`);
  }
  // The share is funded from the SAME transaction, and the spec says from WHERE: out of NHP's fee
  // when NHP charged one (so the share cannot exceed it, whatever a referrer's separate share adds
  // to the total collected), otherwise added to the application fee (so it is bounded by that).
  // Anything larger means the parent would be paying a recruiter out of pocket.
  const nhpFee = snap.nhpFeeUsdCents ?? 0;
  const fundingCeiling = nhpFee > 0 ? nhpFee : snap.applicationFeeUsdCents;
  if (share > fundingCeiling) {
    throw new Error(
      nhpFee > 0
        ? `affiliate share ${share} exceeds NHP's fee on this payment (${nhpFee}), which is what funds it`
        : `affiliate share ${share} exceeds the application fee actually collected (${snap.applicationFeeUsdCents})`,
    );
  }

  await db.affiliateLedgerEntry.upsert({
    where: {
      bookingIntentId_recruiterPractitionerId: {
        bookingIntentId: input.bookingIntentId,
        recruiterPractitionerId: recruiterId,
      },
    },
    create: {
      bookingIntentId: input.bookingIntentId,
      whopPaymentId: input.whopPaymentId,
      recruiterPractitionerId: recruiterId,
      recruitedPractitionerId: input.recruitedPractitionerId,
      grossUsdCents: snap.priceUsdCents,
      bps: bps as number,
      shareUsdCents: share,
      grossShareUsdCents: share,
      state: 'ACCRUED',
      holdDays: 0,
      holdUntil: input.paidAt,
    },
    update: {},
  });

  // A REFUND CAN BEAT THE ROW HERE. Accrual runs last in the payment commit and can throw (a
  // refused share) after the APPLICATION_FEE row is already committed; a refund webhook then finds
  // the booking and writes its audit marker, and the retried payment.succeeded creates a row that
  // has never heard of it. Applied on EVERY delivery, to a new row or an existing one: the sync is
  // monotone and idempotent, so the cost of a redelivery is one read.
  await syncAffiliateReversalFromMarkers(db, {
    bookingIntentId: input.bookingIntentId,
    recruiterPractitionerId: recruiterId,
  });
  return { accrued: true, shareUsdCents: share, recruiterPractitionerId: recruiterId };
}


/**
 * Bring the ledger row up to the SUM of every `AFFILIATE_REFUND_REVERSAL` marker for the booking.
 *
 * The markers are append-only and are the truth; the row's `reversedUsdCents` is a cache of their
 * sum. Reading the whole set (rather than trusting a total computed before this delivery's own
 * write) is what lets two concurrent refunds both land: whichever runs second sees both markers.
 * A no-op when nothing has been reversed.
 */
export async function syncAffiliateReversalFromMarkers(
  db: AffiliateReversalDb & Pick<AffiliateAccrualDb, 'feeLedgerEntry'>,
  input: { bookingIntentId: string; recruiterPractitionerId: string },
): Promise<{ found: boolean; debitRecordedUsdCents: number; totalReversedUsdCents: number }> {
  const markers = (await db.feeLedgerEntry.findMany({
    where: { kind: 'AFFILIATE_REFUND_REVERSAL', bookingIntentId: input.bookingIntentId },
    select: { amountUsdCents: true },
  })) as Array<{ amountUsdCents: number }>;
  // Entries are NEGATIVE.
  const total = markers.reduce((sum, m) => sum - m.amountUsdCents, 0);
  if (total <= 0) return { found: true, debitRecordedUsdCents: 0, totalReversedUsdCents: 0 };
  const applied = await applyAffiliateReversal(db, {
    bookingIntentId: input.bookingIntentId,
    recruiterPractitionerId: input.recruiterPractitionerId,
    totalReversedUsdCents: total,
  });
  return { ...applied, totalReversedUsdCents: total };
}

/** The writes a reversal makes: the ledger row, and (for a share already paid) a debit. */
export type AffiliateReversalTx = {
  affiliateLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany(args: any): Promise<{ count: number }>;
  };
  affiliateBalanceAdjustment: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createMany(args: any): Promise<{ count: number }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any[]>;
  };
};

export type AffiliateReversalDb = AffiliateReversalTx & {
  /** Interactive transaction: all-or-nothing, so the cache raise and its debit cannot part ways. */
  $transaction<T>(fn: (tx: AffiliateReversalTx) => Promise<T>): Promise<T>;
};

/**
 * Apply the refund-reversal total for one booking to its ledger row. A refund before a transfer was
 * claimed reduces the share; a refund after one books a debit against the recruiter that the next
 * transfer nets off. See `ledger-reversal.ts` for the compare-and-swap that makes each interleaving
 * resolve exactly one way.
 *
 * Returns the TOTAL debit recorded against this booking's ledger row so far (stable across
 * redeliveries), 0 when nothing had been claimed. Nothing is ever sent back by transfer.
 */
export function applyAffiliateReversal(
  db: AffiliateReversalDb,
  input: { bookingIntentId: string; recruiterPractitionerId: string; totalReversedUsdCents: number },
): Promise<{ found: boolean; debitRecordedUsdCents: number }> {
  return applyLedgerReversal(db as unknown as ReversalDb, AFFILIATE_LEDGER, {
    bookingIntentId: input.bookingIntentId,
    payeeId: input.recruiterPractitionerId,
    totalReversedUsdCents: input.totalReversedUsdCents,
  });
}
