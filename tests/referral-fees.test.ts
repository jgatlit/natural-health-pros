import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { crossReferralRates, resolveSessionFee } from '@/lib/referral-fees';
import type { TermState } from '@/lib/attribution-term';

/**
 * THE FEE RULE (spec v1.4 §6.1, R4/R6/R7) — the one place a session's money is decided.
 *
 * Branch order matters and is asserted branch by branch, because three of the four branches return
 * zero for different reasons and collapsing any two of them has a different failure:
 *
 *   1. owner = PRACTITIONER  → 0/0. Their own client, forever (R4). NO SUCH BRANCH EXISTED before
 *      this stage: the shipped fee path went straight from the plan to a rate and never consulted
 *      a client list, so a practitioner sending her OWN client through her own NHP link was
 *      charged the full sourced rate.
 *   2. outside the term      → 0/0 on BOTH plans (R4, operator ruling 5).
 *   3. cross-referred        → 20% NHP + 20% referrer, AND THE PLAN IS IGNORED (R7).
 *   4. otherwise             → the plan's sourced rate.
 */

const ENV = ['XREF_NHP_FEE_BPS', 'XREF_REFERRER_FEE_BPS', 'PLAN_A_FIRST_SESSION_FEE_BPS', 'PLAN_B_FIRST_SESSION_FEE_BPS'];

describe('resolveSessionFee', () => {
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

  const session = (over: Partial<Parameters<typeof resolveSessionFee>[0]> = {}) =>
    resolveSessionFee({
      plan: 'PLAN_B',
      owner: 'NHP',
      term: 'NONE' as TermState,
      referrerPractitionerId: null,
      priceUsdCents: 10_000,
      ...over,
    });

  it('spec §9 test 2 — a plain NHP-sourced session on Plan B is $40 of $100', () => {
    const fee = session();
    expect(fee.nhpFeeUsdCents).toBe(4_000);
    expect(fee.referrerShareUsdCents).toBe(0);
    expect(fee.applicationFeeUsdCents).toBe(4_000);
    expect(fee.practitionerNetUsdCents).toBe(6_000);
  });

  it('spec §9 test 3 — Plan B charges EVERY sourced session inside the term, and nothing after', () => {
    const months: TermState[] = ['NONE', 'IN_TERM', 'IN_TERM', 'OUT_OF_TERM'];
    const charged = months.map((term) => session({ term }).nhpFeeUsdCents);

    expect(charged).toEqual([4_000, 4_000, 4_000, 0]);
    expect(charged.reduce((a, b) => a + b, 0)).toBe(12_000); // $120
  });

  it('spec §9 test 4 — Plan A mirrors it at 20%: $60 across the term, then nothing', () => {
    const months: TermState[] = ['NONE', 'IN_TERM', 'IN_TERM', 'OUT_OF_TERM'];
    const charged = months.map((term) => session({ plan: 'PLAN_A', term }).nhpFeeUsdCents);

    expect(charged).toEqual([2_000, 2_000, 2_000, 0]);
    expect(charged.reduce((a, b) => a + b, 0)).toBe(6_000); // $60
  });

  it('R4 — the practitioner’s OWN client is free, on every session and both plans', () => {
    for (const plan of ['PLAN_A', 'PLAN_B'] as const) {
      for (const term of ['NONE', 'IN_TERM', 'PENDING_ANCHOR', 'OUT_OF_TERM'] as TermState[]) {
        const fee = session({ plan, owner: 'PRACTITIONER', term });
        expect(fee.nhpFeeUsdCents, `${plan}/${term}`).toBe(0);
        expect(fee.applicationFeeUsdCents, `${plan}/${term}`).toBe(0);
        expect(fee.practitionerNetUsdCents, `${plan}/${term}`).toBe(10_000);
      }
    }
  });

  it('an own client is free EVEN WHEN a referrer is named — the exemption outranks the referral (§4)', () => {
    const fee = session({ owner: 'PRACTITIONER', term: 'IN_TERM', referrerPractitionerId: 'X' });

    expect(fee.nhpFeeUsdCents).toBe(0);
    expect(fee.referrerShareUsdCents).toBe(0);
    expect(fee.referrerPractitionerId).toBeNull();
    expect(fee.isCrossReferral).toBe(false);
  });

  it('PENDING_ANCHOR charges — a term cannot have expired before it began', () => {
    expect(session({ term: 'PENDING_ANCHOR' }).nhpFeeUsdCents).toBe(4_000);
  });
});

describe('resolveSessionFee — cross-referral (R6/R7)', () => {
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

  const crossReferred = (plan: 'PLAN_A' | 'PLAN_B', priceUsdCents = 10_000) =>
    resolveSessionFee({
      plan,
      owner: 'NHP',
      term: 'IN_TERM',
      referrerPractitionerId: 'X',
      priceUsdCents,
    });

  it('spec §9 test 6 — Y on Plan A: NHP $20, X $20, Y keeps $60', () => {
    const fee = crossReferred('PLAN_A');

    expect(fee.nhpFeeUsdCents).toBe(2_000);
    expect(fee.referrerShareUsdCents).toBe(2_000);
    expect(fee.practitionerNetUsdCents).toBe(6_000);
    expect(fee.referrerPractitionerId).toBe('X');
    expect(fee.isCrossReferral).toBe(true);
  });

  it('spec §9 test 7 — Y on Plan B is BYTE-IDENTICAL: the plan is ignored on a cross-referral', () => {
    // Mutation test in assertion form. If a future edit lets the plan leak into this branch —
    // e.g. by charging Plan B's 40% and then paying X out of it — this is what fails.
    expect(crossReferred('PLAN_B')).toEqual(crossReferred('PLAN_A'));
  });

  it('collects ONE application fee that is the sum of both shares — there is no second Whop fee', () => {
    const fee = crossReferred('PLAN_A');

    expect(fee.applicationFeeUsdCents).toBe(fee.nhpFeeUsdCents + fee.referrerShareUsdCents);
    expect(fee.applicationFeeUsdCents).toBe(4_000);
  });

  it('spec §9 test 18 — a $2,500 offering: NHP $500, X $500, Y keeps $1,500', () => {
    const fee = crossReferred('PLAN_B', 250_000);

    expect(fee.nhpFeeUsdCents).toBe(50_000);
    expect(fee.referrerShareUsdCents).toBe(50_000);
    expect(fee.practitionerNetUsdCents).toBe(150_000);
    expect(fee.applicationFeeUsdCents).toBe(100_000);
  });

  it('pays no referrer share outside the term — the referral expires with the attribution (§4)', () => {
    const fee = resolveSessionFee({
      plan: 'PLAN_A',
      owner: 'NHP',
      term: 'OUT_OF_TERM',
      referrerPractitionerId: 'X',
      priceUsdCents: 10_000,
    });

    expect(fee.nhpFeeUsdCents).toBe(0);
    expect(fee.referrerShareUsdCents).toBe(0);
    expect(fee.referrerPractitionerId).toBeNull();
  });

  it('floors each share INDEPENDENTLY, so neither side is silently under-collected', () => {
    // 3333c at 20% is 666.6c each. Flooring the SUM (1333c) and splitting it would lose a cent
    // from one side without saying which.
    const fee = crossReferred('PLAN_A', 3_333);

    expect(fee.nhpFeeUsdCents).toBe(666);
    expect(fee.referrerShareUsdCents).toBe(666);
    expect(fee.applicationFeeUsdCents).toBe(1_332);
    expect(fee.practitionerNetUsdCents).toBe(2_001);
  });

  it('never charges anything on a zero-price offering', () => {
    const fee = crossReferred('PLAN_A', 0);

    expect(fee.applicationFeeUsdCents).toBe(0);
    expect(fee.practitionerNetUsdCents).toBe(0);
  });
});

describe('crossReferralRates — configuration', () => {
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

  it('defaults to the ruled 20% / 20%', () => {
    expect(crossReferralRates()).toEqual({ nhpFeeBps: 2_000, referrerFeeBps: 2_000 });
  });

  it('is overridable by env, in basis points', () => {
    process.env.XREF_NHP_FEE_BPS = '1500';
    process.env.XREF_REFERRER_FEE_BPS = '2500';

    expect(crossReferralRates()).toEqual({ nhpFeeBps: 1_500, referrerFeeBps: 2_500 });
  });

  it('REFUSES a configuration that would pay out more than the session is worth (spec §1.2)', () => {
    process.env.XREF_NHP_FEE_BPS = '6000';
    process.env.XREF_REFERRER_FEE_BPS = '5000';

    expect(() => crossReferralRates()).toThrow(/must not exceed/i);
  });
});
