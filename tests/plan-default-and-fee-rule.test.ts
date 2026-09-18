import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { effectivePlan, getPlan, sessionFeeBps, sessionFeeCents } from '@/lib/pricing-plans';

const ENV = ['PLAN_DEFAULT', 'PLAN_B_FIRST_SESSION_FEE_ONCE', 'PLAN_A_FIRST_SESSION_FEE_ONCE'];

describe('plan default + once-vs-ongoing fee rule', () => {
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

  it("charges Plan B's first-session split once and never again", () => {
    expect(sessionFeeBps({ plan: 'PLAN_B', claim: 'NONE' })).toBe(4_000);
    expect(sessionFeeBps({ plan: 'PLAN_B', claim: 'LIVE' })).toBe(0);
    // The promise was "book them privately after that" — a lapsed ledger row must not re-charge.
    expect(sessionFeeBps({ plan: 'PLAN_B', claim: 'EXPIRED' })).toBe(0);
    expect(getPlan('PLAN_B').firstSessionFeeOnce).toBe(true);
  });

  it('keeps taking the Plan A share while the claim is live, and stops when it lapses', () => {
    expect(sessionFeeBps({ plan: 'PLAN_A', claim: 'NONE' })).toBe(2_000);
    expect(sessionFeeBps({ plan: 'PLAN_A', claim: 'LIVE' })).toBe(2_000);
    expect(sessionFeeBps({ plan: 'PLAN_A', claim: 'EXPIRED' })).toBe(2_000);
  });

  it('can be flipped back to recurring for Plan B if the term ever changes', () => {
    process.env.PLAN_B_FIRST_SESSION_FEE_ONCE = 'false';
    expect(sessionFeeBps({ plan: 'PLAN_B', claim: 'EXPIRED' })).toBe(4_000);
  });

  it('never charges on a free session', () => {
    expect(sessionFeeCents({ plan: 'PLAN_B', claim: 'NONE', priceUsdCents: 0 })).toBe(0);
  });

  it('rounds down in the practitioner favour', () => {
    expect(sessionFeeCents({ plan: 'PLAN_B', claim: 'NONE', priceUsdCents: 4_501 })).toBe(1_800);
  });
});
