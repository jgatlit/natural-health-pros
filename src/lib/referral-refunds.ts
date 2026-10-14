/**
 * REFUNDS (spec v1.4 §6.2, §9 test 17).
 *
 * Whop reverses the APPLICATION FEE itself, proportionally — that half needs no code from us. The
 * referrer's share does: it is a separate object settled onto a separate account by a separate
 * transfer, and it does not auto-reverse.
 *
 * The behaviour splits on one question — has it been paid out yet?
 *
 *   NOT YET PAID (PAYABLE / HELD) — the debt is still a proposal. Reduce it; nothing has moved.
 *   ALREADY PAID (SETTLED)        — the money is in the referrer's own Whop account. Recovering it
 *                                   means pulling funds back OUT of a third party's account, and
 *                                   that is NEVER done automatically here. It is recorded as a
 *                                   recovery owed, for a human. Whop's child → parent direction is
 *                                   structurally permitted (probed) but needs that child to be
 *                                   holding a balance at the time, so even the mechanism is not
 *                                   guaranteed — let alone the judgement.
 *
 * SPEC v1.5 §1: A REFUND ALSO REVERSES THE AFFILIATE SHARE. The recruiter's 3% (O7) is carried on the
 * booking's `BookingFeeSnapshot` (`affiliateShareUsdCents`, `recruiterPractitionerId`); the
 * affiliate LEDGER (`AffiliateLedgerEntry`) arrives with lane L2b and does not exist yet. Until it
 * does the reversal is recorded as an append-only negative `FeeLedgerEntry`
 * (`AFFILIATE_REFUND_REVERSAL`) keyed on the refund, and that entry is the seam: L2b reads it to
 * reduce the ledger row (or to record a recovery owed when the share was already paid). The
 * snapshot itself is never edited — it is the record of what was decided at mint.
 *
 * ⚠️ WHOP SENDS REFUND AMOUNTS IN DOLLARS. The SDK's own type says so in as many words: "The
 * refunded amount as a decimal in the specified currency, such as 10.43 for $10.43 USD"
 * (`RefundCreatedWebhookEvent.Data.amount`). Read as cents, a full refund would look like a 1%
 * refund and the referrer would keep their whole share on a session the client got back in full.
 */

import { proRataShare } from './referral-fees';

export type RefundDb = {
  /** Resolves a payment to its booking, for the affiliate half (the snapshot is keyed on booking). */
  bookingFeeSnapshot: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique(args: any): Promise<any>;
  };
  referralLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update(args: any): Promise<any>;
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
  /** Reduced from an unpaid debt. No money moved. */
  reversedUsdCents: number;
  /** Already transferred to the referrer and now owed back. Surfaced, never auto-clawed. */
  recoveryOwedUsdCents: number;
  matched: boolean;
  /** The recruiter's share reversed by this refund (spec v1.5). 0 when none was owed. */
  affiliateReversedUsdCents: number;
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
  const affiliateReversedUsdCents = await reverseAffiliateShare(db, input);
  return { ...referrer, affiliateReversedUsdCents };
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
): Promise<number> {
  if (!(input.refundAmountUsdDollars > 0)) return 0;

  const fee = (await db.feeLedgerEntry.findFirst({
    where: { kind: 'APPLICATION_FEE', whopPaymentId: input.whopPaymentId },
    select: { bookingIntentId: true },
  })) as { bookingIntentId: string | null } | null;
  if (!fee?.bookingIntentId) return 0;

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
  if (!snapshot || owed <= 0 || !snapshot.recruiterPractitionerId) return 0;

  const dedupeKey = `AFFILIATE_REFUND_REVERSAL:${input.refundId}:${snapshot.bookingIntentId}`;
  const prior = await db.feeLedgerEntry.findMany({
    where: { kind: 'AFFILIATE_REFUND_REVERSAL', bookingIntentId: snapshot.bookingIntentId },
    select: { dedupeKey: true, amountUsdCents: true },
  });
  // Entries are NEGATIVE; this refund's own row (on a redelivery) is excluded so a replay computes
  // the same answer the first delivery did.
  const alreadyReversed = prior
    .filter((e: { dedupeKey: string }) => e.dedupeKey !== dedupeKey)
    .reduce((sum: number, e: { amountUsdCents: number }) => sum - e.amountUsdCents, 0);

  const refundUsdCents = Math.round(input.refundAmountUsdDollars * 100);
  const reversal = Math.min(
    owed - alreadyReversed,
    proRataShare(owed, refundUsdCents, snapshot.priceUsdCents),
  );
  if (reversal <= 0) return 0;

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
        'Recruiting-affiliate share reduced by a refund. No affiliate ledger exists yet (lane L2b): ' +
        'when it does, it must apply this entry to the booking’s AffiliateLedgerEntry, and record a ' +
        'recovery owed if that share was already paid out.',
    },
    update: {},
  });
  return reversal;
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
): Promise<Omit<RefundOutcome, 'affiliateReversedUsdCents'>> {
  const none = { reversedUsdCents: 0, recoveryOwedUsdCents: 0, matched: false };
  if (!(input.refundAmountUsdDollars > 0)) return none;

  const row = (await db.referralLedgerEntry.findFirst({
    where: { whopPaymentId: input.whopPaymentId },
    select: {
      id: true,
      state: true,
      grossUsdCents: true,
      referrerShareUsdCents: true,
      referrerPractitionerId: true,
      servingPractitionerId: true,
    },
  })) as {
    id: string;
    state: string;
    grossUsdCents: number;
    referrerShareUsdCents: number;
    referrerPractitionerId: string;
    servingPractitionerId: string;
  } | null;

  // Most refunds are of payments that owed nobody a referral share. Silence is the right answer.
  if (!row || row.referrerShareUsdCents <= 0) return none;

  const refundUsdCents = Math.round(input.refundAmountUsdDollars * 100);
  // PROPORTIONAL, and capped at what is owed. A refund can only ever take money back, so the
  // reversal is bounded by the share — an over-large or mis-parsed refund amount must not produce
  // a negative balance the settlement sweep would then try to transfer.
  const reversal = proRataShare(row.referrerShareUsdCents, refundUsdCents, row.grossUsdCents);
  if (reversal <= 0) return none;

  const alreadyPaid = row.state === 'SETTLED';
  const dedupeKey = `REFUND_REVERSAL:${input.refundId}:${row.id}`;

  if (!alreadyPaid) {
    await db.referralLedgerEntry.update({
      where: { id: row.id },
      data: { referrerShareUsdCents: row.referrerShareUsdCents - reversal },
    });
  }

  await db.feeLedgerEntry.upsert({
    where: { dedupeKey },
    create: {
      dedupeKey,
      kind: 'REFUND_REVERSAL',
      // SETTLED when nothing had moved — the reduction IS the whole action. PENDING when it had,
      // because something a human must do is still outstanding.
      status: alreadyPaid ? 'PENDING' : 'SETTLED',
      bookingIntentId: null,
      practitionerId: row.servingPractitionerId,
      counterpartyPractitionerId: row.referrerPractitionerId,
      // NEGATIVE. The ledger is append-only, so a reversal is an entry with the opposite sign
      // rather than an edit to the entry it reverses.
      amountUsdCents: -reversal,
      whopPaymentId: input.whopPaymentId,
      note: alreadyPaid
        ? 'Referrer share was ALREADY PAID OUT when this refund arrived. Nothing was clawed back ' +
          'automatically — recover it by an explicit action, or offset it against a future share.'
        : 'Referrer share reduced before payout; no money moved.',
    },
    update: {},
  });

  return {
    reversedUsdCents: alreadyPaid ? 0 : reversal,
    recoveryOwedUsdCents: alreadyPaid ? reversal : 0,
    matched: true,
  };
}
