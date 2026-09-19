/**
 * THE FEE ONE BOOKING IS MINTED WITH — the rule (`referral-fees.ts`) applied to stored state.
 *
 * ⚠️ THIS RUNS AT CHECKOUT MINT, NOT AT PAYMENT. Spec §6.1 says the calculation "runs once, when a
 * session is paid"; on Whop it cannot. `application_fee_amount` is fixed when the PLAN is created
 * and there is no patch afterwards (verified live — see `createBookingCheckoutConfig`). So the fee
 * is decided here, written to `BookingFeeSnapshot`, and `payment.succeeded` COMMITS what was
 * decided rather than recomputing it. A recomputation that disagreed with what Whop actually
 * charged would be unresolvable: the money has already moved.
 *
 * ⚠️ AN ALREADY-DECIDED ATTRIBUTION IS NEVER RE-DERIVED (§3.2). A stored row's `owner` and
 * `referrerPractitionerId` win over anything the list and referral tables say today. Without that,
 * a list entry added mid-relationship would retro-exempt a client we had already been paid for,
 * and a referral arriving after the first booking would start paying somebody for an introduction
 * they did not make (§5.6).
 */

import { decideAttribution, type AttributionOwner } from './attribution-decision';
import { termState, type TermState } from './attribution-term';
import { hashClientEmail } from './attributed-clients';
import { resolveAttributionInputs, type AttributionResolverDb } from './attribution-resolver';
import { resolveSessionFee, type SessionFee } from './referral-fees';
import type { PlanKey } from './pricing-plans';

/** STRUCTURAL, for the same reason as every other Db type here — see `attributed-clients.ts`. */
export type BookingFeeDb = AttributionResolverDb & {
  attributedClient: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique(args: any): Promise<any>;
  };
  bookingFeeSnapshot: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(args: any): Promise<unknown>;
  };
};

export type BookingFee = SessionFee & {
  attributionOwner: AttributionOwner;
  decidedByRule: string;
  referralTouchId: string | null;
  termState: TermState;
};

export async function resolveBookingFee(
  db: BookingFeeDb,
  input: {
    bookingIntentId: string;
    practitionerId: string;
    email: string;
    plan: PlanKey;
    priceUsdCents: number;
    /** When this booking's intent row was created — the fallback for the §3.1 cutoff. */
    bookingCreatedAt: Date;
    /**
     * THE INSTANT THE TERM IS MEASURED AGAINST — the session's scheduled start (§6.1: "sessions
     * count by scheduled start"), falling back to now for the no-scheduler flow where no start is
     * ever captured. Required, never defaulted: an optional parameter here is exactly how the fee
     * path came to read the wall clock while every unit test passed the instant explicitly.
     */
    sessionStartsAt: Date;
    referralTouchId?: string | null;
    /** The configuration this fee was minted onto, when one exists. */
    whopCheckoutConfigId?: string | null;
    /** Write the snapshot. False prices without recording — used before a mint is attempted. */
    persist?: boolean;
  },
): Promise<BookingFee> {
  const emailHash = hashClientEmail(input.email);

  const row = (await db.attributedClient.findUnique({
    where: { practitionerId_emailHash: { practitionerId: input.practitionerId, emailHash } },
    select: {
      owner: true,
      decidedAt: true,
      referrerPractitionerId: true,
      termAnchorAt: true,
      termEndsAt: true,
    },
  })) as {
    owner?: string | null;
    decidedAt?: Date | null;
    referrerPractitionerId?: string | null;
    termAnchorAt?: Date | null;
    termEndsAt?: Date | null;
  } | null;

  let owner: AttributionOwner;
  let decidedByRule: string;
  let referrerPractitionerId: string | null;
  let referralTouchId: string | null = input.referralTouchId ?? null;

  if (row?.decidedAt) {
    // DECIDED ONCE. Read back, never re-derived.
    owner = row.owner === 'PRACTITIONER' ? 'PRACTITIONER' : 'NHP';
    decidedByRule = 'ALREADY_DECIDED';
    referrerPractitionerId = row.referrerPractitionerId ?? null;
  } else {
    // No decision yet — either a brand-new client, or a row written before this stage existed,
    // whose `owner` is only the column default and must not be mistaken for an answer.
    const inputs = await resolveAttributionInputs(db, {
      practitionerId: input.practitionerId,
      email: input.email,
      bookingCreatedAt: input.bookingCreatedAt,
      referralTouchId: input.referralTouchId,
    });
    const decision = decideAttribution({ practitionerId: input.practitionerId, ...inputs });
    owner = decision.owner;
    decidedByRule = decision.decidedByRule;
    referrerPractitionerId = decision.referrerPractitionerId;
    referralTouchId = decision.referralTouchId ?? referralTouchId;
  }

  const state = termState(
    { termAnchorAt: row?.termAnchorAt ?? null, termEndsAt: row?.termEndsAt ?? null },
    input.sessionStartsAt,
  );
  // No row at all means we have never claimed this client, so this very session introduces them.
  const resolvedTerm: TermState = row ? state : 'NONE';

  const fee = resolveSessionFee({
    plan: input.plan,
    owner,
    term: resolvedTerm,
    referrerPractitionerId,
    priceUsdCents: input.priceUsdCents,
  });

  const result: BookingFee = {
    ...fee,
    attributionOwner: owner,
    decidedByRule,
    // Only meaningful when the referral is actually being paid — otherwise the snapshot would
    // claim an introduction that earned nothing.
    referralTouchId: fee.isCrossReferral ? referralTouchId : null,
    termState: resolvedTerm,
  };

  if (input.persist !== false) {
    await persistBookingFeeSnapshot(db, {
      bookingIntentId: input.bookingIntentId,
      plan: input.plan,
      priceUsdCents: input.priceUsdCents,
      whopCheckoutConfigId: input.whopCheckoutConfigId ?? null,
      fee: result,
    });
  }

  return result;
}

/**
 * Record the decision that was actually minted.
 *
 * Separate from pricing so the caller can price BEFORE attempting the mint and record only AFTER
 * it succeeds — a snapshot for a configuration that was never created would claim a fee nobody
 * was ever charged, and the reconciliation sweep (§7) would then report it as a Whop mismatch
 * forever.
 */
export async function persistBookingFeeSnapshot(
  db: Pick<BookingFeeDb, 'bookingFeeSnapshot'>,
  input: {
    bookingIntentId: string;
    plan: PlanKey;
    priceUsdCents: number;
    whopCheckoutConfigId: string | null;
    fee: BookingFee;
  },
): Promise<void> {
  const { fee } = input;
  const data = {
    bookingIntentId: input.bookingIntentId,
    attributionOwner: fee.attributionOwner,
    termState: fee.termState,
    inTerm: fee.termState === 'IN_TERM' || fee.termState === 'PENDING_ANCHOR',
    planAtMint: input.plan,
    isCrossReferral: fee.isCrossReferral,
    priceUsdCents: input.priceUsdCents,
    nhpFeeBps: fee.nhpFeeBps,
    nhpFeeUsdCents: fee.nhpFeeUsdCents,
    referrerFeeBps: fee.referrerFeeBps,
    referrerShareUsdCents: fee.referrerShareUsdCents,
    referrerPractitionerId: fee.referrerPractitionerId,
    practitionerNetUsdCents: fee.practitionerNetUsdCents,
    applicationFeeUsdCents: fee.applicationFeeUsdCents,
    whopCheckoutConfigId: input.whopCheckoutConfigId,
  };
  // Upsert rather than create: a re-render that re-reaches the mint must not throw on the unique
  // constraint. The amounts are a pure function of state that has not moved, so a rewrite is a
  // no-op in practice — except for `whopCheckoutConfigId`, which is only known after the mint.
  await db.bookingFeeSnapshot.upsert({
    where: { bookingIntentId: input.bookingIntentId },
    create: data,
    update: data,
  });
}
