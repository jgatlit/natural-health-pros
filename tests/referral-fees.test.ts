import { describe, expect, it } from 'vitest';

import {
  FeeInvariantError,
  proRataShare,
  resolveSessionFee,
  type ResolveSessionFeeInput,
} from '@/lib/referral-fees';
import { NoRateScheduleError, RateScheduleInvariantError } from '@/lib/rate-schedule';
import { V1, V2 } from './helpers/rate-schedule';

/**
 * THE FEE RULE v1.5 (spec v1.5 §1) — the one place a session's money is decided.
 *
 * Branch order matters and is asserted branch by branch, because three of the four branches return
 * zero or a plan-blind number for different reasons and collapsing any two of them has a different
 * failure. (The full $100 table, both plans, with and without a recruiter, lives in
 * `spec-v15-fee-rule.test.ts`; this file covers the rule's edges and the failure modes.)
 *
 *   1. owner = PRACTITIONER  → 0. Their own client, forever.
 *   2. at >= leadEnds        → 0 on BOTH plans.
 *   3. referred, inside the referrer term → 30% = 20 referrer + 10 NHP, AND THE PLAN IS IGNORED.
 *   4. otherwise             → the plan's sourced rate.
 */

const ANCHOR = new Date('2026-01-15T12:00:00.000Z');
const monthsAfter = (m: number, ms = 0) => {
  const d = new Date(ANCHOR);
  d.setUTCMonth(d.getUTCMonth() + m);
  return new Date(d.getTime() + ms);
};

const session = (over: Partial<ResolveSessionFeeInput> = {}) =>
  resolveSessionFee({
    plan: 'PLAN_B',
    owner: 'NHP',
    referrerPractitionerId: null,
    priceUsdCents: 10_000,
    schedule: V1,
    practitionerId: 'Y',
    recruiterPractitionerId: null,
    anchorAt: ANCHOR,
    at: ANCHOR,
    ...over,
  });

describe('resolveSessionFee — sourced sessions', () => {
  it('a plain NHP-sourced session on Plan B is 30% of $100', () => {
    const fee = session();
    expect(fee.nhpFeeBps).toBe(3_000);
    expect(fee.nhpFeeUsdCents).toBe(3_000);
    expect(fee.applicationFeeUsdCents).toBe(3_000);
    expect(fee.practitionerNetUsdCents).toBe(7_000);
  });

  it('Plan B charges EVERY sourced session inside the term, and nothing after (NOT first-session-once)', () => {
    const charged = [0, 3, 6, 7, 8].map((m) => session({ at: monthsAfter(m) }).nhpFeeUsdCents);
    expect(charged).toEqual([3_000, 3_000, 3_000, 3_000, 0]);
  });

  it('Plan A mirrors it at 10%', () => {
    const charged = [0, 3, 6, 8].map((m) => session({ plan: 'PLAN_A', at: monthsAfter(m) }).nhpFeeUsdCents);
    expect(charged).toEqual([1_000, 1_000, 1_000, 0]);
  });

  it('only ever yields an NHP fee rate of 0, 10% or 30% for a non-referral session on v1', () => {
    for (const plan of ['PLAN_A', 'PLAN_B'] as const) {
      for (const m of [0, 2, 5, 7, 8, 12]) {
        for (const owner of ['NHP', 'PRACTITIONER'] as const) {
          expect([0, 1_000, 3_000]).toContain(session({ plan, owner, at: monthsAfter(m) }).nhpFeeBps);
        }
      }
    }
  });

  it('the practitioner’s OWN client is free on every session, both plans', () => {
    for (const plan of ['PLAN_A', 'PLAN_B'] as const) {
      for (const m of [0, 3, 9]) {
        const fee = session({ plan, owner: 'PRACTITIONER', at: monthsAfter(m) });
        expect(fee.applicationFeeUsdCents, `${plan}/${m}`).toBe(0);
        expect(fee.practitionerNetUsdCents, `${plan}/${m}`).toBe(10_000);
      }
    }
  });

  it('an own client is free EVEN WHEN a referrer is named — the exemption outranks the referral', () => {
    const fee = session({ owner: 'PRACTITIONER', referrerPractitionerId: 'X', at: monthsAfter(1) });
    expect(fee.nhpFeeUsdCents).toBe(0);
    expect(fee.referrerShareUsdCents).toBe(0);
    expect(fee.referrerPractitionerId).toBeNull();
    expect(fee.isCrossReferral).toBe(false);
    expect(fee.referrerTermState).toBe('NOT_REFERRED');
  });

  it('never charges anything on a zero-price offering', () => {
    const fee = session({ priceUsdCents: 0, recruiterPractitionerId: 'R' });
    expect(fee.applicationFeeUsdCents).toBe(0);
    expect(fee.affiliateShareUsdCents).toBe(0);
    expect(fee.practitionerNetUsdCents).toBe(0);
  });
});

describe('resolveSessionFee — referred clients', () => {
  const referred = (plan: 'PLAN_A' | 'PLAN_B', priceUsdCents = 10_000, m = 1) =>
    session({ plan, referrerPractitionerId: 'X', priceUsdCents, at: monthsAfter(m) });

  it('inside the referrer term: NHP $10, X $20, Y keeps $70 — on Plan A', () => {
    const fee = referred('PLAN_A');
    expect(fee.nhpFeeUsdCents).toBe(1_000);
    expect(fee.referrerShareUsdCents).toBe(2_000);
    expect(fee.practitionerNetUsdCents).toBe(7_000);
    expect(fee.referrerPractitionerId).toBe('X');
    expect(fee.isCrossReferral).toBe(true);
    expect(fee.referrerTermState).toBe('IN_REFERRER_TERM');
  });

  it('is BYTE-IDENTICAL on Plan B: the plan is ignored while the referral window is open', () => {
    expect(referred('PLAN_B')).toEqual(referred('PLAN_A'));
  });

  it('collects ONE application fee that is the sum of both shares', () => {
    const fee = referred('PLAN_A');
    expect(fee.applicationFeeUsdCents).toBe(fee.nhpFeeUsdCents + fee.referrerShareUsdCents);
    expect(fee.applicationFeeUsdCents).toBe(3_000);
  });

  it('a $2,500 offering: NHP $250, X $500, Y keeps $1,750', () => {
    const fee = referred('PLAN_B', 250_000);
    expect(fee.nhpFeeUsdCents).toBe(25_000);
    expect(fee.referrerShareUsdCents).toBe(50_000);
    expect(fee.practitionerNetUsdCents).toBe(175_000);
  });

  it('month 5 (past the 4-month referrer term, inside the 8-month lead term) is the plan rate and no referrer', () => {
    const a = referred('PLAN_A', 10_000, 5);
    const b = referred('PLAN_B', 10_000, 5);
    expect([a.nhpFeeUsdCents, a.referrerShareUsdCents, a.referrerPractitionerId]).toEqual([1_000, 0, null]);
    expect([b.nhpFeeUsdCents, b.referrerShareUsdCents, b.referrerPractitionerId]).toEqual([3_000, 0, null]);
    expect(a.referrerTermState).toBe('PAST_REFERRER_TERM');
    expect(a.isCrossReferral).toBe(false);
  });

  it('pays no referrer share once the lead term has run out', () => {
    const fee = referred('PLAN_A', 10_000, 9);
    expect(fee.nhpFeeUsdCents).toBe(0);
    expect(fee.referrerShareUsdCents).toBe(0);
    expect(fee.referrerPractitionerId).toBeNull();
  });

  it('floors each share INDEPENDENTLY, so neither side is silently under-collected', () => {
    // 3333c: 20% = 666.6c, 10% = 333.3c. Flooring the SUM (999c) and splitting it would lose a cent.
    const fee = referred('PLAN_A', 3_333);
    expect(fee.referrerShareUsdCents).toBe(666);
    expect(fee.nhpFeeUsdCents).toBe(333);
    expect(fee.applicationFeeUsdCents).toBe(999);
    expect(fee.practitionerNetUsdCents).toBe(2_334);
  });
});

describe('resolveSessionFee — stored term snapshots win over the schedule', () => {
  it('a client sold a 6-month lead term is out of term at month 6 even though the schedule says 8', () => {
    const fee = session({ at: monthsAfter(6), storedTermMonths: { lead: 6 } });
    expect(fee.nhpFeeUsdCents).toBe(0);
  });

  it('a stored referrer term of 2 months ends the referral split at month 2', () => {
    const inside = session({ referrerPractitionerId: 'X', at: monthsAfter(2, -1), storedTermMonths: { referrer: 2 } });
    const after = session({ referrerPractitionerId: 'X', at: monthsAfter(2), storedTermMonths: { referrer: 2 } });
    expect(inside.referrerShareUsdCents).toBe(2_000);
    expect(after.referrerShareUsdCents).toBe(0);
  });

  it('the referrer term is clamped to the lead term, so a mixed snapshot cannot invert them', () => {
    const fee = session({
      referrerPractitionerId: 'X',
      at: monthsAfter(3, -1),
      storedTermMonths: { lead: 3, referrer: 10 },
    });
    expect(fee.referrerTermEndsAt?.toISOString()).toBe(fee.leadTermEndsAt.toISOString());
  });
});

describe('resolveSessionFee — which schedule governs', () => {
  it('uses the schedule it is GIVEN; a different schedule gives a different number', () => {
    expect(session({ schedule: V1 }).nhpFeeUsdCents).toBe(3_000);
    expect(session({ schedule: V2 }).nhpFeeUsdCents).toBe(2_000);
    expect(session({ schedule: V2 }).rateScheduleId).toBe('rs_v2');
  });

  it('copies the schedule id onto the result so the snapshot can carry it', () => {
    expect(session().rateScheduleId).toBe(V1.id);
  });
});

describe('resolveSessionFee — fails closed and asserts the invariants on EVERY call', () => {
  it('REFUSES a missing schedule with NoRateScheduleError — no default is ever charged', () => {
    expect(() => session({ schedule: null })).toThrow(NoRateScheduleError);
  });

  it('REFUSES a schedule that breaks the 30% cap, even if it never went through createRateSchedule', () => {
    expect(() => session({ schedule: { ...V1, planBSourcedBps: 3_500 } })).toThrow(RateScheduleInvariantError);
    expect(() => session({ schedule: { ...V1, referralTotalBps: 3_500 } })).toThrow(RateScheduleInvariantError);
    expect(() => session({ schedule: { ...V1, maxTotalFeeBps: 5_000, planBSourcedBps: 4_500 } })).toThrow(
      RateScheduleInvariantError,
    );
  });

  it('the application fee can never exceed floor(G × maxTotalFeeBps) across a sweep of prices and times', () => {
    for (const price of [1, 7, 99, 100, 3_333, 10_000, 250_000]) {
      for (const plan of ['PLAN_A', 'PLAN_B'] as const) {
        for (const m of [0, 1, 4, 5, 8, 9]) {
          for (const referrer of [null, 'X']) {
            for (const recruiter of [null, 'R']) {
              const fee = session({
                plan,
                priceUsdCents: price,
                at: monthsAfter(m),
                referrerPractitionerId: referrer,
                recruiterPractitionerId: recruiter,
              });
              expect(fee.applicationFeeUsdCents).toBeLessThanOrEqual(Math.floor((price * 3_000) / 10_000));
              expect(fee.nhpNetUsdCents).toBeGreaterThanOrEqual(0);
              expect(fee.practitionerNetUsdCents).toBe(price - fee.applicationFeeUsdCents);
            }
          }
        }
      }
    }
  });

  it('FeeInvariantError exists for the case the schedule invariants should make unreachable', () => {
    expect(new FeeInvariantError('x').name).toBe('FeeInvariantError');
  });
});

describe('proRataShare', () => {
  it('is floored, capped at the share, and total on a full refund', () => {
    expect(proRataShare(2_000, 5_000, 10_000)).toBe(1_000);
    expect(proRataShare(300, 3_333, 10_000)).toBe(99);
    expect(proRataShare(300, 99_999, 10_000)).toBe(300);
    expect(proRataShare(300, 10_000, 10_000)).toBe(300);
    expect(proRataShare(0, 5_000, 10_000)).toBe(0);
    expect(proRataShare(300, 0, 10_000)).toBe(0);
  });
});
