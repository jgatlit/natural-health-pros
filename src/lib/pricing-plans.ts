/**
 * Plan A / Plan B — the practitioner's plan CHOICE, and the customer-facing copy generated from a
 * rate schedule.
 *
 * ⚠️ THIS FILE NO LONGER HOLDS A SINGLE RATE. Spec v1.5 §2: the database is the only source of
 * rates, and every number below arrives as a parameter — a `RateSchedule` row loaded by the caller
 * (`rate-schedules.ts`). There are no `PLAN_*_FEE_*` / `PLAN_*_MONTHLY_FEE_CENTS` env reads and no
 * literal default: those were how the previous four fee models (5%, 10%+10%, 20%/0%, 20/40) each
 * ended up hardcoded in a different place, and `tests/no-rate-literals.test.ts` fails the build if
 * one comes back. What survives from the old file is what is NOT a rate: the plan keys, the
 * customer-facing labels, and the plan a practitioner is on when they have not chosen one.
 *
 * "Split" is always expressed as the PLATFORM's share in basis points, hence `…Bps` rather than a
 * bare `split`: a "50/50" or "80/20" in a meeting note never says which side it names, and that
 * ambiguity is worth one longer identifier to kill permanently.
 *
 * Server-only where it takes a schedule: the UI receives strings, never raw numbers, so no
 * component can format a price a second way — the bug `formatPrice` in money.ts exists to prevent.
 */

import {
  annualPlanAPriceCents,
  planMonthlyCents,
  planSourcedBps,
  type RateScheduleNumbers,
} from './rate-schedule';

export type PlanKey = 'PLAN_A' | 'PLAN_B';

/** The rate fields the copy needs. A full `RateSchedule` row satisfies it. */
export type CopySchedule = RateScheduleNumbers;

const BPS_DENOMINATOR = 10_000;

/** Customer-facing name. "Plan A/B", not "tier" — tiers imply hierarchy (Amy, 2026-09-14). */
export function planLabel(key: PlanKey): string {
  const fromEnv = (key === 'PLAN_A' ? process.env.PLAN_A_LABEL : process.env.PLAN_B_LABEL)?.trim();
  return fromEnv || (key === 'PLAN_A' ? 'Plan A' : 'Plan B');
}

export function isPlanKey(value: unknown): value is PlanKey {
  return value === 'PLAN_A' || value === 'PLAN_B';
}

export function formatBpsAsPercent(bps: number): string {
  const pct = (bps / BPS_DENOMINATOR) * 100;
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(2)}%`;
}

function dollars(cents: number): string {
  return Number.isInteger(cents / 100) ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** Monthly-fee label for a plan, e.g. "$39/mo", read from the schedule. */
export function monthlyFeeLabel(schedule: CopySchedule, key: PlanKey): string {
  const cents = planMonthlyCents(schedule, key);
  if (cents <= 0) return 'No monthly fee';
  return `${dollars(cents)}/mo`;
}

/** "$374.40/yr" — the yearly Plan A price, DERIVED from the schedule, never typed in. */
export function annualPlanALabel(schedule: CopySchedule): string {
  return `${dollars(annualPlanAPriceCents(schedule))}/yr`;
}

/**
 * The referral and term sentences' numbers, as strings. One object so every surface (plan choice,
 * summary table, referrer-side copy, notification emails) states the same split.
 */
export type ReferralTermsView = {
  /** The NHP lead attribution term, in months. */
  termMonths: number;
  /** The shorter window in which a referred client is split referrer + NHP. */
  referrerTermMonths: number;
  /** "30%" — what a referred client costs in total during the referrer term. */
  referralTotalLabel: string;
  /** "20%" — the referrer's share. */
  referrerRateLabel: string;
  /** "10%" — NHP's share of a referred session. */
  nhpReferralRateLabel: string;
};

export function referralTermsView(schedule: CopySchedule): ReferralTermsView {
  return {
    termMonths: schedule.leadTermMonths,
    referrerTermMonths: schedule.referrerTermMonths,
    referralTotalLabel: formatBpsAsPercent(schedule.referralTotalBps),
    referrerRateLabel: formatBpsAsPercent(schedule.referrerBps),
    nhpReferralRateLabel: formatBpsAsPercent(schedule.referralTotalBps - schedule.referrerBps),
  };
}

/** The example session price for the break-even table. Display only; not a rate. */
function examplePriceCents(): number {
  const raw = process.env.PLAN_COMPARISON_SESSION_PRICE_CENTS;
  if (raw === undefined || raw.trim() === '') return 10_000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `PLAN_COMPARISON_SESSION_PRICE_CENTS must be a positive integer (got ${JSON.stringify(raw)})`,
    );
  }
  return n;
}

/** Everything the plan-choice UI renders, derived from a schedule in one place. */
export function planComparison(schedule: CopySchedule): {
  cards: {
    key: PlanKey;
    label: string;
    monthlyLabel: string;
    /** Yearly price, only where the plan has a subscription to discount. */
    annualLabel: string | null;
    /** Every NHP-sourced session INSIDE the lead term — there is only one sourced rate per plan. */
    sourcedSessionLabel: string;
    /** After the term. Zero on both plans (operator ruling O5). */
    afterTermLabel: string;
    suits: string;
  }[];
  breakEven: { volumeLabel: string; planACost: string; planBCost: string; better: string }[];
  /** The monthly sourced volume at which Plan A becomes the cheaper plan (spec §8.1). */
  breakEvenMonthlyLabel: string;
  referral: ReferralTermsView;
} {
  const share = (bps: number) =>
    bps === 0 ? 'We take nothing' : `We take ${formatBpsAsPercent(bps)}`;

  // ONE SOURCED RATE PER PLAN. The cards must quote the rate the checkout actually charges on every
  // sourced session inside the term; copy that disagrees with the charge is the thing a
  // practitioner points at when they dispute an invoice.
  const cards = [
    {
      key: 'PLAN_A' as const,
      label: planLabel('PLAN_A'),
      monthlyLabel: monthlyFeeLabel(schedule, 'PLAN_A'),
      annualLabel: planMonthlyCents(schedule, 'PLAN_A') > 0 ? annualPlanALabel(schedule) : null,
      sourcedSessionLabel: share(planSourcedBps(schedule, 'PLAN_A')),
      afterTermLabel: share(0),
      suits:
        'Steadier if we send you regular work, and the simplest option if you have no payment processing of your own.',
    },
    {
      key: 'PLAN_B' as const,
      label: planLabel('PLAN_B'),
      monthlyLabel: monthlyFeeLabel(schedule, 'PLAN_B'),
      annualLabel: null,
      sourcedSessionLabel: share(planSourcedBps(schedule, 'PLAN_B')),
      afterTermLabel: share(0),
      suits:
        'Costs you nothing until we actually send you someone. Suits you if you just want the pipeline.',
    },
  ];

  // Whole sessions, not a smooth curve: a practitioner reasons in "two clients a month", not in
  // dollars of gross. The example session price is DISPLAY ONLY (it is not a rate) — Amy reasoned
  // from $100 on 2026-09-14, and HHE's stated standard is first sessions under $100.
  const sessionPriceCents = examplePriceCents();
  const breakEven = [1, 2, 4, 8].map((count) => {
    const gross = sessionPriceCents * count;
    const a =
      planMonthlyCents(schedule, 'PLAN_A') +
      Math.floor((gross * planSourcedBps(schedule, 'PLAN_A')) / BPS_DENOMINATOR);
    const b =
      planMonthlyCents(schedule, 'PLAN_B') +
      Math.floor((gross * planSourcedBps(schedule, 'PLAN_B')) / BPS_DENOMINATOR);
    return {
      volumeLabel: `${count} × ${dollars(sessionPriceCents)}`,
      planACost: dollars(a),
      planBCost: dollars(b),
      better: a === b ? 'Same' : a < b ? cards[0].label : cards[1].label,
    };
  });

  // THE CROSSOVER IS EXACT, so it is solved rather than read off the table above. Both plans
  // charge on the same sessions inside the same term, so the crossover is the subscription
  // difference over the rate gap — independent of session price and of how often clients rebook.
  const rateGapBps = planSourcedBps(schedule, 'PLAN_B') - planSourcedBps(schedule, 'PLAN_A');
  const subscriptionGap = planMonthlyCents(schedule, 'PLAN_A') - planMonthlyCents(schedule, 'PLAN_B');
  const breakEvenMonthlyLabel =
    rateGapBps > 0 && subscriptionGap > 0
      ? dollars(Math.round((subscriptionGap * BPS_DENOMINATOR) / rateGapBps))
      : // No crossover to quote. Saying so beats rendering "$Infinity" or silently omitting it.
        'never';

  return { cards, breakEven, breakEvenMonthlyLabel, referral: referralTermsView(schedule) };
}

/**
 * The plan a practitioner is on when they have not chosen one.
 *
 * Operator ruling 2026-09-18: Plan B. It is the only safe default — it bills nobody a monthly fee
 * they never agreed to, and it costs the practitioner nothing until we actually send them work.
 *
 * This is resolved at READ time and is NOT written to `Practitioner.plan`. The already-listed
 * practitioners stay null on purpose (operator, same ruling): null records the truth, which is
 * that they have not been asked yet, and Sarah's outreach needs to be able to tell them apart
 * from someone who deliberately picked Plan B.
 */
export function effectivePlan(stored: unknown): PlanKey {
  if (isPlanKey(stored)) return stored;
  const fallback = process.env.PLAN_DEFAULT;
  return isPlanKey(fallback) ? fallback : 'PLAN_B';
}
