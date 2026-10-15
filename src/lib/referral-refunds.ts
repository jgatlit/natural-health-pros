/**
 * REFUNDS (spec v1.4 §6.2, §9 test 17).
 *
 * Whop reverses the APPLICATION FEE itself, proportionally — that half needs no code from us. The
 * referrer's share does: it is a separate object settled onto a separate account by a separate
 * transfer, and it does not auto-reverse.
 *
 * The behaviour splits on one question — has a transfer been CLAIMED for the share yet?
 *
 *   NOT CLAIMED  The debt is still a proposal. Reduce it (`reversedUsdCents` rises); the transfer,
 *                when it is made, is smaller or is never sent.
 *   CLAIMED      The amount to transfer is fixed and may already be in the payee's Whop balance.
 *                Nothing is pulled back out of a third party's account: the refund is booked, in the
 *                same transaction as the reduction, as a debit against the payee that the NEXT
 *                transfer to them nets off (`ledger-reversal.ts`).
 *
 * SPEC v1.5 §1: A REFUND ALSO REVERSES THE AFFILIATE SHARE. The recruiter's 3% (O7) is carried on the
 * booking's `BookingFeeSnapshot` (`affiliateShareUsdCents`, `recruiterPractitionerId`) and recorded
 * on the `AffiliateLedgerEntry` (lane L2b). The reversal uses the SAME rule as the referrer's:
 * floor(original x refund / gross), measured against the ORIGINAL share, capped at what remains,
 * a redelivery a no-op. It is written twice, on purpose:
 *
 *   1. as an append-only negative `FeeLedgerEntry` (`AFFILIATE_REFUND_REVERSAL`) keyed on the
 *      refund: the audit trail and the idempotency marker;
 *   2. onto the ledger row as an ABSOLUTE `reversedUsdCents` (the sum of those entries), never an
 *      increment, so replaying a refund, or repairing a crash between the two writes, cannot
 *      double-count.
 *
 * The snapshot and the ledger's `shareUsdCents` are never edited: they are the record of what was
 * decided at mint.
 *
 * A REFUND AFTER THE RECRUITER'S TRANSFER WAS CLAIMED is not a flag for a human: the reversal is
 * recorded in the same transaction as an `AffiliateBalanceAdjustment` DEBIT against the recruiter,
 * which the next transfer nets off (nothing is clawed back by transfer, and the recruiter sees an
 * "adjusted for a refund" line). The referrer's half works the same way with a
 * `ReferralBalanceAdjustment`.
 *
 * ⚠️ WHOP SENDS REFUND AMOUNTS IN DOLLARS. The SDK's own type says so in as many words: "The
 * refunded amount as a decimal in the specified currency, such as 10.43 for $10.43 USD"
 * (`RefundCreatedWebhookEvent.Data.amount`). Read as cents, a full refund would look like a 1%
 * refund and the referrer would keep their whole share on a session the client got back in full.
 */

import { proRataShare } from './referral-fees';
import { syncAffiliateReversalFromMarkers, type AffiliateReversalDb } from './affiliate-ledger';
import { REFERRAL_LEDGER } from './ledger-config';
import { applyLedgerReversal, type ReversalDb } from './ledger-reversal';

export type RefundDb = AffiliateReversalDb & {
  referralBalanceAdjustment: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createMany(args: any): Promise<{ count: number }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any[]>;
  };
  /** Resolves a payment to its booking, for the affiliate half (the snapshot is keyed on booking). */
  bookingFeeSnapshot: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique(args: any): Promise<any>;
  };
  referralLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany(args: any): Promise<{ count: number }>;
  };
  feeLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any[]>;
  };
};

export type RefundOutcome = {
  /** The referrer's share reversed by this refund. 0 when none was owed. */
  reversedUsdCents: number;
  /**
   * Of the referrer's share, what had ALREADY been claimed for transfer: the total debit now
   * recorded against the referrer for this payment. Netted off their next transfer, never clawed
   * back. Stable across redeliveries.
   */
  referrerDebitRecordedUsdCents: number;
  matched: boolean;
  /** The recruiter's share reversed by this refund (spec v1.5). 0 when none was owed. */
  affiliateReversedUsdCents: number;
  /**
   * Of the recruiter's share, what had ALREADY been paid out: the total debit now recorded against
   * the recruiter for this booking. Netted off their next payouts, never clawed back. Stable across
   * redeliveries.
   */
  affiliateDebitRecordedUsdCents: number;
};

/**
 * Reverse BOTH third-party shares for a refund: the referrer's and the recruiting affiliate's.
 * Each half is independent — a payment with no referrer can still owe an affiliate reversal and
 * vice versa — and each is idempotent on the refund id (Whop redelivers).
 */
export async function reverseReferralOnRefund(
  db: RefundDb,
  input: {
    whopPaymentId: string;
    /** DOLLARS, as Whop sends it. See the module docstring. */
    refundAmountUsdDollars: number;
    refundId: string;
    at: Date;
  },
): Promise<RefundOutcome> {
  const referrer = await reverseReferrerShare(db, input);
  const affiliate = await reverseAffiliateShare(db, input);
  return { ...referrer, ...affiliate };
}

/**
 * The affiliate half. Looks the payment up through the APPLICATION_FEE ledger row (the one record
 * that carries both the payment id and the booking), reads the snapshot's affiliate share, and
 * appends a negative reversal entry. Capped at what is still un-reversed, so several partial
 * refunds can never reverse more than the share that was owed.
 */
async function reverseAffiliateShare(
  db: RefundDb,
  input: { whopPaymentId: string; refundAmountUsdDollars: number; refundId: string },
): Promise<{ affiliateReversedUsdCents: number; affiliateDebitRecordedUsdCents: number }> {
  const none = { affiliateReversedUsdCents: 0, affiliateDebitRecordedUsdCents: 0 };
  if (!(input.refundAmountUsdDollars > 0)) return none;

  const fee = (await db.feeLedgerEntry.findFirst({
    where: { kind: 'APPLICATION_FEE', whopPaymentId: input.whopPaymentId },
    select: { bookingIntentId: true },
  })) as { bookingIntentId: string | null } | null;
  if (!fee?.bookingIntentId) return none;

  const snapshot = (await db.bookingFeeSnapshot.findUnique({
    where: { bookingIntentId: fee.bookingIntentId },
    select: {
      priceUsdCents: true,
      affiliateShareUsdCents: true,
      recruiterPractitionerId: true,
      bookingIntentId: true,
    },
  })) as {
    priceUsdCents: number;
    affiliateShareUsdCents: number | null;
    recruiterPractitionerId: string | null;
    bookingIntentId: string;
  } | null;
  const owed = snapshot?.affiliateShareUsdCents ?? 0;
  if (!snapshot || owed <= 0 || !snapshot.recruiterPractitionerId) return none;

  const dedupeKey = `AFFILIATE_REFUND_REVERSAL:${input.refundId}:${snapshot.bookingIntentId}`;
  const prior = (await db.feeLedgerEntry.findMany({
    where: { kind: 'AFFILIATE_REFUND_REVERSAL', bookingIntentId: snapshot.bookingIntentId },
    select: { dedupeKey: true, amountUsdCents: true },
  })) as Array<{ dedupeKey: string; amountUsdCents: number }>;
  // Entries are NEGATIVE. This refund's own row (on a redelivery) is excluded from the running
  // total so the refund is always measured against the reversals that PRECEDED it.
  const alreadyReversed = prior
    .filter((e) => e.dedupeKey !== dedupeKey)
    .reduce((sum, e) => sum - e.amountUsdCents, 0);
  const mine = prior.find((e) => e.dedupeKey === dedupeKey);

  let reversal: number;
  if (mine) {
    // REDELIVERY: answered from the entry that already exists, which is also immune to a LATER
    // refund having changed what "remaining" looks like. The marker is not rewritten.
    reversal = -mine.amountUsdCents;
  } else {
    const refundUsdCents = Math.round(input.refundAmountUsdDollars * 100);
    reversal = Math.min(owed - alreadyReversed, proRataShare(owed, refundUsdCents, snapshot.priceUsdCents));
    if (reversal <= 0) return none;

    await db.feeLedgerEntry.upsert({
      where: { dedupeKey },
      create: {
        dedupeKey,
        kind: 'AFFILIATE_REFUND_REVERSAL',
        status: 'SETTLED',
        bookingIntentId: snapshot.bookingIntentId,
        practitionerId: null,
        counterpartyPractitionerId: snapshot.recruiterPractitionerId,
        amountUsdCents: -reversal,
        whopPaymentId: input.whopPaymentId,
        note:
          'Recruiting-affiliate share reduced by a refund. Applied to the booking’s ' +
          'AffiliateLedgerEntry as an absolute reversedUsdCents; if that share had already been ' +
          'paid out, the amount owed back is recorded and flagged, never clawed back automatically.',
      },
      update: {},
    });
  }

  // Applied on EVERY delivery, redeliveries included, from the marker SUM re-read AFTER this
  // delivery's own marker is in. Two refunds arriving together each read the markers before the
  // other's upsert if they compute from the earlier read; re-reading here means the later of the
  // two sees both, and the write itself is monotone (see `applyAffiliateReversal`), so the earlier
  // one cannot then overwrite it downwards. It also repairs a crash between the marker and the row.
  const applied = await syncAffiliateReversalFromMarkers(db, {
    bookingIntentId: snapshot.bookingIntentId,
    recruiterPractitionerId: snapshot.recruiterPractitionerId,
  });
  return {
    affiliateReversedUsdCents: reversal,
    affiliateDebitRecordedUsdCents: applied.debitRecordedUsdCents,
  };
}

async function reverseReferrerShare(
  db: RefundDb,
  input: {
    whopPaymentId: string;
    /** DOLLARS, as Whop sends it. See the module docstring. */
    refundAmountUsdDollars: number;
    refundId: string;
    at: Date;
  },
): Promise<Omit<RefundOutcome, 'affiliateReversedUsdCents' | 'affiliateDebitRecordedUsdCents'>> {
  const none = { reversedUsdCents: 0, referrerDebitRecordedUsdCents: 0, matched: false };
  if (!(input.refundAmountUsdDollars > 0)) return none;

  const row = (await db.referralLedgerEntry.findFirst({
    where: { whopPaymentId: input.whopPaymentId },
    select: {
      id: true,
      bookingIntentId: true,
      grossUsdCents: true,
      referrerShareUsdCents: true,
      referrerPractitionerId: true,
      servingPractitionerId: true,
    },
  })) as {
    id: string;
    bookingIntentId: string;
    grossUsdCents: number;
    referrerShareUsdCents: number;
    referrerPractitionerId: string;
    servingPractitionerId: string;
  } | null;

  // Most refunds are of payments that owed nobody a referral share. Silence is the right answer.
  if (!row || row.referrerShareUsdCents <= 0) return none;

  const refundUsdCents = Math.round(input.refundAmountUsdDollars * 100);
  const dedupeKey = `REFUND_REVERSAL:${input.refundId}:${row.id}`;

  // THE ARITHMETIC RULE (also stated on `proRataShare`):
  //   - every refund is measured against the ORIGINAL share, never against whatever is left. Measured
  //     against the remainder, two 50% refunds of a fully refunded payment reversed 50% + 25% = 75%.
  //   - each refund reverses floor(original x refund / gross), CAPPED at what is still un-reversed, so
  //     the total can never exceed the share (never an over-reversal), and the shortfall against exact
  //     pro-rata is under one cent per refund event (floor), always in the payee's favour.
  //   - a refund of the whole payment (>= gross) reverses everything that remains.
  // The share on the row is never edited, so the original is always `referrerShareUsdCents`.
  const prior = (await db.feeLedgerEntry.findMany({
    where: { kind: 'REFUND_REVERSAL', whopPaymentId: input.whopPaymentId },
    select: { dedupeKey: true, amountUsdCents: true },
  })) as Array<{ dedupeKey: string; amountUsdCents: number }>;

  // REDELIVERY: Whop sends the same refund 3x. A refund whose marker already exists is answered from
  // that marker and writes no second one.
  const mine = prior.find((e) => e.dedupeKey === dedupeKey);
  let reversal: number;
  if (mine) {
    reversal = -mine.amountUsdCents;
  } else {
    const alreadyReversed = prior.reduce((sum, e) => sum - e.amountUsdCents, 0);
    const remaining = row.referrerShareUsdCents - alreadyReversed;
    reversal = Math.min(remaining, proRataShare(row.referrerShareUsdCents, refundUsdCents, row.grossUsdCents));
    if (reversal <= 0) return none;

    await db.feeLedgerEntry.upsert({
      where: { dedupeKey },
      create: {
        dedupeKey,
        kind: 'REFUND_REVERSAL',
        status: 'SETTLED',
        bookingIntentId: null,
        practitionerId: row.servingPractitionerId,
        counterpartyPractitionerId: row.referrerPractitionerId,
        // NEGATIVE. The ledger is append-only, so a reversal is an entry with the opposite sign
        // rather than an edit to the entry it reverses.
        amountUsdCents: -reversal,
        whopPaymentId: input.whopPaymentId,
        note:
          'Referrer share reduced by a refund. Applied to the ReferralLedgerEntry as an absolute ' +
          'reversedUsdCents; if a transfer had already been claimed for the share, the amount is ' +
          'recorded as a debit against the referrer and netted off their next transfer.',
      },
      update: {},
    });
  }

  // Applied on EVERY delivery, redeliveries included, from the marker SUM re-read AFTER this
  // delivery's own marker is in: two refunds arriving together each see both markers, and the write
  // is monotone, so the earlier one cannot overwrite the later one downwards. It also repairs a
  // crash between the marker and the row.
  const applied = await syncReferralReversalFromMarkers(db as unknown as Pick<RefundDb, 'feeLedgerEntry'> & ReversalDb, {
    whopPaymentId: input.whopPaymentId,
    bookingIntentId: row.bookingIntentId,
    referrerPractitionerId: row.referrerPractitionerId,
  });
  return { reversedUsdCents: reversal, referrerDebitRecordedUsdCents: applied.debitRecordedUsdCents, matched: true };
}

/** Bring the referral ledger row up to the SUM of every `REFUND_REVERSAL` marker for the payment. */
export async function syncReferralReversalFromMarkers(
  db: Pick<RefundDb, 'feeLedgerEntry'> & ReversalDb,
  input: { whopPaymentId: string; bookingIntentId: string; referrerPractitionerId: string },
): Promise<{ found: boolean; debitRecordedUsdCents: number }> {
  const markers = (await db.feeLedgerEntry.findMany({
    where: { kind: 'REFUND_REVERSAL', whopPaymentId: input.whopPaymentId },
    select: { amountUsdCents: true },
  })) as Array<{ amountUsdCents: number }>;
  // Entries are NEGATIVE.
  const total = markers.reduce((sum, m) => sum - m.amountUsdCents, 0);
  if (total <= 0) return { found: true, debitRecordedUsdCents: 0 };
  return applyLedgerReversal(db, REFERRAL_LEDGER, {
    bookingIntentId: input.bookingIntentId,
    payeeId: input.referrerPractitionerId,
    totalReversedUsdCents: total,
  });
}
