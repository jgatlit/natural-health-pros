/**
 * THE FEE RULE v1.5 (spec v1.5 §1) — the single place a session's money is decided.
 *
 * Every other surface reads its answer from here or from the `BookingFeeSnapshot` this produces.
 * G is the gross client payment in cents and S is the SERVING practitioner's rate schedule
 * (`rate-schedule.ts`) — every rate and every term below comes from S, and from nowhere else.
 * There is no env read and no literal rate in this file, and `tests/no-rate-literals.test.ts`
 * keeps it that way.
 *
 * The branches, in this order, and the order is the rule:
 *
 *   1. `owner === 'PRACTITIONER'`            → practitioner fee 0. Their own client, forever (O8).
 *   2. `at >= leadEnds`                      → practitioner fee 0, on BOTH plans (O5).
 *   3. a referrer is recorded AND
 *      `at < referrerEnds`                   → S.referralTotalBps in all: S.referrerBps to the
 *                                               referrer and the remainder to NHP. **Plan ignored.**
 *   4. otherwise (NHP-sourced, or referred
 *      but past the referrer term)           → the plan's rate to NHP.
 *
 * where `leadEnds = anchor + S.leadTermMonths` and `referrerEnds = anchor + S.referrerTermMonths`,
 * both EXCLUSIVE (a session at exactly the boundary instant is outside), and the anchor is the
 * client's first transaction with this practitioner.
 *
 * THEN THE AFFILIATE OVERLAY (O7, as clarified 07:21), independent of the branch. If the serving
 * practitioner was recruited by R (R ≠ Y, R active): `affiliate = floor(G × S.affiliateBps)`.
 *   - NHP took a fee in this transaction → the affiliate comes OUT OF NHP's share; the
 *     practitioner's charge is unchanged.
 *   - NHP's fee is 0 (own client, past the term) → NHP nets 0 and the practitioner bears the
 *     affiliate: it is added to the application fee. NHP never pays an affiliate out of pocket.
 *
 * ⚠️ ONE APPLICATION FEE. Whop has no second application fee and no account-level split
 * (validated 2026-09-18), so everything is summed into a SINGLE `application_fee_amount` collected
 * on the parent and the referrer and the recruiter are settled afterwards by transfer:
 *
 *     application_fee_amount = nhpFee + referrerShare + (nhpFee === 0 ? affiliate : 0)
 *
 * `nhpFeeUsdCents`, `referrerShareUsdCents` and `affiliateShareUsdCents` are what it is made of,
 * kept separate so each promise stays reconcilable on its own.
 *
 * ⚠️ PLAN B CHARGES EVERY SOURCED SESSION INSIDE THE LEAD TERM (branch 4 is not "first session
 * once"). That rule was reversed on 2026-09-18 and is restated by spec v1.5; the dead
 * `firstSessionFeeOnce` flag has been deleted rather than left beside the rate fields.
 *
 * ⚠️ FAIL CLOSED. A missing schedule THROWS `NoRateScheduleError`. There is no fallback schedule,
 * because a fallback is a default and a default is a silent over- or under-charge that Whop makes
 * irreversible the moment the card is charged.
 *
 * INVARIANTS are asserted on every call (`assertRateScheduleValid`, and the application fee against
 * the schedule's cap) and again at schedule creation, so the 30% ceiling (O6) does not depend on a
 * schedule having been validated "somewhere upstream".
 */

import type { AttributionOwner } from './attribution-decision';
import { addMonths } from './attribution-term';
import type { PlanKey } from './pricing-plans';
import {
  assertRateScheduleValid,
  NoRateScheduleError,
  planSourcedBps,
  type RateSchedule,
} from './rate-schedule';

const BPS_DENOMINATOR = 10_000;

export type ReferrerTermState = 'IN_REFERRER_TERM' | 'PAST_REFERRER_TERM' | 'NOT_REFERRED';

export type SessionFee = {
  nhpFeeBps: number;
  nhpFeeUsdCents: number;
  referrerFeeBps: number;
  referrerShareUsdCents: number;
  /** Null unless this session actually pays a referrer — never merely "a referrer exists". */
  referrerPractitionerId: string | null;
  /** The ONE number handed to Whop: nhp + referrer (+ affiliate when NHP's own fee is 0). */
  applicationFeeUsdCents: number;
  practitionerNetUsdCents: number;
  isCrossReferral: boolean;

  /** = G − practitionerNet: everything the practitioner is charged on this session. */
  practitionerChargeUsdCents: number;
  affiliateBps: number;
  affiliateShareUsdCents: number;
  /** Null unless an affiliate share is actually owed on this session. */
  recruiterPractitionerId: string | null;
  /** NHP's fee after the affiliate: `nhpFee − affiliate` when NHP charged, else 0. Never negative. */
  nhpNetUsdCents: number;
  /** The schedule that priced this session — copied onto the snapshot. */
  rateScheduleId: string;
  referrerTermState: ReferrerTermState;
  leadTermEndsAt: Date;
  referrerTermEndsAt: Date | null;
};

/** The cap invariant (O6) was about to be broken. Unreachable with a validated schedule — hence loud. */
export class FeeInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeeInvariantError';
  }
}

/**
 * Round DOWN, and round each share INDEPENDENTLY.
 *
 * Down, because Whop takes `application_fee_amount` off the top of the practitioner's money, so a
 * half-cent rounded up is taken from them. Independently, because flooring the combined fee and
 * then splitting it loses a cent from one side without recording which, and each promise has to
 * reconcile on its own.
 */
function share(priceUsdCents: number, bps: number): number {
  if (priceUsdCents <= 0 || bps <= 0) return 0;
  return Math.floor((priceUsdCents * bps) / BPS_DENOMINATOR);
}

export type ResolveSessionFeeInput = {
  plan: PlanKey;
  owner: AttributionOwner;
  referrerPractitionerId: string | null;
  priceUsdCents: number;
  /** The SERVING practitioner's schedule. Null is refused, never defaulted. */
  schedule: RateSchedule | null;
  /** Y — the practitioner being paid. */
  practitionerId: string;
  /** Y's recruiter R. The caller has already established that R is active; R === Y is ignored here. */
  recruiterPractitionerId: string | null;
  /** The client's first transaction with Y. */
  anchorAt: Date;
  /** This session's own transaction instant. */
  at: Date;
  /**
   * Term lengths stored on the client's attribution row, when it has them. A stored snapshot wins
   * over the schedule so a row sold under an older term keeps it (forward-only, R1). The
   * referrer term is clamped to the lead term so a mixed snapshot cannot invert them.
   */
  storedTermMonths?: { lead?: number | null; referrer?: number | null };
};

export function resolveSessionFee(input: ResolveSessionFeeInput): SessionFee {
  const schedule = input.schedule;
  if (!schedule) throw new NoRateScheduleError(input.practitionerId);
  // Every call, not just at creation: a row that reached here by any route other than
  // `createRateSchedule` (a hand-written SQL insert, an old backfill) still cannot mint a fee
  // above the ceiling.
  assertRateScheduleValid(schedule);

  const G = input.priceUsdCents;

  const leadMonths =
    input.storedTermMonths?.lead && input.storedTermMonths.lead > 0
      ? input.storedTermMonths.lead
      : schedule.leadTermMonths;
  const referrerMonthsRaw =
    input.storedTermMonths?.referrer && input.storedTermMonths.referrer > 0
      ? input.storedTermMonths.referrer
      : schedule.referrerTermMonths;
  const referrerMonths = Math.min(referrerMonthsRaw, leadMonths);

  const leadEnds = addMonths(input.anchorAt, leadMonths);
  const referrerEnds = input.referrerPractitionerId ? addMonths(input.anchorAt, referrerMonths) : null;
  const atMs = input.at.getTime();
  const inLead = atMs < leadEnds.getTime();
  const inReferrerTerm = referrerEnds !== null && atMs < referrerEnds.getTime();

  const ownClient = input.owner === 'PRACTITIONER';
  const referrerTermState: ReferrerTermState =
    ownClient || !input.referrerPractitionerId
      ? 'NOT_REFERRED'
      : inReferrerTerm
        ? 'IN_REFERRER_TERM'
        : 'PAST_REFERRER_TERM';

  let nhpFeeBps = 0;
  let referrerFeeBps = 0;
  let referrerPractitionerId: string | null = null;
  let isCrossReferral = false;

  if (G > 0 && !ownClient && inLead) {
    if (input.referrerPractitionerId && inReferrerTerm) {
      // 3 — referred, inside the referrer term. The plan is deliberately not read on this path.
      referrerFeeBps = schedule.referrerBps;
      nhpFeeBps = schedule.referralTotalBps - schedule.referrerBps;
      referrerPractitionerId = input.referrerPractitionerId;
      isCrossReferral = true;
    } else {
      // 4 — an ordinary NHP-sourced session, or a referred client past the referrer term.
      nhpFeeBps = planSourcedBps(schedule, input.plan);
    }
  }
  // Branches 1 and 2 (and a free session) fall through with everything at zero.

  const nhpFeeUsdCents = share(G, nhpFeeBps);
  const referrerShareUsdCents = share(G, referrerFeeBps);

  // THE AFFILIATE OVERLAY — independent of the branch above.
  const recruiterApplies =
    !!input.recruiterPractitionerId && input.recruiterPractitionerId !== input.practitionerId;
  const affiliateShareUsdCents = recruiterApplies ? share(G, schedule.affiliateBps) : 0;

  const nhpTookAFee = nhpFeeUsdCents > 0;
  const nhpNetUsdCents = nhpTookAFee ? Math.max(0, nhpFeeUsdCents - affiliateShareUsdCents) : 0;
  const applicationFeeUsdCents =
    nhpFeeUsdCents + referrerShareUsdCents + (nhpTookAFee ? 0 : affiliateShareUsdCents);

  // The deduction from NHP must never have run short — the schedule invariants guarantee it, so a
  // violation here means a rule was edited without its invariant.
  if (nhpTookAFee && affiliateShareUsdCents > nhpFeeUsdCents) {
    throw new FeeInvariantError(
      `affiliate share ${affiliateShareUsdCents} exceeds NHP fee ${nhpFeeUsdCents} on schedule ${schedule.id}`,
    );
  }
  const capCents = Math.floor((G * schedule.maxTotalFeeBps) / BPS_DENOMINATOR);
  if (G > 0 && applicationFeeUsdCents > capCents) {
    throw new FeeInvariantError(
      `application fee ${applicationFeeUsdCents} exceeds the ${schedule.maxTotalFeeBps} bps cap (${capCents}) ` +
        `on schedule ${schedule.id}`,
    );
  }

  return {
    nhpFeeBps,
    nhpFeeUsdCents,
    referrerFeeBps,
    referrerShareUsdCents,
    referrerPractitionerId,
    applicationFeeUsdCents,
    practitionerNetUsdCents: Math.max(0, G) - applicationFeeUsdCents,
    isCrossReferral,
    practitionerChargeUsdCents: applicationFeeUsdCents,
    affiliateBps: recruiterApplies ? schedule.affiliateBps : 0,
    affiliateShareUsdCents,
    recruiterPractitionerId: affiliateShareUsdCents > 0 ? input.recruiterPractitionerId : null,
    nhpNetUsdCents,
    rateScheduleId: schedule.id,
    referrerTermState,
    leadTermEndsAt: leadEnds,
    referrerTermEndsAt: referrerEnds,
  };
}

/**
 * The number handed to Whop as `application_fee_amount`. Recomputed from the parts rather than
 * read back, so a snapshot whose parts disagree with its total fails a test instead of charging.
 */
export function whopApplicationFeeCents(
  fee: Pick<SessionFee, 'nhpFeeUsdCents' | 'referrerShareUsdCents' | 'affiliateShareUsdCents'>,
): number {
  return (
    fee.nhpFeeUsdCents +
    fee.referrerShareUsdCents +
    (fee.nhpFeeUsdCents === 0 ? fee.affiliateShareUsdCents : 0)
  );
}

/**
 * Pro-rata slice of one share for a (possibly partial) refund, floored. Shared by every refund
 * path so the referrer, the affiliate and NHP are reversed by the same arithmetic.
 */
export function proRataShare(shareUsdCents: number, refundedUsdCents: number, grossUsdCents: number): number {
  if (shareUsdCents <= 0 || refundedUsdCents <= 0) return 0;
  if (grossUsdCents <= 0 || refundedUsdCents >= grossUsdCents) return shareUsdCents;
  return Math.min(shareUsdCents, Math.floor((shareUsdCents * refundedUsdCents) / grossUsdCents));
}

/** What a refund of `refundedCents` out of `grossCents` takes back, per party. */
export function reverseForRefund(
  fee: Pick<SessionFee, 'nhpFeeUsdCents' | 'referrerShareUsdCents' | 'affiliateShareUsdCents'>,
  refundedCents: number,
  grossCents: number,
): { affiliateReversedUsdCents: number; referrerReversedUsdCents: number; nhpReversedUsdCents: number } {
  return {
    affiliateReversedUsdCents: proRataShare(fee.affiliateShareUsdCents, refundedCents, grossCents),
    referrerReversedUsdCents: proRataShare(fee.referrerShareUsdCents, refundedCents, grossCents),
    nhpReversedUsdCents: proRataShare(fee.nhpFeeUsdCents, refundedCents, grossCents),
  };
}
