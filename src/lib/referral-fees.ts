/**
 * THE FEE RULE (spec v1.4 §6.1) — the single place a session's money is decided.
 *
 * Every other surface reads its answer from here or from the `BookingFeeSnapshot` this produces.
 * The rule is four branches, in this order, and the order is the rule:
 *
 *   1. `owner === 'PRACTITIONER'`   → 0 / 0. Their own client, forever (R4).
 *   2. outside the term             → 0 / 0, on BOTH plans (R4, operator ruling 5).
 *   3. a referrer is named          → XREF_NHP + XREF_REFERRER, **plan ignored** (R7).
 *   4. otherwise                    → the plan's sourced rate (R2/R3).
 *
 * 🚨 BRANCH 1 DID NOT EXIST IN ANY FORM BEFORE THIS STAGE. The shipped fee path went
 * `effectivePlan()` → term state → rate and never consulted a client list or an attribution
 * owner, because neither existed. A practitioner sending her OWN client through her own Natural
 * Health Pros booking link was charged the full sourced rate. That is the largest single gap
 * between the spec and the code, and it is an over-charge, not a missing feature.
 *
 * ⚠️ BRANCH 3 IGNORES THE PLAN, AND THAT IS NOT A SIMPLIFICATION. R7: a cross-referred client
 * costs 40% in total on EITHER plan — 20% to us and 20% to the referrer. Charging Plan B's 40% and
 * then paying the referrer out of it would halve our own take on exactly the sessions we are
 * paying a third party to generate, and would make the §8.1 disclosure false.
 *
 * ⚠️ ONE APPLICATION FEE. Whop has no second application fee and no account-level split
 * (validated 2026-09-18), so the platform take and the referrer take are summed into a SINGLE
 * `application_fee_amount` collected on the parent, and the referrer is settled afterwards by a
 * parent → sibling transfer. `applicationFeeUsdCents` is that number; `nhpFeeUsdCents` and
 * `referrerShareUsdCents` are what it is made of, kept separate so the 20% promised to a referrer
 * stays reconcilable on its own.
 */

import type { AttributionOwner } from './attribution-decision';
import type { TermState } from './attribution-term';
import { isChargeable } from './attribution-term';
import { sourcedSessionFeeBps, type PlanKey } from './pricing-plans';

const BPS_DENOMINATOR = 10_000;

function envBps(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > BPS_DENOMINATOR) {
    throw new Error(`${name} must be an integer between 0 and ${BPS_DENOMINATOR} bps (got ${raw})`);
  }
  return n;
}

/**
 * The cross-referral split (R6/R7), in basis points — 20% to us, 20% to the referrer by default.
 *
 * BASIS POINTS, not the spec's decimals. Spec §1.2 writes `XREF_NHP_RATE=0.20`; the mapping is
 * 1:1 and lossless (`0.20` → `2000`) and bps is kept for two reasons the codebase has already
 * paid for: `0.20 * 33` is `6.6000000000000005` in IEEE-754 while integer-cent arithmetic is
 * exact, and the fee is irreversible once Whop has charged it. The suffix also kills the
 * "50/50 — whose 50?" ambiguity that `pricing-plans.ts` exists to prevent.
 */
export function crossReferralRates(): { nhpFeeBps: number; referrerFeeBps: number } {
  const nhpFeeBps = envBps('XREF_NHP_FEE_BPS', 2_000);
  const referrerFeeBps = envBps('XREF_REFERRER_FEE_BPS', 2_000);
  // Spec §1.2's invariant, restated in bps. A misconfiguration here would hand out more than the
  // session is worth, and it would do it silently on every cross-referred booking.
  if (nhpFeeBps + referrerFeeBps > BPS_DENOMINATOR) {
    throw new Error(
      `XREF_NHP_FEE_BPS + XREF_REFERRER_FEE_BPS must not exceed ${BPS_DENOMINATOR} bps ` +
        `(got ${nhpFeeBps} + ${referrerFeeBps})`,
    );
  }
  return { nhpFeeBps, referrerFeeBps };
}

export type SessionFee = {
  nhpFeeBps: number;
  nhpFeeUsdCents: number;
  referrerFeeBps: number;
  referrerShareUsdCents: number;
  /** Null unless this session actually pays a referrer — never merely "a referrer exists". */
  referrerPractitionerId: string | null;
  /** The ONE number handed to Whop: nhp + referrer. */
  applicationFeeUsdCents: number;
  practitionerNetUsdCents: number;
  isCrossReferral: boolean;
};

/**
 * Round DOWN, and round each share INDEPENDENTLY.
 *
 * Down, because Whop takes `application_fee_amount` off the top of the practitioner's money, so a
 * half-cent rounded up is taken from them — the same rule `platformFeeCents` already applies.
 * Independently, because flooring the combined fee and then splitting it loses a cent from one
 * side without recording which, and the referrer's 20% has to reconcile on its own.
 */
function share(priceUsdCents: number, bps: number): number {
  if (priceUsdCents <= 0 || bps <= 0) return 0;
  return Math.floor((priceUsdCents * bps) / BPS_DENOMINATOR);
}

export function resolveSessionFee(input: {
  plan: PlanKey;
  owner: AttributionOwner;
  term: TermState;
  referrerPractitionerId: string | null;
  priceUsdCents: number;
}): SessionFee {
  const free: SessionFee = {
    nhpFeeBps: 0,
    nhpFeeUsdCents: 0,
    referrerFeeBps: 0,
    referrerShareUsdCents: 0,
    referrerPractitionerId: null,
    applicationFeeUsdCents: 0,
    practitionerNetUsdCents: Math.max(0, input.priceUsdCents),
    isCrossReferral: false,
  };

  // 1 — their own client. Outranks the referral branch deliberately: §4 says there is no referrer
  // share when the client is Y's own, and R8 says X's list never exempts Y, so an exempt client
  // who also carries a referral is free to everyone rather than free to Y and paid to X.
  if (input.owner === 'PRACTITIONER') return free;

  // 2 — outside the term. Both plans, and the referrer share too (§4).
  if (!isChargeable(input.term)) return free;

  if (input.priceUsdCents <= 0) return free;

  // 3 — cross-referred. The plan is deliberately not read on this path.
  if (input.referrerPractitionerId) {
    const { nhpFeeBps, referrerFeeBps } = crossReferralRates();
    const nhpFeeUsdCents = share(input.priceUsdCents, nhpFeeBps);
    const referrerShareUsdCents = share(input.priceUsdCents, referrerFeeBps);
    const applicationFeeUsdCents = nhpFeeUsdCents + referrerShareUsdCents;
    return {
      nhpFeeBps,
      nhpFeeUsdCents,
      referrerFeeBps,
      referrerShareUsdCents,
      referrerPractitionerId: input.referrerPractitionerId,
      applicationFeeUsdCents,
      practitionerNetUsdCents: input.priceUsdCents - applicationFeeUsdCents,
      isCrossReferral: true,
    };
  }

  // 4 — an ordinary platform-sourced session at the plan's rate.
  const nhpFeeBps = sourcedSessionFeeBps(input.plan);
  const nhpFeeUsdCents = share(input.priceUsdCents, nhpFeeBps);
  return {
    nhpFeeBps,
    nhpFeeUsdCents,
    referrerFeeBps: 0,
    referrerShareUsdCents: 0,
    referrerPractitionerId: null,
    applicationFeeUsdCents: nhpFeeUsdCents,
    practitionerNetUsdCents: input.priceUsdCents - nhpFeeUsdCents,
    isCrossReferral: false,
  };
}
