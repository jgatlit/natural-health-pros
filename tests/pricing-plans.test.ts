import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  formatBpsAsPercent,
  getPlan,
  isPlanKey,
  platformFeeCents,
  practitionerNetCents,
  practitionerPlans,
  planComparison,
  sessionFeeBps,
  sourcedSessionFeeBps,
} from '@/lib/pricing-plans';

const PLAN_ENV = [
  'PLAN_A_LABEL',
  'PLAN_A_MONTHLY_FEE_CENTS',
  'PLAN_A_FIRST_SESSION_FEE_BPS',
  'PLAN_A_LATER_SESSION_FEE_BPS',
  'PLAN_B_LABEL',
  'PLAN_B_MONTHLY_FEE_CENTS',
  'PLAN_B_FIRST_SESSION_FEE_BPS',
  'PLAN_B_LATER_SESSION_FEE_BPS',
];

describe('pricing-plans', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(PLAN_ENV.map((k) => [k, process.env[k]]));
    for (const k of PLAN_ENV) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults match the working structure from the 2026-09-14 call', () => {
    const plans = practitionerPlans();
    expect(plans.PLAN_A.monthlyFeeUsdCents).toBe(3900);
    expect(plans.PLAN_A.firstSessionPlatformFeeBps).toBe(2000);
    expect(plans.PLAN_B.monthlyFeeUsdCents).toBe(0);
    expect(plans.PLAN_B.firstSessionPlatformFeeBps).toBe(4000);
    expect(plans.PLAN_B.laterSessionPlatformFeeBps).toBe(0);
  });

  it('both plans require a Whop account', () => {
    expect(getPlan('PLAN_A').requiresWhopAccount).toBe(true);
    expect(getPlan('PLAN_B').requiresWhopAccount).toBe(true);
  });

  it('every number is overridable from env — nothing is hardcoded at the call site', () => {
    process.env.PLAN_A_MONTHLY_FEE_CENTS = '4900';
    process.env.PLAN_B_FIRST_SESSION_FEE_BPS = '4000';
    expect(getPlan('PLAN_A').monthlyFeeUsdCents).toBe(4900);
    expect(getPlan('PLAN_B').firstSessionPlatformFeeBps).toBe(4000);
  });

  it('rejects nonsense config loudly rather than silently charging the wrong split', () => {
    process.env.PLAN_A_FIRST_SESSION_FEE_BPS = '20000';
    expect(() => getPlan('PLAN_A')).toThrow(/<= 10000/);
    process.env.PLAN_A_FIRST_SESSION_FEE_BPS = 'half';
    expect(() => getPlan('PLAN_A')).toThrow(/non-negative integer/);
  });

  it('splits a sourced first session 60/40 under Plan B — practitioner takes the larger share', () => {
    const args = { plan: 'PLAN_B' as const, priceUsdCents: 15_000, isFirstSession: true };
    expect(platformFeeCents(args)).toBe(6_000);
    expect(practitionerNetCents(args)).toBe(9_000);
  });

  it('takes nothing from a Plan B later session', () => {
    const args = { plan: 'PLAN_B' as const, priceUsdCents: 15_000, isFirstSession: false };
    expect(platformFeeCents(args)).toBe(0);
    expect(practitionerNetCents(args)).toBe(15_000);
  });

  it('takes 20% on every Plan A session', () => {
    expect(platformFeeCents({ plan: 'PLAN_A', priceUsdCents: 10_000, isFirstSession: true })).toBe(
      2_000,
    );
    expect(platformFeeCents({ plan: 'PLAN_A', priceUsdCents: 10_000, isFirstSession: false })).toBe(
      2_000,
    );
  });

  it('rounds the fee down so the half-cent goes to the practitioner', () => {
    const args = { plan: 'PLAN_B' as const, priceUsdCents: 4_501, isFirstSession: true };
    expect(platformFeeCents(args)).toBe(1_800);
    expect(practitionerNetCents(args)).toBe(2_701);
  });

  it('never charges a fee on a free or unpriced session', () => {
    expect(platformFeeCents({ plan: 'PLAN_B', priceUsdCents: 0, isFirstSession: true })).toBe(0);
  });

  it('formats splits for display', () => {
    expect(formatBpsAsPercent(4_000)).toBe('40%');
    expect(formatBpsAsPercent(2_000)).toBe('20%');
    expect(formatBpsAsPercent(1_250)).toBe('12.50%');
  });

  it('guards plan keys coming off a form', () => {
    expect(isPlanKey('PLAN_A')).toBe(true);
    expect(isPlanKey('plan_a')).toBe(false);
    expect(isPlanKey(undefined)).toBe(false);
  });
});

describe('plan copy cannot disagree with what the checkout actually charges', () => {
  /**
   * ⚠️ THE BUG THIS EXISTS FOR. The plan cards showed "First session we source" / "After that",
   * reading `laterSessionPlatformFeeBps` for the second row — which is 0 on Plan B. So the card
   * told a practitioner we take nothing on Plan B after the first session, while the shipped fee
   * rule charged 40% on every sourced session inside the term. Copy that disagrees with the charge
   * is worse than no copy: it is the thing a practitioner points at when they dispute an invoice.
   */
  it('quotes the rate the fee rule uses, for every sourced session', () => {
    const { cards } = planComparison();
    for (const card of cards) {
      const expected = formatBpsAsPercent(sourcedSessionFeeBps(card.key));
      expect(card.sourcedSessionLabel, `${card.key} sourced rate`).toContain(expected);
    }
  });

  it('says 0% after the term on BOTH plans — operator ruling 5', () => {
    for (const card of planComparison().cards) {
      expect(card.afterTermLabel, `${card.key} post-term`).toBe('We take nothing');
    }
  });

  it('never claims a post-term rate that the fee rule would actually charge', () => {
    // Mutation guard on the ruling: if OUT_OF_TERM ever stops being free on one plan, this card
    // becomes a false statement and this is what catches it.
    for (const card of planComparison().cards) {
      expect(
        sessionFeeBps({ plan: card.key, term: 'OUT_OF_TERM' }),
        `${card.key} charges after the term but the card says we take nothing`,
      ).toBe(0);
    }
  });

  it('computes the break-even as subscription ÷ rate gap, not as a typed-in number', () => {
    const { breakEvenMonthlyLabel } = planComparison();
    // $39 / (40% - 20%) = $195. The default config is the ruled one, so this is the §8.1 figure.
    expect(breakEvenMonthlyLabel).toBe('$195');
  });

  it('moves the break-even when the monthly fee moves', () => {
    process.env.PLAN_A_MONTHLY_FEE_CENTS = '2900';
    try {
      expect(planComparison().breakEvenMonthlyLabel).toBe('$145');
    } finally {
      delete process.env.PLAN_A_MONTHLY_FEE_CENTS;
    }
  });

  it('says "never" rather than rendering infinity when the two rates are equal', () => {
    process.env.PLAN_B_FIRST_SESSION_FEE_BPS = '2000';
    try {
      expect(planComparison().breakEvenMonthlyLabel).toBe('never');
    } finally {
      delete process.env.PLAN_B_FIRST_SESSION_FEE_BPS;
    }
  });
});
