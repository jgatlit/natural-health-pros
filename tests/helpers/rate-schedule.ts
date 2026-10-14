import type { RateSchedule, RateScheduleNumbers } from '@/lib/rate-schedule';

/**
 * Schedule v1 "Go-forward 2026-10", as seeded by the L1 migration. A TEST FIXTURE: the application
 * deliberately exports no default schedule (the database is the only source of rates), so tests
 * state the ruled numbers here, once, and `rate-schedule-hash.test.ts` proves they match the SQL.
 */
export const V1_NUMBERS: RateScheduleNumbers = {
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

export const V1: RateSchedule = { id: 'rs_go_forward_2026_10', label: 'Go-forward 2026-10', ...V1_NUMBERS };

/** A different, valid schedule (Plan B cheaper, Plan A pricier) for "a later change" tests. */
export const V2: RateSchedule = {
  id: 'rs_v2',
  label: 'Founding',
  ...V1_NUMBERS,
  planAMonthlyCents: 2900,
  planASourcedBps: 500,
  planBSourcedBps: 2000,
};

/** Rows in the order a Prisma `findUnique` would return them, keyed for a fake `rateSchedule`. */
export function scheduleRows(...schedules: RateSchedule[]) {
  return new Map(schedules.map((s) => [s.id, s]));
}
