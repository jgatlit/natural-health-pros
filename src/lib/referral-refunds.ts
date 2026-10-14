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
 * decided at mint. A row already SENDING / SETTLED is only recorded: whatever the recruiter holds
 * beyond what they are now owed comes back as `affiliateRecoveryOwedUsdCents` and the webhook
 * flags it. NOTHING is clawed back automatically, same as the referrer path.
 *
 * ⚠️ WHOP SENDS REFUND AMOUNTS IN DOLLARS. The SDK's own type says so in as many words: "The
 * refunded amount as a decimal in the specified currency, such as 10.43 for $10.43 USD"
 * (`RefundCreatedWebhookEvent.Data.amount`). Read as cents, a full refund would look like a 1%
 * refund and the referrer would keep their whole share on a session the client got back in full.
 */

import { proRataShare } from './referral-fees';
import { applyAffiliateReversal, type AffiliateReversalDb } from './affiliate-ledger';

export type RefundDb = AffiliateReversalDb & {
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
  /** Of the recruiter's share, what had ALREADY been paid out and is now owed back. Never clawed. */
  affiliateRecoveryOwedUsdCents: number;
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
): Promise<{ affiliateReversedUsdCents: number; affiliateRecoveryOwedUsdCents: number }> {
  const none = { affiliateReversedUsdCents: 0, affiliateRecoveryOwedUsdCents: 0 };
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

  // Applied on EVERY delivery, redeliveries included: the total is absolute, so a retry repairs a
  // crash between the marker write above and this one instead of skipping the ledger forever.
  const applied = await applyAffiliateReversal(db, {
    bookingIntentId: snapshot.bookingIntentId,
    recruiterPractitionerId: snapshot.recruiterPractitionerId,
    totalReversedUsdCents: alreadyReversed + reversal,
  });
  return {
    affiliateReversedUsdCents: reversal,
    affiliateRecoveryOwedUsdCents: applied.recoveryOwedUsdCents,
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
): Promise<Omit<RefundOutcome, 'affiliateReversedUsdCents' | 'affiliateRecoveryOwedUsdCents'>> {
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
  const alreadyPaid = row.state === 'SETTLED';
  const dedupeKey = `REFUND_REVERSAL:${input.refundId}:${row.id}`;

  // THE ARITHMETIC RULE (also stated on `proRataShare`):
  //   - every refund is measured against the ORIGINAL share, never against whatever is left. Measured
  //     against the remainder, two 50% refunds of a fully refunded payment reversed 50% + 25% = 75%.
  //   - each refund reverses floor(original x refund / gross), CAPPED at what is still un-reversed, so
  //     the total can never exceed the share (never an over-reversal), and the shortfall against exact
  //     pro-rata is under one cent per refund event (floor), always in the payee's favour.
  //   - a refund of the whole payment (>= gross) reverses everything that remains.
  // The original is rebuilt from the append-only ledger: for an unpaid row the stored share was
  // decremented by earlier reversals, for a paid row it was not.
  const prior = (await db.feeLedgerEntry.findMany({
    where: { kind: 'REFUND_REVERSAL', whopPaymentId: input.whopPaymentId },
    select: { dedupeKey: true, amountUsdCents: true, status: true },
  })) as Array<{ dedupeKey: string; amountUsdCents: number }>;

  // REDELIVERY: Whop sends the same refund 3x. The decrement below is not idempotent by itself, so
  // a refund whose ledger entry already exists is answered from that entry and mutates NOTHING.
  const mine = prior.find((e) => e.dedupeKey === dedupeKey);
  if (mine) {
    const done = -mine.amountUsdCents;
    return {
      reversedUsdCents: alreadyPaid ? 0 : done,
      recoveryOwedUsdCents: alreadyPaid ? done : 0,
      matched: true,
    };
  }

  const reversedBefore = prior.reduce((sum, e) => sum - e.amountUsdCents, 0);
  const original = alreadyPaid ? row.referrerShareUsdCents : row.referrerShareUsdCents + reversedBefore;
  const remaining = original - reversedBefore;
  const reversal = Math.min(remaining, proRataShare(original, refundUsdCents, row.grossUsdCents));
  if (reversal <= 0) return none;

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
