import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { effectivePlan, isPlanKey } from '@/lib/pricing-plans';
import { resolveSessionFee } from '@/lib/referral-fees';
import { V1 } from './helpers/rate-schedule';

const ENV = ['PLAN_DEFAULT'];

describe('plan default', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults an unchosen plan to Plan B (operator ruling 2026-09-18)', () => {
    expect(effectivePlan(null)).toBe('PLAN_B');
    expect(effectivePlan(undefined)).toBe('PLAN_B');
    expect(effectivePlan('nonsense')).toBe('PLAN_B');
    expect(effectivePlan('PLAN_A')).toBe('PLAN_A');
  });

  it('lets the default be moved without a code change', () => {
    process.env.PLAN_DEFAULT = 'PLAN_A';
    expect(effectivePlan(null)).toBe('PLAN_A');
  });

  it('guards plan keys coming off a form', () => {
    expect(isPlanKey('PLAN_A')).toBe(true);
    expect(isPlanKey('plan_a')).toBe(false);
    expect(isPlanKey(undefined)).toBe(false);
  });
});

/**
 * The in-term rule, through the real `resolveSessionFee` (the old `sessionFeeBps` helpers were
 * removed with the env rates). Two operator inversions are pinned here so they cannot silently
 * return:
 *
 *  - 2026-09-18: Plan B charges EVERY NHP-sourced session inside the term, not once per client.
 *    Spec v1.5 §1 restates it; the dead `firstSessionFeeOnce` flag is gone from the code.
 *  - 2026-09-18: Plan A drops to 0% at the SAME boundary as Plan B (it was "20% forever").
 */
describe('in-term fee rule (v1.5)', () => {
  const ANCHOR = new Date('2026-01-15T12:00:00.000Z');
  const at = (m: number) => {
    const d = new Date(ANCHOR);
    d.setUTCMonth(d.getUTCMonth() + m);
    return d;
  };
  const fee = (plan: 'PLAN_A' | 'PLAN_B', month: number, priceUsdCents = 10_000) =>
    resolveSessionFee({
      plan,
      owner: 'NHP',
      referrerPractitionerId: null,
      priceUsdCents,
      schedule: V1,
      practitionerId: 'Y',
      recruiterPractitionerId: null,
      anchorAt: ANCHOR,
      at: at(month),
    }).nhpFeeUsdCents;

  it('charges Plan B on every sourced session inside the term', () => {
    expect([0, 3, 6].map((m) => fee('PLAN_B', m))).toEqual([3_000, 3_000, 3_000]);
  });

  it('drops BOTH plans to 0% at the same boundary', () => {
    expect(fee('PLAN_A', 7)).toBe(1_000);
    expect(fee('PLAN_A', 8)).toBe(0);
    expect(fee('PLAN_B', 7)).toBe(3_000);
    expect(fee('PLAN_B', 8)).toBe(0);
  });

  it('rounds down in the practitioner’s favour', () => {
    expect(fee('PLAN_B', 0, 4_501)).toBe(1_350);
  });

  it('no PLAN_*_FIRST_SESSION_FEE_ONCE flag changes a fee any more', () => {
    const before = [0, 3, 8].map((m) => fee('PLAN_B', m));
    process.env.PLAN_B_FIRST_SESSION_FEE_ONCE = 'true';
    process.env.PLAN_A_FIRST_SESSION_FEE_ONCE = 'true';
    try {
      expect([0, 3, 8].map((m) => fee('PLAN_B', m))).toEqual(before);
    } finally {
      delete process.env.PLAN_B_FIRST_SESSION_FEE_ONCE;
      delete process.env.PLAN_A_FIRST_SESSION_FEE_ONCE;
    }
  });
});
