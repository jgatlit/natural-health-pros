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
 * `affiliate-payouts.ts`, behind `WHOP_TRANSFERS_ENABLED`.
 *
 * TIMING (lane R2, operator ruling 2026-10-14): a recruiter is paid as each client payment comes
 * in, so a new row's `holdUntil` = paidAt + `affiliate_hold_days` (default 0), snapshotted on the
 * row. This is NOT the client-referral hold (`referral_hold_days`, 90), which is a different
 * setting on a different ledger and is untouched.
 *
 * REFUND AFTER THE RECRUITER WAS PAID (same ruling): the money is never clawed back by transfer.
 * The amount becomes an `AffiliateBalanceAdjustment` debit against the recruiter, netted off their
 * next payable shares by `affiliate-payouts.ts`. See `applyAffiliateReversal`.
 */

/**
 * `paidAt + days`, days >= 0. Unlike `holdExpiry` (the referral hold, which rejects 0), zero is the
 * DEFAULT here: the row is payable the instant the payment is.
 */
export function affiliateHoldExpiry(from: Date, holdDays: number): Date {
  if (!Number.isInteger(holdDays) || holdDays < 0) {
    throw new Error(`affiliate holdDays must be a non-negative integer (got ${holdDays})`);
  }
  return new Date(from.getTime() + holdDays * 86_400_000);
}

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
 * Record the recruiter's share of one payment. Create-only: a redelivery must not reset a hold
 * clock that is already running, nor walk a row that has SETTLED back to ACCRUED.
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
    /** `affiliate_hold_days` (0 = payable at once). NOT the client-referral hold. */
    holdDays: number;
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
      holdDays: input.holdDays,
      holdUntil: affiliateHoldExpiry(input.paidAt, input.holdDays),
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

/** A reversal that keeps losing its compare-and-swap race is reported, never spun on forever. */
const MAX_REVERSAL_ATTEMPTS = 8;

/**
 * Apply the refund-reversal total for one booking to its ledger row.
 *
 * `totalReversedUsdCents` is the SUM of every append-only `AFFILIATE_REFUND_REVERSAL` entry for the
 * booking, written ABSOLUTELY and MONOTONICALLY (never an increment, never downwards). That is what
 * makes a redelivered refund (or a crash between the fee-ledger write and this one, repaired by
 * the retry) harmless, and what keeps two interleaved refunds from losing one.
 *
 * REFUND AFTER PAYOUT = A DEBIT, NOT A FLAG (lane R2). The cache raise is a compare-and-swap on
 * (state, reversedUsdCents) inside a transaction. If the row is SETTLED at that instant the money
 * has left, so the SAME transaction records an `AffiliateBalanceAdjustment` of exactly the amount
 * the cache rose by. (A row that is SENDING is not yet confirmed paid; the debit for a refund that
 * lands in that window is written by `completeAffiliateTransfer` when the transfer is confirmed.)
 * Why this shape:
 *
 *   - ONE DEBIT PER TRANSITION. Every cache transition is won by exactly one writer (the CAS), so
 *     two concurrent refunds, or a refund racing a redelivery, can neither both debit the same
 *     cents nor lose one. A redelivery finds total <= cache, transitions nothing, debits nothing.
 *   - ATOMIC. A crash between "cache raised" and "debit written" is impossible: it is one
 *     transaction, so the retry either finds nothing done or finds everything done.
 *   - CLAIM-AWARE. The settle claim is itself a CAS on (state, reversedUsdCents), so a refund that
 *     lands before the claim shrinks the amount claimed (no debit), and one that lands after it
 *     becomes a debit. There is no interleaving where it is neither.
 *   - `dedupeKey` (REFUND:<row>:<cumulative reversed>) is the database-level backstop: the same
 *     transition cannot be recorded twice even if the logic above were wrong.
 *
 * Returns the TOTAL debit recorded against this booking's ledger row so far (stable across
 * redeliveries), 0 when nothing had been paid out. Nothing is ever sent back by transfer.
 */
export async function applyAffiliateReversal(
  db: AffiliateReversalDb,
  input: { bookingIntentId: string; recruiterPractitionerId: string; totalReversedUsdCents: number },
): Promise<{ found: boolean; debitRecordedUsdCents: number }> {
  const key = {
    bookingIntentId_recruiterPractitionerId: {
      bookingIntentId: input.bookingIntentId,
      recruiterPractitionerId: input.recruiterPractitionerId,
    },
  };

  type Row = { id: string; state: string; shareUsdCents: number; reversedUsdCents: number };

  for (let attempt = 0; attempt < MAX_REVERSAL_ATTEMPTS; attempt += 1) {
    const row = (await db.affiliateLedgerEntry.findUnique({
      where: key,
      select: { id: true, state: true, shareUsdCents: true, reversedUsdCents: true },
    })) as Row | null;
    if (!row) return { found: false, debitRecordedUsdCents: 0 };

    // Never above the share, never negative.
    const total = Math.max(0, Math.min(input.totalReversedUsdCents, row.shareUsdCents));
    // MONOTONE: only ever raises the stored total. Markers are append-only, so the true total never
    // falls; a stale writer holding an older, smaller sum therefore changes nothing.
    if (total <= row.reversedUsdCents) break;

    const delta = total - row.reversedUsdCents;
    // Only SETTLED is CONFIRMED paid (it includes a row whose whole share was netted against earlier
    // debits). A SENDING row is in doubt: if Whop then refuses the transfer the row returns to
    // ACCRUED and the retry claims the reduced amount, so a debit written now would charge the
    // recruiter twice. The refund is still captured: it raises the cache here, and
    // `completeAffiliateTransfer` turns whatever rose since the claim into a debit the moment the
    // transfer is confirmed.
    const paidOut = row.state === 'SETTLED';

    const won = await db.$transaction(async (tx) => {
      const moved = await tx.affiliateLedgerEntry.updateMany({
        // The CAS: the row must still be in the state and at the total we read. A settle claim, a
        // payout, or another refund in between makes this miss, and we re-read.
        where: { id: row.id, state: row.state, reversedUsdCents: row.reversedUsdCents },
        data: { reversedUsdCents: total },
      });
      if (moved.count === 0) return false;
      if (paidOut) {
        await tx.affiliateBalanceAdjustment.createMany({
          data: [
            {
              recruiterPractitionerId: input.recruiterPractitionerId,
              sourceLedgerEntryId: row.id,
              amountUsdCents: delta,
              appliedUsdCents: 0,
              state: 'OPEN',
              reason: 'REFUND',
              dedupeKey: `REFUND:${row.id}:${total}`,
            },
          ],
          skipDuplicates: true,
        });
      }
      return true;
    });
    if (won) break;
    if (attempt === MAX_REVERSAL_ATTEMPTS - 1) {
      // Loud, not silent: the marker is durable, so the next delivery or sweep repairs it, but the
      // cache is behind the markers until then.
      throw new Error(
        `affiliate reversal for ledger row ${row.id} lost its compare-and-swap ${MAX_REVERSAL_ATTEMPTS} times`,
      );
    }
  }

  // An unpaid row that is now fully reversed owes nothing and leaves the payable set. Guarded on
  // the unpaid states so it can never overwrite SENDING / SETTLED, and on there being no debt
  // relief already applied to it (that case is settled by the payout sweep, which turns the relief
  // back into a debit; see `settleAffiliateShares`).
  const after = (await db.affiliateLedgerEntry.findUnique({
    where: key,
    select: { id: true, state: true, shareUsdCents: true, reversedUsdCents: true, adjustmentAppliedUsdCents: true },
  })) as {
    id: string;
    state: string;
    shareUsdCents: number;
    reversedUsdCents: number;
    adjustmentAppliedUsdCents: number | null;
  } | null;
  if (!after) return { found: false, debitRecordedUsdCents: 0 };
  if (
    after.reversedUsdCents >= after.shareUsdCents &&
    (after.state === 'ACCRUED' || after.state === 'HELD') &&
    !(after.adjustmentAppliedUsdCents ?? 0)
  ) {
    await db.affiliateLedgerEntry.updateMany({
      where: { id: after.id, state: { in: ['ACCRUED', 'HELD'] } },
      data: { state: 'REVERSED' },
    });
  }

  const debits = (await db.affiliateBalanceAdjustment.findMany({
    where: { sourceLedgerEntryId: after.id },
    select: { amountUsdCents: true },
  })) as Array<{ amountUsdCents: number }>;
  return { found: true, debitRecordedUsdCents: debits.reduce((sum, d) => sum + d.amountUsdCents, 0) };
}
