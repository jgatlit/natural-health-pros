import { describe, expect, it } from 'vitest';

import {
  annualPlanALabel,
  formatBpsAsPercent,
  monthlyFeeLabel,
  planComparison,
  planLabel,
  referralTermsView,
} from '@/lib/pricing-plans';
import { annualPlanAPriceCents, planSourcedBps } from '@/lib/rate-schedule';
import { resolveSessionFee } from '@/lib/referral-fees';
import { V1, V1_NUMBERS, V2 } from './helpers/rate-schedule';

/**
 * Plan copy is GENERATED FROM A SCHEDULE. Nothing here can name a rate that is not in the schedule
 * it was handed, which is what `no-rate-literals.test.ts` enforces from the other side (no digits
 * left in the copy source).
 */

describe('plan copy cannot disagree with what the checkout actually charges', () => {
  const ANCHOR = new Date('2026-01-15T12:00:00.000Z');
  const charged = (schedule: typeof V1, plan: 'PLAN_A' | 'PLAN_B') =>
    resolveSessionFee({
      plan,
      owner: 'NHP',
      referrerPractitionerId: null,
      priceUsdCents: 10_000,
      schedule,
      practitionerId: 'Y',
      recruiterPractitionerId: null,
      anchorAt: ANCHOR,
      at: ANCHOR,
    }).nhpFeeBps;

  it('quotes exactly the rate the fee rule charges, for every sourced session, on any schedule', () => {
    for (const schedule of [V1, V2]) {
      for (const card of planComparison(schedule).cards) {
        expect(card.sourcedSessionLabel, `${schedule.id} ${card.key}`).toContain(
          formatBpsAsPercent(charged(schedule, card.key)),
        );
        expect(charged(schedule, card.key)).toBe(planSourcedBps(schedule, card.key));
      }
    }
  });

  it('says 0% after the term on BOTH plans', () => {
    for (const card of planComparison(V1).cards) {
      expect(card.afterTermLabel).toBe('We take nothing');
    }
  });

  it('computes the break-even as subscription ÷ rate gap, not as a typed-in number', () => {
    // $39 / (30% − 10%) = $195.
    expect(planComparison(V1).breakEvenMonthlyLabel).toBe('$195');
  });

  it('moves the break-even when the schedule moves', () => {
    // $29 / (20% − 5%) = $193.33…, rounded to the cent.
    expect(planComparison(V2).breakEvenMonthlyLabel).toBe('$193.33');
    expect(planComparison({ ...V1_NUMBERS, planAMonthlyCents: 2900 }).breakEvenMonthlyLabel).toBe('$145');
  });

  it('says "never" rather than rendering infinity when the two rates are equal', () => {
    expect(planComparison({ ...V1_NUMBERS, planBSourcedBps: V1_NUMBERS.planASourcedBps }).breakEvenMonthlyLabel).toBe(
      'never',
    );
  });
});

describe('labels are derived from the schedule', () => {
  it('monthly labels', () => {
    expect(monthlyFeeLabel(V1, 'PLAN_A')).toBe('$39/mo');
    expect(monthlyFeeLabel(V1, 'PLAN_B')).toBe('No monthly fee');
    expect(monthlyFeeLabel({ ...V1_NUMBERS, planAMonthlyCents: 4950 }, 'PLAN_A')).toBe('$49.50/mo');
  });

  it('the yearly Plan A price is DERIVED: 3900 × 12 × (1 − 20%) = 37440 cents', () => {
    expect(annualPlanAPriceCents(V1)).toBe(37_440);
    expect(annualPlanALabel(V1)).toBe('$374.40/yr');
    expect(annualPlanAPriceCents({ ...V1_NUMBERS, annualDiscountBps: 0 })).toBe(46_800);
    expect(annualPlanALabel({ ...V1_NUMBERS, planAMonthlyCents: 5000 })).toBe('$480/yr');
  });

  it('only Plan A has a yearly label', () => {
    const cards = planComparison(V1).cards;
    expect(cards[0].annualLabel).toBe('$374.40/yr');
    expect(cards[1].annualLabel).toBeNull();
  });

  it('the referral sentence numbers come from the schedule', () => {
    expect(referralTermsView(V1)).toEqual({
      termMonths: 8,
      referrerTermMonths: 4,
      referralTotalLabel: '30%',
      referrerRateLabel: '20%',
      nhpReferralRateLabel: '10%',
    });
    expect(referralTermsView(V2).termMonths).toBe(8);
  });

  it('plan labels default to Plan A / Plan B', () => {
    expect(planLabel('PLAN_A')).toBe('Plan A');
    expect(planLabel('PLAN_B')).toBe('Plan B');
  });

  it('formats splits for display', () => {
    expect(formatBpsAsPercent(3_000)).toBe('30%');
    expect(formatBpsAsPercent(1_250)).toBe('12.50%');
  });
});
