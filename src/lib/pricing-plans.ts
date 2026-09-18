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
   * Is the first-session share charged ONCE per client, forever, or does it recur while the
   * attribution claim is live?
   *
   * Plan B is once. Amy relaying the practitioners' own words, 2026-09-14: "a fifty-fifty split
   * for the FIRST session if I can book them privately after that", and Jonathan on the same
   * call: "after that, they're yours." Charging it again a year later because a ledger row
   * lapsed would break the exact promise that made Plan B acceptable.
   *
   * Plan A is not once: its smaller share applies to platform-sourced clients for the length of
   * the attribution window (the 09-03 model, 20% on NHP-sourced clients for ~12 months).
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
    firstSessionLabel: string;
    laterSessionLabel: string;
    suits: string;
  }[];
  breakEven: { volumeLabel: string; planACost: string; planBCost: string; better: string }[];
} {
  const plans = practitionerPlans();
  const dollars = (cents: number) =>
    Number.isInteger(cents / 100) ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;

  const share = (bps: number) =>
    bps === 0 ? 'We take nothing' : `We take ${formatBpsAsPercent(bps)}`;

  const cards = [
    {
      key: 'PLAN_A' as const,
      label: plans.PLAN_A.label,
      monthlyLabel: monthlyFeeLabel('PLAN_A'),
      firstSessionLabel: share(plans.PLAN_A.firstSessionPlatformFeeBps),
      laterSessionLabel: share(plans.PLAN_A.laterSessionPlatformFeeBps),
      suits: 'Steadier if we send you regular work, and the simplest option if you have no payment processing of your own.',
    },
    {
      key: 'PLAN_B' as const,
      label: plans.PLAN_B.label,
      monthlyLabel: monthlyFeeLabel('PLAN_B'),
      firstSessionLabel: share(plans.PLAN_B.firstSessionPlatformFeeBps),
      laterSessionLabel: share(plans.PLAN_B.laterSessionPlatformFeeBps),
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
    const a =
      plans.PLAN_A.monthlyFeeUsdCents +
      platformFeeCents({ plan: 'PLAN_A', priceUsdCents: gross, isFirstSession: true });
    const b =
      plans.PLAN_B.monthlyFeeUsdCents +
      platformFeeCents({ plan: 'PLAN_B', priceUsdCents: gross, isFirstSession: true });
    return {
      volumeLabel: `${count} × ${dollars(sessionPriceCents)}`,
      planACost: dollars(a),
      planBCost: dollars(b),
      better: a === b ? 'Same' : a < b ? plans.PLAN_A.label : plans.PLAN_B.label,
    };
  });

  return { cards, breakEven };
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
 * attribution ledger. This is the ONE place the "once vs ongoing" rule lives.
 *
 *   NONE    — we are introducing this client. First-session share.
 *   LIVE    — introduced inside the window. Plan A keeps taking its smaller share; Plan B takes
 *             nothing, because the practitioner was promised the split applies once.
 *   EXPIRED — introduced over a window ago. We no longer have a claim, so we take nothing, on
 *             either plan. Under Plan B that is also what stops a lapsed row re-charging a
 *             first-session fee on a client we introduced years ago.
 */
export function sessionFeeBps(input: { plan: PlanKey; claim: 'NONE' | 'LIVE' | 'EXPIRED' }): number {
  const plan = getPlan(input.plan);
  if (input.claim === 'NONE') return plan.firstSessionPlatformFeeBps;
  if (input.claim === 'EXPIRED') return plan.firstSessionFeeOnce ? 0 : plan.firstSessionPlatformFeeBps;
  return plan.laterSessionPlatformFeeBps;
}

export function sessionFeeCents(input: {
  plan: PlanKey;
  claim: 'NONE' | 'LIVE' | 'EXPIRED';
  priceUsdCents: number;
}): number {
  if (input.priceUsdCents <= 0) return 0;
  const bps = sessionFeeBps(input);
  return Math.floor((input.priceUsdCents * bps) / 10_000);
}
