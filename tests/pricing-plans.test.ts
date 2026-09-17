import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  formatBpsAsPercent,
  getPlan,
  isPlanKey,
  platformFeeCents,
  practitionerNetCents,
  practitionerPlans,
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
    expect(plans.PLAN_B.firstSessionPlatformFeeBps).toBe(5000);
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

  it('splits a first session 50/50 under Plan B', () => {
    const args = { plan: 'PLAN_B' as const, priceUsdCents: 15_000, isFirstSession: true };
    expect(platformFeeCents(args)).toBe(7_500);
    expect(practitionerNetCents(args)).toBe(7_500);
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
    expect(platformFeeCents(args)).toBe(2_250);
    expect(practitionerNetCents(args)).toBe(2_251);
  });

  it('never charges a fee on a free or unpriced session', () => {
    expect(platformFeeCents({ plan: 'PLAN_B', priceUsdCents: 0, isFirstSession: true })).toBe(0);
  });

  it('formats splits for display', () => {
    expect(formatBpsAsPercent(5_000)).toBe('50%');
    expect(formatBpsAsPercent(2_000)).toBe('20%');
    expect(formatBpsAsPercent(1_250)).toBe('12.50%');
  });

  it('guards plan keys coming off a form', () => {
    expect(isPlanKey('PLAN_A')).toBe(true);
    expect(isPlanKey('plan_a')).toBe(false);
    expect(isPlanKey(undefined)).toBe(false);
  });
});
