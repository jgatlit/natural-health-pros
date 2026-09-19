/**
 * Plan A / Plan B practitioner pricing — the single source of the numbers.
 *
 * Adopted on the 2026-09-14 Amy call; every figure below is still OPEN (primers/2026-09-15-
 * triage-context.md). The defaults here are placeholders so the code runs, NOT decisions: Plan A
 * at $39/mo is Jonathan's lean out of $29/$39/$49, and Plan B is 60/40 on a sourced first session
 * (operator ruling 2026-09-18 — practitioner 60, platform 40; this is the split Amy's own
 * break-even math on the 2026-09-14 call assumed). The 50/50 used for the first live checkout test
 * was the upper end of the range discussed, not the decision. Amy owns the real numbers. Override via env, never by editing a
 * literal into a component — that is how the four previous fee models (5%, 10%+10%, 20%/0%) each
 * ended up hardcoded in a different place.
 *
 * "Split" is always expressed as the PLATFORM's share in basis points, hence `platformFeeBps`
 * rather than a bare `split`: a "50/50" or "80/20" in a meeting note never says which side it
 * names, and that ambiguity is worth one longer identifier to kill permanently.
 */

import type { TermState } from './attribution-term';

export type PlanKey = 'PLAN_A' | 'PLAN_B';

export type PractitionerPlan = {
  key: PlanKey;
  /** Customer-facing name. "Plan A/B", not "tier" — tiers imply hierarchy (Amy, 2026-09-14). */
  label: string;
  /** Recurring listing fee charged to the practitioner, in cents. 0 means no subscription. */
  monthlyFeeUsdCents: number;
  /** Platform share of a platform-sourced FIRST session, in basis points (10000 = 100%). */
  firstSessionPlatformFeeBps: number;
  /** Platform share of every subsequent platform-sourced session, in basis points. */
  laterSessionPlatformFeeBps: number;
  /**
   * ⚠️ DEAD. NOTHING READS THIS, AND NOTHING MAY.
   *
   * It expressed "charge the sourced share once per client, forever" — reversed by the operator
   * on 2026-09-18, after which both plans charge on EVERY sourced session inside the Lead
   * Attribution Term and 0% after it. A previous note here claimed onboarding copy still read it;
   * that is false, verified by grep across `src/`, `scripts/` and `tests/`.
   *
   * It is kept for one release only so a deployment mid-rollout does not see the field vanish,
   * and it is left in place rather than deleted BECAUSE it is money-shaped: a boolean called
   * `firstSessionFeeOnce` sitting next to two rate fields is exactly the thing somebody re-wires
   * in good faith. `tests/pricing-plans.test.ts` asserts that setting it — either way, on either
   * plan — changes no fee. Re-wire it and that test fails.
   */
  firstSessionFeeOnce: boolean;
  /** Both plans transact through Whop; kept explicit so no UI can imply otherwise. */
  requiresWhopAccount: true;
};

const BPS_DENOMINATOR = 10_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer (got ${JSON.stringify(raw)})`);
  }
  return n;
}

function envBps(name: string, fallback: number): number {
  const n = envInt(name, fallback);
  if (n > BPS_DENOMINATOR) throw new Error(`${name} must be <= ${BPS_DENOMINATOR} bps (got ${n})`);
  return n;
}

export function practitionerPlans(): Record<PlanKey, PractitionerPlan> {
  return {
    PLAN_A: {
      key: 'PLAN_A',
      label: process.env.PLAN_A_LABEL?.trim() || 'Plan A',
      monthlyFeeUsdCents: envInt('PLAN_A_MONTHLY_FEE_CENTS', 3900),
      firstSessionPlatformFeeBps: envBps('PLAN_A_FIRST_SESSION_FEE_BPS', 2000),
      laterSessionPlatformFeeBps: envBps('PLAN_A_LATER_SESSION_FEE_BPS', 2000),
      firstSessionFeeOnce: process.env.PLAN_A_FIRST_SESSION_FEE_ONCE === 'true',
      requiresWhopAccount: true,
    },
    PLAN_B: {
      key: 'PLAN_B',
      label: process.env.PLAN_B_LABEL?.trim() || 'Plan B',
      monthlyFeeUsdCents: envInt('PLAN_B_MONTHLY_FEE_CENTS', 0),
      firstSessionPlatformFeeBps: envBps('PLAN_B_FIRST_SESSION_FEE_BPS', 4000),
      // Plan B's later sessions are booked privately between practitioner and client. Nothing in
      // the product enforces that today — an open design question from the 09-14 call, not a bug.
      laterSessionPlatformFeeBps: envBps('PLAN_B_LATER_SESSION_FEE_BPS', 0),
      firstSessionFeeOnce: process.env.PLAN_B_FIRST_SESSION_FEE_ONCE !== 'false',
      requiresWhopAccount: true,
    },
  };
}

export function getPlan(key: PlanKey): PractitionerPlan {
  return practitionerPlans()[key];
}

export function isPlanKey(value: unknown): value is PlanKey {
  return value === 'PLAN_A' || value === 'PLAN_B';
}

/**
 * The platform fee for one session, in cents, rounded DOWN.
 *
 * Rounding down is deliberate: Whop takes `application_fee_amount` off the top of the
 * practitioner's money, so a half-cent rounded up is taken from them. Favour the practitioner.
 */
export function platformFeeCents(input: {
  plan: PlanKey;
  priceUsdCents: number;
  isFirstSession: boolean;
}): number {
  if (input.priceUsdCents <= 0) return 0;
  const plan = getPlan(input.plan);
  const bps = input.isFirstSession
    ? plan.firstSessionPlatformFeeBps
    : plan.laterSessionPlatformFeeBps;
  return Math.floor((input.priceUsdCents * bps) / BPS_DENOMINATOR);
}

/** What the practitioner actually receives for one session, in cents. */
export function practitionerNetCents(input: {
  plan: PlanKey;
  priceUsdCents: number;
  isFirstSession: boolean;
}): number {
  return input.priceUsdCents - platformFeeCents(input);
}

export function formatBpsAsPercent(bps: number): string {
  const pct = (bps / BPS_DENOMINATOR) * 100;
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(2)}%`;
}

/**
 * Monthly-fee label for a plan, e.g. "$39/mo". Server-only: it reads env, so never call it from
 * a client component — pass the string down as a prop, the way the edit page does.
 */
export function monthlyFeeLabel(key: PlanKey): string {
  const cents = getPlan(key).monthlyFeeUsdCents;
  if (cents <= 0) return 'No monthly fee';
  const d = cents / 100;
  return Number.isInteger(d) ? `$${d}/mo` : `$${d.toFixed(2)}/mo`;
}

/**
 * Everything the plan-choice UI renders, derived from the config in one place.
 *
 * Server-only (it reads env). The UI receives strings, never raw numbers, so no component can
 * format a price a second way — the bug `formatPrice` in money.ts exists to prevent.
 */
export function planComparison(): {
  cards: {
    key: PlanKey;
    label: string;
    monthlyLabel: string;
    /** Every platform-sourced session INSIDE the term — there is only one sourced rate per plan. */
    sourcedSessionLabel: string;
    /** After the term. Zero on both plans (operator ruling 5). */
    afterTermLabel: string;
    suits: string;
  }[];
  breakEven: { volumeLabel: string; planACost: string; planBCost: string; better: string }[];
  /** "$195" — the monthly sourced volume at which Plan A becomes the cheaper plan (spec §8.1). */
  breakEvenMonthlyLabel: string;
} {
  const plans = practitionerPlans();
  const dollars = (cents: number) =>
    Number.isInteger(cents / 100) ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;

  const share = (bps: number) =>
    bps === 0 ? 'We take nothing' : `We take ${formatBpsAsPercent(bps)}`;

  // ⚠️ ONE SOURCED RATE PER PLAN, AND THE CARDS SAID OTHERWISE UNTIL NOW.
  //
  // The cards used to show "First session we source" and "After that", reading
  // `laterSessionPlatformFeeBps` for the second row — which is 0 on Plan B. That told a
  // practitioner we take nothing on Plan B after the first session, which the shipped fee rule
  // contradicts: since the 2026-09-18 recurrence ruling, Plan B charges its share on EVERY
  // sourced session inside the term. Copy that disagrees with the charge is worse than no copy.
  const cards = [
    {
      key: 'PLAN_A' as const,
      label: plans.PLAN_A.label,
      monthlyLabel: monthlyFeeLabel('PLAN_A'),
      sourcedSessionLabel: share(sourcedSessionFeeBps('PLAN_A')),
      afterTermLabel: share(0),
      suits: 'Steadier if we send you regular work, and the simplest option if you have no payment processing of your own.',
    },
    {
      key: 'PLAN_B' as const,
      label: plans.PLAN_B.label,
      monthlyLabel: monthlyFeeLabel('PLAN_B'),
      sourcedSessionLabel: share(sourcedSessionFeeBps('PLAN_B')),
      afterTermLabel: share(0),
      suits: 'Costs you nothing until we actually send you someone. Suits you if you just want the pipeline.',
    },
  ];

  // Whole first sessions, not a smooth curve: a practitioner reasons in "two clients a month",
  // not in dollars of gross. The volumes bracket Amy'''s ~$150/mo break-even at a typical session
  // price so the crossover is visible rather than asserted.
  // $100, because that is the number Amy reasoned from on 2026-09-14 ("that's a twenty dollar
  // difference on a hundred dollars") and because HHE's stated standard is first sessions under
  // $100, promoted hardest at $75 or less (2026-05-28 call).
  const sessionPriceCents = envInt('PLAN_COMPARISON_SESSION_PRICE_CENTS', 10_000);
  const breakEven = [1, 2, 4, 8].map((count) => {
    const gross = sessionPriceCents * count;
    // `sourcedSessionFeeBps`, not the deprecated first/later pair: under the recurrence ruling
    // there is ONE sourced rate per plan, and reading the old pair here is how the cards came to
    // disagree with what the checkout actually charges.
    const a =
      plans.PLAN_A.monthlyFeeUsdCents +
      Math.floor((gross * sourcedSessionFeeBps('PLAN_A')) / BPS_DENOMINATOR);
    const b =
      plans.PLAN_B.monthlyFeeUsdCents +
      Math.floor((gross * sourcedSessionFeeBps('PLAN_B')) / BPS_DENOMINATOR);
    return {
      volumeLabel: `${count} × ${dollars(sessionPriceCents)}`,
      planACost: dollars(a),
      planBCost: dollars(b),
      better: a === b ? 'Same' : a < b ? plans.PLAN_A.label : plans.PLAN_B.label,
    };
  });

  // THE CROSSOVER IS EXACT, so it is solved rather than read off the table above.
  //
  // Both plans charge on the same sessions inside the same term, so Plan B's fee is a fixed
  // multiple of Plan A's on identical volume and the crossover is
  // `subscription / (planB_rate - planA_rate)` — independent of session price and of how often
  // clients rebook. See docs/2026-09-18-plan-ab-one-year-projection.md.
  const rateGapBps =
    sourcedSessionFeeBps('PLAN_B') - sourcedSessionFeeBps('PLAN_A');
  const breakEvenMonthlyLabel =
    rateGapBps > 0
      ? dollars(
          Math.round((plans.PLAN_A.monthlyFeeUsdCents * BPS_DENOMINATOR) / rateGapBps),
        )
      : // No gap means Plan A's subscription buys nothing back, so there is no crossover to
        // quote. Saying so beats rendering "$Infinity" or silently omitting the sentence.
        'never';

  return { cards, breakEven, breakEvenMonthlyLabel };
}

/**
 * The plan a practitioner is on when they have not chosen one.
 *
 * Operator ruling 2026-09-18: Plan B. It is the only safe default — it bills nobody a monthly fee
 * they never agreed to, and it costs the practitioner nothing until we actually send them work.
 *
 * This is resolved at READ time and is NOT written to `Practitioner.plan`. The 14 already-listed
 * practitioners stay null on purpose (operator, same ruling): null records the truth, which is
 * that they have not been asked yet, and Sarah's outreach needs to be able to tell them apart
 * from someone who deliberately picked Plan B.
 */
export function effectivePlan(stored: unknown): PlanKey {
  if (isPlanKey(stored)) return stored;
  const fallback = process.env.PLAN_DEFAULT;
  return isPlanKey(fallback) ? fallback : 'PLAN_B';
}

/**
 * The platform fee for one session, resolved from the plan and the client's place in the
 * ATTRIBUTION TERM. This is the ONE place the rule lives.
 *
 * ⚠️ REWRITTEN 2026-09-18 on two operator rulings, both of which INVERT behaviour that was
 * shipped and asserted:
 *
 *  1. Plan B charges its share on EVERY platform-sourced session inside the term, not once per
 *     client forever (spec R3 / §9 test 3: $40 × 3 at months 0/3/6, $0 at month 9). The old
 *     `firstSessionFeeOnce` / NONE-LIVE-EXPIRED rule no longer expresses the business.
 *  2. Plan A expires at the SAME boundary as Plan B. It was carried as 20% forever; that
 *     assertion was wrong and is now inverted.
 *
 * The consequence worth naming: OUT_OF_TERM is 0% on BOTH plans, which is also what closes the
 * double-charge hole. The old rule read an EXPIRED ledger row as "no live claim, so this is a
 * first session" and charged the full first-session share a second time on a client we had
 * already introduced and already been paid for. There is now no branch that can charge anything
 * once the term has run out.
 *
 * `NONE` means we are introducing this client with this very session — month 0, chargeable.
 * `PENDING_ANCHOR` means we hold a claim whose first session has not happened yet, so the clock
 * has not started; a term cannot expire before it begins, so it charges.
 */
export function sessionFeeBps(input: { plan: PlanKey; term: TermState }): number {
  if (input.term === 'OUT_OF_TERM') return 0;
  return sourcedSessionFeeBps(input.plan);
}

/**
 * The plan's share of a platform-sourced session inside the term.
 *
 * Reads `firstSessionPlatformFeeBps` for EVERY in-term session by design: after the recurrence
 * ruling there is only one sourced-session rate per plan. `laterSessionPlatformFeeBps` survives
 * only as the (unused, zero) tail rate and is not consulted here — a second rate to keep in sync
 * is exactly how Plan B ended up charging 0% on sessions the spec says are chargeable.
 */
export function sourcedSessionFeeBps(plan: PlanKey): number {
  return getPlan(plan).firstSessionPlatformFeeBps;
}

export function sessionFeeCents(input: {
  plan: PlanKey;
  term: TermState;
  priceUsdCents: number;
}): number {
  if (input.priceUsdCents <= 0) return 0;
  const bps = sessionFeeBps(input);
  return Math.floor((input.priceUsdCents * bps) / 10_000);
}
