import { describe, expect, it } from 'vitest';

import {
  assertRateScheduleValid,
  PLATFORM_FEE_CEILING_BPS,
  parseScheduleForm,
  planMonthlyCents,
  planSourcedBps,
  rateScheduleViolations,
  RateScheduleInvariantError,
  SCHEDULE_FORM_FIELDS,
  toFormValue,
  type RateScheduleNumbers,
} from '@/lib/rate-schedule';
import { createRateSchedule } from '@/lib/rate-schedule-hash';
import { V1_NUMBERS } from './helpers/rate-schedule';

describe('rate schedule invariants (spec v1.5 §1) — every one, at creation', () => {
  it('v1 is valid', () => {
    expect(rateScheduleViolations(V1_NUMBERS)).toEqual([]);
  });

  const bad: Array<[string, Partial<RateScheduleNumbers>]> = [
    ['referralTotalBps above the cap', { referralTotalBps: 3_500 }],
    ['Plan A rate above the cap', { planASourcedBps: 3_001 }],
    ['Plan B rate above the cap', { planBSourcedBps: 3_001 }],
    ['referrer share above the referral total', { referrerBps: 3_001 }],
    ['referrer term longer than the lead term', { referrerTermMonths: 9 }],
    ['Plan A rate below the affiliate share', { planASourcedBps: 299 }],
    ['Plan B rate below the affiliate share', { planBSourcedBps: 299 }],
    ['NHP’s referral remainder below the affiliate share', { referralTotalBps: 2_200, referrerBps: 2_000 }],
    ['affiliate above the cap', { affiliateBps: 3_001 }],
    ['a cap above the platform ceiling', { maxTotalFeeBps: 3_001 }],
    ['negative rate', { planASourcedBps: -1 }],
    ['fractional cents', { planAMonthlyCents: 39.5 }],
    ['zero lead term', { leadTermMonths: 0 }],
    ['zero referrer term', { referrerTermMonths: 0 }],
    ['bps above 100%', { annualDiscountBps: 10_001 }],
  ];
  it.each(bad)('rejects: %s', (_name, patch) => {
    expect(rateScheduleViolations({ ...V1_NUMBERS, ...patch }).length).toBeGreaterThan(0);
    expect(() => createRateSchedule({ ...V1_NUMBERS, ...patch })).toThrow(RateScheduleInvariantError);
  });

  it('THE CEILING IS NOT ADMIN-REACHABLE: raising maxTotalFeeBps cannot launder a 35% rate', () => {
    // A schedule can name its own cap, so an admin could try to lift the cap and the rate together.
    const attempt = { ...V1_NUMBERS, maxTotalFeeBps: 4_000, planBSourcedBps: 3_500, referralTotalBps: 3_500 };
    expect(() => createRateSchedule(attempt)).toThrow(/platform ceiling/);
    expect(PLATFORM_FEE_CEILING_BPS).toBe(3_000);
  });

  it('reports every violation at once, not just the first (the admin form lists them live)', () => {
    const v = rateScheduleViolations({ ...V1_NUMBERS, planASourcedBps: 4_000, referralTotalBps: 3_500 });
    expect(v.length).toBeGreaterThanOrEqual(2);
  });

  it('accepts a zero NHP rate (NHP charges nothing; the practitioner bears the affiliate)', () => {
    expect(rateScheduleViolations({ ...V1_NUMBERS, planBSourcedBps: 0 })).toEqual([]);
  });

  it('a lower, still-valid schedule is accepted', () => {
    expect(() =>
      createRateSchedule({ ...V1_NUMBERS, planASourcedBps: 500, planBSourcedBps: 2_000, referralTotalBps: 2_500 }),
    ).not.toThrow();
  });

  it('assertRateScheduleValid throws the typed error', () => {
    expect(() => assertRateScheduleValid({ ...V1_NUMBERS, planBSourcedBps: 9_999 })).toThrow(
      RateScheduleInvariantError,
    );
  });
});

describe('plan accessors', () => {
  it('read the right plan', () => {
    expect(planSourcedBps(V1_NUMBERS, 'PLAN_A')).toBe(1_000);
    expect(planSourcedBps(V1_NUMBERS, 'PLAN_B')).toBe(3_000);
    expect(planMonthlyCents(V1_NUMBERS, 'PLAN_A')).toBe(3_900);
    expect(planMonthlyCents(V1_NUMBERS, 'PLAN_B')).toBe(0);
  });
});

describe('admin form units', () => {
  const form = (over: Record<string, string> = {}) => {
    const values: Record<string, string> = Object.fromEntries(
      SCHEDULE_FORM_FIELDS.map((f) => [f.name, toFormValue(f.unit, V1_NUMBERS[f.field])]),
    );
    return (name: string) => ({ ...values, ...over })[name];
  };

  it('round-trips v1 through the form representation', () => {
    expect(parseScheduleForm(form())).toEqual(V1_NUMBERS);
  });

  it('shows dollars, percent and months the way an operator types them', () => {
    expect(toFormValue('dollars', 3_900)).toBe('39');
    expect(toFormValue('percent', 1_000)).toBe('10');
    expect(toFormValue('percent', 1_250)).toBe('12.5');
    expect(toFormValue('months', 8)).toBe('8');
  });

  it('parses 12.5% as 1250 bps and $49.50 as 4950 cents', () => {
    const p = parseScheduleForm(form({ planASourced: '12.5', planAMonthly: '49.50' }));
    expect(p.planASourcedBps).toBe(1_250);
    expect(p.planAMonthlyCents).toBe(4_950);
  });

  it('an unparseable or fractional-month field is a VIOLATION, never a silent zero', () => {
    for (const bad of ['', 'abc', '-5', '1e3', '10%', '8.5']) {
      const p = parseScheduleForm(form({ leadTerm: bad }));
      expect(rateScheduleViolations(p).join(' '), JSON.stringify(bad)).toMatch(/leadTermMonths/);
    }
    const p = parseScheduleForm(form({ planBSourced: 'thirty' }));
    expect(rateScheduleViolations(p).join(' ')).toMatch(/planBSourcedBps/);
  });

  it('a 35% referral total typed into the form is rejected', () => {
    const p = parseScheduleForm(form({ referralTotal: '35' }));
    expect(rateScheduleViolations(p).length).toBeGreaterThan(0);
  });
});
