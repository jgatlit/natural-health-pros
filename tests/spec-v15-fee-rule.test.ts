import { describe, expect, it } from 'vitest';

import type { AttributionOwner } from '@/lib/attribution-decision';
import type { PlanKey } from '@/lib/pricing-plans';
import {
  resolveSessionFee,
  reverseForRefund,
  whopApplicationFeeCents,
  type SessionFee,
} from '@/lib/referral-fees';
import { annualPlanAPriceCents } from '@/lib/rate-schedule';
import { createRateSchedule } from '@/lib/rate-schedule-hash';
import { recordRecruiter } from '@/lib/recruiter';

/**
 * SPEC v1.5 §1 / §7 — the fee table, written BEFORE the implementation exists (lane L1 spec tests).
 *
 * Written before the implementation (lane L1 spec tests), then un-skipped against the real modules.
 * THE NUMBERS ARE THE INVARIANT; the signatures were only a proposal, and the implemented ones
 * differ in two small ways: `resolveSessionFee` also accepts an optional `storedTermMonths`, and
 * `createRateSchedule` returns the numbers plus their `contentHash`.
 *
 * ---------------------------------------------------------------------------------------------
 * PROPOSED CONTRACT (the builder may adapt names and shapes, not the cents)
 *
 *   RateScheduleFields   { id, planAMonthlyCents, annualDiscountBps, planASourcedBps,
 *                          planBMonthlyCents, planBSourcedBps, referralTotalBps, referrerBps,
 *                          affiliateBps, leadTermMonths, referrerTermMonths, maxTotalFeeBps }
 *
 *   resolveSessionFee({ plan, owner, referrerPractitionerId, priceUsdCents,
 *                       schedule,                  // serving practitioner's schedule; null => refused
 *                       practitionerId,            // Y
 *                       recruiterPractitionerId,   // Y's recruiter R, or null (R active; R === Y => ignored)
 *                       anchorAt, at })            // anchor = client's first transaction with Y
 *     => SessionFee & { affiliateShareUsdCents, nhpNetUsdCents, rateScheduleId,
 *                       practitionerChargeUsdCents }   // practitionerChargeUsdCents = G - practitionerNet
 *
 *   createRateSchedule(fields)            => RateScheduleFields   (throws on any cap invariant)
 *   annualPlanAPriceCents(schedule)       => number
 *   recordRecruiter(existingRId, newRId)  => string | null        (first wins, immutable)
 *   reverseForRefund(fee, refundedCents, grossCents)
 *                                         => { affiliateReversedUsdCents, referrerReversedUsdCents,
 *                                              nhpReversedUsdCents }
 *   whopApplicationFeeCents(fee)          => number  (= nhpFee + referrerShare + (nhpFee == 0 ? affiliate : 0))
 * ---------------------------------------------------------------------------------------------
 */

type RateScheduleFields = {
  id: string;
  planAMonthlyCents: number;
  annualDiscountBps: number;
  planASourcedBps: number;
  planBMonthlyCents: number;
  planBSourcedBps: number;
  referralTotalBps: number;
  referrerBps: number;
  affiliateBps: number;
  leadTermMonths: number;
  referrerTermMonths: number;
  maxTotalFeeBps: number;
};

type FeeV15 = SessionFee & {
  affiliateShareUsdCents: number;
  nhpNetUsdCents: number;
  rateScheduleId: string;
  practitionerChargeUsdCents: number;
};

type ResolveInput = {
  plan: PlanKey;
  owner: AttributionOwner;
  referrerPractitionerId: string | null;
  priceUsdCents: number;
  schedule: RateScheduleFields | null;
  practitionerId: string;
  recruiterPractitionerId: string | null;
  anchorAt: Date;
  at: Date;
};

type FeeApi = {
  resolveSessionFee(input: ResolveInput): FeeV15;
  createRateSchedule(fields: RateScheduleFields): RateScheduleFields;
  annualPlanAPriceCents(schedule: RateScheduleFields): number;
  recordRecruiter(existing: string | null, incoming: string): string | null;
  reverseForRefund(
    fee: FeeV15,
    refundedCents: number,
    grossCents: number,
  ): { affiliateReversedUsdCents: number; referrerReversedUsdCents: number; nhpReversedUsdCents: number };
  whopApplicationFeeCents(fee: FeeV15): number;
};

const api: FeeApi = {
  resolveSessionFee: (input) => resolveSessionFee(input) as FeeV15,
  createRateSchedule: (fields) => createRateSchedule(fields) as unknown as RateScheduleFields,
  annualPlanAPriceCents,
  recordRecruiter,
  reverseForRefund: (fee, refunded, gross) => reverseForRefund(fee, refunded, gross),
  whopApplicationFeeCents: (fee) => whopApplicationFeeCents(fee),
};

const V1: RateScheduleFields = {
  id: 'rs_v1',
  planAMonthlyCents: 3900,
  annualDiscountBps: 2000,
  planASourcedBps: 1000,
  planBMonthlyCents: 0,
  planBSourcedBps: 3000,
  referralTotalBps: 3000,
  referrerBps: 2000,
  affiliateBps: 300,
  leadTermMonths: 8,
  referrerTermMonths: 4,
  maxTotalFeeBps: 3000,
};

const ANCHOR = new Date('2026-01-15T12:00:00.000Z');
const monthsAfter = (m: number, extraMs = 0) => {
  const d = new Date(ANCHOR);
  d.setUTCMonth(d.getUTCMonth() + m);
  return new Date(d.getTime() + extraMs);
};

const G = 10_000;

type Cents5 = [yKeeps: number, nhpCharge: number, referrer: number, affiliate: number, nhpNet: number];

type Row = {
  name: string;
  owner: AttributionOwner;
  referrer: string | null;
  at: Date;
  /** Recruited Y, Plan A (and Plan B where `planB` is absent). */
  recruited: Cents5;
  planB?: Cents5;
};

const rows: Row[] = [
  { name: 'Own client', owner: 'PRACTITIONER', referrer: null, at: monthsAfter(1), recruited: [9700, 300, 0, 300, 0] },
  {
    name: 'Sourced <=8mo',
    owner: 'NHP',
    referrer: null,
    at: monthsAfter(3),
    recruited: [9000, 1000, 0, 300, 700],
    planB: [7000, 3000, 0, 300, 2700],
  },
  { name: 'Referred <=4mo', owner: 'NHP', referrer: 'prac_X', at: monthsAfter(2), recruited: [7000, 1000, 2000, 300, 700] },
  {
    name: 'Referred 4-8mo',
    owner: 'NHP',
    referrer: 'prac_X',
    at: monthsAfter(6),
    recruited: [9000, 1000, 0, 300, 700],
    planB: [7000, 3000, 0, 300, 2700],
  },
  { name: 'Any >8mo', owner: 'NHP', referrer: 'prac_X', at: monthsAfter(9), recruited: [9700, 300, 0, 300, 0] },
];

function call(row: Row, plan: PlanKey, recruited: boolean, schedule: RateScheduleFields | null = V1) {
  return api.resolveSessionFee({
    plan,
    owner: row.owner,
    referrerPractitionerId: row.referrer,
    priceUsdCents: G,
    schedule,
    practitionerId: 'prac_Y',
    recruiterPractitionerId: recruited ? 'prac_R' : null,
    anchorAt: ANCHOR,
    at: row.at,
  });
}

const pick = (row: Row, plan: PlanKey): Cents5 => (plan === 'PLAN_B' && row.planB ? row.planB : row.recruited);

describe('spec v1.5 §1 fee table, $100 session, Y recruited by R', () => {
  for (const plan of ['PLAN_A', 'PLAN_B'] as PlanKey[]) {
    it.each(rows.map((r) => [r.name, r] as const))(`${plan}: %s`, (_n, row) => {
      const [keeps, nhp, ref, aff, net] = pick(row, plan);
      const fee = call(row, plan, true);
      expect(G - fee.practitionerChargeUsdCents).toBe(keeps);
      expect(fee.practitionerNetUsdCents).toBe(keeps);
      expect(fee.referrerShareUsdCents).toBe(ref);
      expect(fee.affiliateShareUsdCents).toBe(aff);
      expect(fee.nhpNetUsdCents).toBe(net);
      // "NHP charge" column: nhpFee, or the affiliate passed through to R when nhpFee is 0.
      expect(fee.nhpFeeUsdCents === 0 ? fee.affiliateShareUsdCents : fee.nhpFeeUsdCents).toBe(nhp);
    });
  }

  it('rows where plan is irrelevant are identical on Plan A and Plan B', () => {
    for (const name of ['Own client', 'Referred <=4mo', 'Any >8mo']) {
      const row = rows.find((r) => r.name === name)!;
      expect(call(row, 'PLAN_A', true)).toEqual(call(row, 'PLAN_B', true));
    }
  });
});

describe('spec v1.5 §1 fee table, Y NOT recruited', () => {
  for (const plan of ['PLAN_A', 'PLAN_B'] as PlanKey[]) {
    it.each(rows.map((r) => [r.name, r] as const))(`${plan}: %s`, (_n, row) => {
      const [, nhp, ref] = pick(row, plan);
      // The "passed to R" 300 on own-client and post-term rows is not charged at all.
      const expectedNhp = row.recruited[1] === 300 ? 0 : nhp;
      const fee = call(row, plan, false);
      expect(fee.affiliateShareUsdCents).toBe(0);
      expect(fee.nhpFeeUsdCents).toBe(expectedNhp);
      expect(fee.referrerShareUsdCents).toBe(ref);
      expect(fee.nhpNetUsdCents).toBe(expectedNhp);
      expect(fee.practitionerNetUsdCents).toBe(G - expectedNhp - ref);
    });
  }

  it('Y keeps 10000 on own clients and after the term', () => {
    expect(call(rows[0], 'PLAN_A', false).practitionerNetUsdCents).toBe(10_000);
    expect(call(rows[4], 'PLAN_B', false).practitionerNetUsdCents).toBe(10_000);
  });
});

describe('spec v1.5 §1 boundaries are EXCLUSIVE', () => {
  const referred = rows[2];

  it('1ms before referrerEnds (4mo) is still referred: 20% referrer + 10% NHP', () => {
    const fee = call({ ...referred, at: monthsAfter(4, -1) }, 'PLAN_B', false);
    expect(fee.referrerShareUsdCents).toBe(2000);
    expect(fee.nhpFeeUsdCents).toBe(1000);
  });

  it('exactly at referrerEnds (4mo) the plan rate applies and the referrer is dropped', () => {
    const a = call({ ...referred, at: monthsAfter(4) }, 'PLAN_A', false);
    expect(a.referrerShareUsdCents).toBe(0);
    expect(a.nhpFeeUsdCents).toBe(1000);
    const b = call({ ...referred, at: monthsAfter(4) }, 'PLAN_B', false);
    expect(b.referrerShareUsdCents).toBe(0);
    expect(b.nhpFeeUsdCents).toBe(3000);
  });

  it('1ms before leadEnds (8mo) is still charged at the plan rate', () => {
    const fee = call({ ...referred, at: monthsAfter(8, -1) }, 'PLAN_B', false);
    expect(fee.nhpFeeUsdCents).toBe(3000);
  });

  it('exactly at leadEnds (8mo) the practitioner fee is 0 on both plans', () => {
    for (const plan of ['PLAN_A', 'PLAN_B'] as PlanKey[]) {
      const fee = call({ ...referred, at: monthsAfter(8) }, plan, false);
      expect(fee.nhpFeeUsdCents).toBe(0);
      expect(fee.practitionerNetUsdCents).toBe(10_000);
    }
  });
});

describe('spec v1.5 §1 affiliate overlay and Whop application fee', () => {
  it('a recruited practitioner own-client $100 session charges $3 and nets NHP $0', () => {
    const fee = call(rows[0], 'PLAN_A', true);
    expect(fee.nhpFeeUsdCents).toBe(0);
    expect(fee.affiliateShareUsdCents).toBe(300);
    expect(fee.practitionerChargeUsdCents).toBe(300);
    expect(fee.nhpNetUsdCents).toBe(0);
    expect(api.whopApplicationFeeCents(fee)).toBe(300);
  });

  it('a recruited Plan A sourced session still charges $10 total', () => {
    const fee = call(rows[1], 'PLAN_A', true);
    expect(fee.practitionerChargeUsdCents).toBe(1000);
    expect(api.whopApplicationFeeCents(fee)).toBe(1000);
  });

  it('application_fee_amount = nhpFee + referrerShare + (nhpFee == 0 ? affiliate : 0)', () => {
    expect(api.whopApplicationFeeCents(call(rows[2], 'PLAN_A', true))).toBe(1000 + 2000);
    expect(api.whopApplicationFeeCents(call(rows[4], 'PLAN_A', true))).toBe(300);
  });

  it('a recruiter equal to the serving practitioner yields no affiliate', () => {
    const fee = api.resolveSessionFee({
      plan: 'PLAN_A',
      owner: 'NHP',
      referrerPractitionerId: null,
      priceUsdCents: G,
      schedule: V1,
      practitionerId: 'prac_Y',
      recruiterPractitionerId: 'prac_Y',
      anchorAt: ANCHOR,
      at: monthsAfter(1),
    });
    expect(fee.affiliateShareUsdCents).toBe(0);
    expect(fee.nhpNetUsdCents).toBe(1000);
  });

  it('shares floor independently and nhpNet is never negative (odd price $33.33)', () => {
    const fee = api.resolveSessionFee({
      plan: 'PLAN_B',
      owner: 'NHP',
      referrerPractitionerId: null,
      priceUsdCents: 3333,
      schedule: V1,
      practitionerId: 'prac_Y',
      recruiterPractitionerId: 'prac_R',
      anchorAt: ANCHOR,
      at: monthsAfter(1),
    });
    expect(fee.nhpFeeUsdCents).toBe(Math.floor((3333 * 3000) / 10_000));
    expect(fee.affiliateShareUsdCents).toBe(Math.floor((3333 * 300) / 10_000));
    expect(fee.nhpNetUsdCents).toBe(fee.nhpFeeUsdCents - fee.affiliateShareUsdCents);
    expect(fee.nhpNetUsdCents).toBeGreaterThanOrEqual(0);
  });

  it('application fee never exceeds floor(G * maxTotalFeeBps) on any table row', () => {
    for (const row of rows) {
      for (const plan of ['PLAN_A', 'PLAN_B'] as PlanKey[]) {
        for (const recruited of [true, false]) {
          const fee = call(row, plan, recruited);
          expect(api.whopApplicationFeeCents(fee)).toBeLessThanOrEqual(Math.floor((G * V1.maxTotalFeeBps) / 10_000));
        }
      }
    }
  });
});

describe('spec v1.5 §1 schedule creation rejects cap-invariant violations', () => {
  it('accepts the v1 schedule', () => {
    expect(() => api.createRateSchedule(V1)).not.toThrow();
  });

  const bad: Array<[string, Partial<RateScheduleFields>]> = [
    ['referralTotalBps 3500 > maxTotalFeeBps', { referralTotalBps: 3500 }],
    ['planASourcedBps > maxTotalFeeBps', { planASourcedBps: 3001 }],
    ['planBSourcedBps > maxTotalFeeBps', { planBSourcedBps: 3001 }],
    ['referrerBps > referralTotalBps', { referrerBps: 3001 }],
    ['referrerTermMonths > leadTermMonths', { referrerTermMonths: 9 }],
    ['planASourcedBps below affiliateBps', { planASourcedBps: 299 }],
    ['planBSourcedBps below affiliateBps', { planBSourcedBps: 299 }],
    ['referralTotalBps - referrerBps below affiliateBps', { referralTotalBps: 2200, referrerBps: 2000 }],
    ['affiliateBps > maxTotalFeeBps', { affiliateBps: 3001 }],
  ];
  it.each(bad)('rejects: %s', (_n, patch) => {
    expect(() => api.createRateSchedule({ ...V1, ...patch })).toThrow();
  });
});

describe('spec v1.5 §1 pricing, snapshots, recruiter, refunds, fail-closed', () => {
  it('annual Plan A price = 3900 * 12 * (1 - 0.2) = 37440', () => {
    expect(api.annualPlanAPriceCents(V1)).toBe(37_440);
  });

  it('a later schedule change leaves an in-term client fee unchanged (snapshot carries the schedule)', () => {
    const before = call(rows[1], 'PLAN_B', true, V1);
    expect(before.rateScheduleId).toBe('rs_v1');
    // A snapshot re-resolved against the schedule it was minted under is unchanged; only a NEW
    // schedule passed explicitly yields a different number.
    const v2: RateScheduleFields = { ...V1, id: 'rs_v2', planBSourcedBps: 2500 };
    expect(call(rows[1], 'PLAN_B', true, V1)).toEqual(before);
    expect(call(rows[1], 'PLAN_B', true, v2).nhpFeeUsdCents).toBe(2500);
  });

  it('recruiter is first-wins and immutable', () => {
    expect(api.recordRecruiter(null, 'prac_R')).toBe('prac_R');
    expect(api.recordRecruiter('prac_R', 'prac_Z')).toBe('prac_R');
  });

  it('a full refund reverses the affiliate share and the referrer share', () => {
    const fee = call(rows[2], 'PLAN_A', true);
    const rev = api.reverseForRefund(fee, G, G);
    expect(rev.affiliateReversedUsdCents).toBe(300);
    expect(rev.referrerReversedUsdCents).toBe(2000);
    expect(rev.nhpReversedUsdCents).toBe(fee.nhpFeeUsdCents);
  });

  it('a partial refund reverses affiliate and referrer pro rata, floored', () => {
    const fee = call(rows[2], 'PLAN_A', true);
    const rev = api.reverseForRefund(fee, 5000, G);
    expect(rev.affiliateReversedUsdCents).toBe(150);
    expect(rev.referrerReversedUsdCents).toBe(1000);
  });

  it('fail-closed: a practitioner with no schedule is refused, with no default charge', () => {
    expect(() => call(rows[1], 'PLAN_A', false, null)).toThrow();
  });
});
