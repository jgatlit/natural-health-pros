import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { effectivePlan, sessionFeeBps, sessionFeeCents } from '@/lib/pricing-plans';

const ENV = ['PLAN_DEFAULT', 'PLAN_B_FIRST_SESSION_FEE_ONCE', 'PLAN_A_FIRST_SESSION_FEE_ONCE'];

describe('plan default + in-term fee rule', () => {
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

  /**
   * ⚠️ THIS ASSERTION REPLACES ITS OWN OPPOSITE. The previous version of this test asserted that
   * Plan B charged once per client and 0% on every later session ("book them privately after
   * that", 2026-09-14). Spec v1.4 R3 / §9 test 3 and the operator ruling of 2026-09-18 reverse
   * that: the share applies to EVERY platform-sourced session inside the term.
   */
  it('charges Plan B on every sourced session inside the term', () => {
    expect(sessionFeeBps({ plan: 'PLAN_B', term: 'NONE' })).toBe(4_000);
    expect(sessionFeeBps({ plan: 'PLAN_B', term: 'IN_TERM' })).toBe(4_000);
    expect(sessionFeeBps({ plan: 'PLAN_B', term: 'PENDING_ANCHOR' })).toBe(4_000);
  });

  /**
   * ⚠️ ALSO AN INVERSION. Plan A was implemented and asserted as 20% FOREVER. Operator ruling 5
   * (2026-09-18): "Both plan a and plan b reduce to 0% after the same term." One term, one admin
   * setting, both plans.
   */
  it('drops Plan A to 0% at the SAME boundary as Plan B', () => {
    expect(sessionFeeBps({ plan: 'PLAN_A', term: 'NONE' })).toBe(2_000);
    expect(sessionFeeBps({ plan: 'PLAN_A', term: 'IN_TERM' })).toBe(2_000);
    expect(sessionFeeBps({ plan: 'PLAN_A', term: 'OUT_OF_TERM' })).toBe(0);
    expect(sessionFeeBps({ plan: 'PLAN_B', term: 'OUT_OF_TERM' })).toBe(0);
  });

  it('cannot be made to charge after the term by any env flag', () => {
    // The old `FEE_ONCE` flags are no longer consulted for money. Flipping both must not
    // resurrect a post-term charge on either plan.
    process.env.PLAN_B_FIRST_SESSION_FEE_ONCE = 'false';
    process.env.PLAN_A_FIRST_SESSION_FEE_ONCE = 'false';
    expect(sessionFeeBps({ plan: 'PLAN_B', term: 'OUT_OF_TERM' })).toBe(0);
    expect(sessionFeeBps({ plan: 'PLAN_A', term: 'OUT_OF_TERM' })).toBe(0);
  });

  it('never charges on a free session', () => {
    expect(sessionFeeCents({ plan: 'PLAN_B', term: 'NONE', priceUsdCents: 0 })).toBe(0);
  });

  it('rounds down in the practitioner favour', () => {
    expect(sessionFeeCents({ plan: 'PLAN_B', term: 'NONE', priceUsdCents: 4_501 })).toBe(1_800);
  });

  it('bills §9 test 3 exactly: $40 at months 0, 3 and 6, then $0', () => {
    const price = 10_000; // $100 session
    const inTerm = ['NONE', 'IN_TERM', 'IN_TERM'] as const;
    const charged = inTerm.map((term) => sessionFeeCents({ plan: 'PLAN_B', term, priceUsdCents: price }));
    expect(charged).toEqual([4_000, 4_000, 4_000]);
    expect(sessionFeeCents({ plan: 'PLAN_B', term: 'OUT_OF_TERM', priceUsdCents: price })).toBe(0);
  });
});
