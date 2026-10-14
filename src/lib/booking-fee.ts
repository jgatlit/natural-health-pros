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
import type { TermState } from './attribution-term';
import { hashClientEmail } from './attributed-clients';
import { resolveAttributionInputs, type AttributionResolverDb } from './attribution-resolver';
import { resolveSessionFee, type SessionFee } from './referral-fees';
import type { PlanKey } from './pricing-plans';
import { NoRateScheduleError } from './rate-schedule';
import { getScheduleById, getScheduleForPractitioner } from './rate-schedules';
import { getRecruiterFor } from './recruiter';

/** STRUCTURAL, for the same reason as every other Db type here — see `attributed-clients.ts`. */
export type BookingFeeDb = AttributionResolverDb & {
  attributedClient: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique(args: any): Promise<any>;
  };
  /** The serving practitioner's schedule (fail closed when absent). */
  practitioner: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique(args: any): Promise<any>;
  };
  /** The schedule an in-flight client row was sold under. */
  rateSchedule: {
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
     * THE INSTANT THE TERM IS MEASURED AGAINST — this session's own TRANSACTION instant (operator
     * correction, 2026-09-19, superseding §6.1's "sessions count by scheduled start").
     *
     * The boundary and the anchor must read the same calendar. The anchor is the client's first
     * payment; this is this session's payment, so at mint — which runs moments before the card is
     * charged — the render instant is the honest stand-in, and the scheduled start is not
     * consulted at all.
     *
     * Required, never defaulted: an optional parameter here is exactly how the fee path came to
     * read the wall clock while every unit test passed the instant explicitly.
     */
    transactedAt: Date;
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
      termMonths: true,
      referrerTermMonths: true,
      rateScheduleId: true,
    },
  })) as {
    owner?: string | null;
    decidedAt?: Date | null;
    referrerPractitionerId?: string | null;
    termAnchorAt?: Date | null;
    termEndsAt?: Date | null;
    termMonths?: number | null;
    referrerTermMonths?: number | null;
    rateScheduleId?: string | null;
  } | null;

  // FAIL CLOSED, BEFORE ANYTHING ELSE IS DECIDED. A practitioner with no schedule is refused —
  // never priced against a default. The caller (the checkout page) turns this into "payment is not
  // available" and logs it; nothing is minted and nothing is charged.
  const practitionerSchedule = await getScheduleForPractitioner(db, input.practitionerId);
  if (!practitionerSchedule) throw new NoRateScheduleError(input.practitionerId);

  // AN IN-FLIGHT TERM KEEPS THE SCHEDULE IT WAS SOLD UNDER. A client row carries the schedule id
  // copied onto it when the claim was created; that schedule — not the practitioner's CURRENT one,
  // which a cohort migration may since have changed — prices every later session in the term. If
  // the snapshot points at a schedule that cannot be read, the practitioner's own is used rather
  // than refusing a booking that is otherwise well-formed.
  const schedule =
    (row?.rateScheduleId ? await getScheduleById(db, row.rateScheduleId) : null) ?? practitionerSchedule;

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

  // The client's first transaction with this practitioner. No row means THIS session introduces
  // them; a row with no anchor is a legacy PENDING_ANCHOR row, chargeable from now (a term cannot
  // have expired before it began) — see attribution-term.ts.
  const anchorAt = row?.termAnchorAt ?? input.transactedAt;

  // Seam to L0b: null until `Practitioner.recruitedById` exists. See recruiter.ts.
  const recruiterPractitionerId = await getRecruiterFor(db, input.practitionerId);

  const fee = resolveSessionFee({
    plan: input.plan,
    owner,
    referrerPractitionerId,
    priceUsdCents: input.priceUsdCents,
    schedule,
    practitionerId: input.practitionerId,
    recruiterPractitionerId,
    anchorAt,
    at: input.transactedAt,
    storedTermMonths: { lead: row?.termMonths ?? null, referrer: row?.referrerTermMonths ?? null },
  });

  const resolvedTerm: TermState = !row
    ? 'NONE'
    : !row.termAnchorAt
      ? 'PENDING_ANCHOR'
      : input.transactedAt.getTime() < fee.leadTermEndsAt.getTime()
        ? 'IN_TERM'
        : 'OUT_OF_TERM';

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
    // v1.5 — the schedule and the resolved numbers are COPIED here, so this row alone explains the
    // charge and a later schedule change can never re-price it.
    rateScheduleId: fee.rateScheduleId,
    referrerTermState: fee.referrerTermState,
    affiliateBps: fee.affiliateBps,
    affiliateShareUsdCents: fee.affiliateShareUsdCents,
    recruiterPractitionerId: fee.recruiterPractitionerId,
    nhpNetUsdCents: fee.nhpNetUsdCents,
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
