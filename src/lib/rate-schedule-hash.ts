/**
 * THE ONE CANONICAL HASH FUNCTION for rate schedules (spec v1.5 §2) — server-only, because it uses
 * `node:crypto` (the pure rules in `rate-schedule.ts` must stay browser-safe).
 *
 * `RateSchedule.contentHash` is `sha256(canonicalRateScheduleString(numbers))`. Two things depend
 * on this being the single definition:
 *
 *   1. admin "save" is find-by-hash — the same numbers must always find the same row, or the
 *      cohort model silently forks into N copies of the same card;
 *   2. the migration SQL seeds schedule v1 with a hash LITERAL produced by this function, and
 *      `tests/rate-schedule-hash.test.ts` parses that literal back out of the migration file and
 *      asserts equality, so SQL and code cannot drift apart unnoticed.
 */

import { createHash } from 'node:crypto';

import {
  assertRateScheduleValid,
  canonicalRateScheduleString,
  scheduleNumbers,
  type RateScheduleNumbers,
} from './rate-schedule';

/** sha256 hex over the canonical serialisation. This is the `RateSchedule.contentHash`. */
export function rateScheduleContentHash(f: RateScheduleNumbers): string {
  return createHash('sha256').update(canonicalRateScheduleString(f)).digest('hex');
}

/**
 * Validate and return the numbers with their hash, ready to store. The single pre-write gate: the
 * admin action and `findOrCreateSchedule` both go through it, so there is no path to a stored
 * schedule that has not passed every invariant ("the cap cannot be bypassed via admin").
 */
export function createRateSchedule(
  f: Partial<RateScheduleNumbers> & { id?: string },
): RateScheduleNumbers & { contentHash: string } {
  assertRateScheduleValid(f);
  const numbers = scheduleNumbers(f);
  return { ...numbers, contentHash: rateScheduleContentHash(numbers) };
}
