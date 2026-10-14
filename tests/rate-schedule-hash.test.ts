import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canonicalRateScheduleString,
  RATE_SCHEDULE_FIELDS,
  type RateScheduleNumbers,
} from '@/lib/rate-schedule';
import { createRateSchedule, rateScheduleContentHash } from '@/lib/rate-schedule-hash';
import { V1_NUMBERS } from './helpers/rate-schedule';

/**
 * THE MIGRATION SEEDS SCHEDULE v1 WITH A HASH LITERAL, AND THIS IS WHAT KEEPS IT HONEST.
 *
 * Admin "save" is find-by-`contentHash`. If the literal in the SQL ever differs from what the
 * application computes for the same numbers, the first admin save of those numbers silently creates
 * a DUPLICATE of v1 — and a cohort that should share one id forks into two. So this test reads the
 * migration file itself (not a copy of it) and fails if either the literal or any seeded number
 * drifts from the code.
 */

const MIGRATION = join(
  process.cwd(),
  'prisma',
  'migrations',
  '20261014150000_rate_schedules_fee_rule_v15',
  'migration.sql',
);
const sql = readFileSync(MIGRATION, 'utf8');

/** The column list and VALUES tuple of the seed INSERT, parsed rather than assumed. */
function seededRow(): { id: string; hash: string; label: string; numbers: RateScheduleNumbers } {
  const m = sql.match(/INSERT INTO "RateSchedule" \(([\s\S]*?)\) VALUES \(([\s\S]*?)\)\s*ON CONFLICT/);
  if (!m) throw new Error('seed INSERT not found in the migration');
  const cols = m[1].split(',').map((c) => c.trim().replace(/"/g, ''));
  const vals = m[2].split(',').map((v) => v.trim());
  const row = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
  const unquote = (s: string) => s.replace(/^'|'$/g, '');
  const numbers = {} as RateScheduleNumbers;
  for (const f of RATE_SCHEDULE_FIELDS) {
    const raw = row[f];
    if (raw === undefined) throw new Error(`seed row has no ${f}`);
    numbers[f] = Number(raw);
  }
  return { id: unquote(row.id), hash: unquote(row.contentHash), label: unquote(row.label), numbers };
}

describe('schedule v1 seed in the migration SQL', () => {
  it('hash(v1 fields) === the contentHash literal in the migration, parsed out of the file', () => {
    const seeded = seededRow();
    expect(rateScheduleContentHash(V1_NUMBERS)).toBe(seeded.hash);
  });

  it('the numbers seeded in SQL are exactly the ruled v1 numbers (O1–O8)', () => {
    expect(seededRow().numbers).toEqual(V1_NUMBERS);
  });

  it('the hash recomputed from the SQL’s OWN numbers equals the SQL’s literal', () => {
    const seeded = seededRow();
    expect(rateScheduleContentHash(seeded.numbers)).toBe(seeded.hash);
  });

  it('every other reference to the literal in the migration is the same literal', () => {
    const seeded = seededRow();
    const literals = Array.from(sql.matchAll(/'([0-9a-f]{64})'/g)).map((x) => x[1]);
    expect(literals.length).toBeGreaterThanOrEqual(3);
    expect(new Set(literals)).toEqual(new Set([seeded.hash]));
  });

  it('seeds a fixed id and the v1 label, and v1 itself passes every invariant', () => {
    const seeded = seededRow();
    expect(seeded.id).toBe('rs_go_forward_2026_10');
    expect(seeded.label).toBe('Go-forward 2026-10');
    expect(() => createRateSchedule(seeded.numbers)).not.toThrow();
  });

  it('is idempotent in SQL: ON CONFLICT on the content hash, a guarded backfill, a guarded history insert', () => {
    expect(sql).toMatch(/ON CONFLICT \("contentHash"\) DO NOTHING/);
    expect(sql).toMatch(/ON CONFLICT \("key"\) DO NOTHING/);
    expect(sql).toMatch(/WHERE "rateScheduleId" IS NULL/);
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM "RateScheduleAssignment"/);
    expect(sql).toContain("'current_rate_schedule_id'");
  });

  it('is expand-only: no DROP, no RENAME, no NOT NULL on the new foreign key', () => {
    const noComments = sql.replace(/--.*$/gm, '');
    expect(noComments).not.toMatch(/\bDROP\b/i);
    expect(noComments).not.toMatch(/\bRENAME\b/i);
    expect(noComments).toMatch(/ADD COLUMN\s+"rateScheduleId" TEXT;/);
  });
});

describe('the canonical hash', () => {
  it('is a sha256 hex digest of a fixed-order serialisation', () => {
    expect(rateScheduleContentHash(V1_NUMBERS)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalRateScheduleString(V1_NUMBERS).split('\n')[0]).toBe('rate-schedule/v1');
  });

  it('does not depend on the key order of the object it is given', () => {
    const shuffled = Object.fromEntries(
      Object.entries(V1_NUMBERS).reverse(),
    ) as unknown as RateScheduleNumbers;
    expect(rateScheduleContentHash(shuffled)).toBe(rateScheduleContentHash(V1_NUMBERS));
  });

  it('ignores the label, the id and any extra columns — identity is the numbers only', () => {
    const withExtras = { ...V1_NUMBERS, id: 'x', label: 'Renamed', createdAt: new Date() } as unknown as RateScheduleNumbers;
    expect(rateScheduleContentHash(withExtras)).toBe(rateScheduleContentHash(V1_NUMBERS));
  });

  it('changes when ANY single field changes (so no field silently falls out of identity)', () => {
    const base = rateScheduleContentHash(V1_NUMBERS);
    for (const f of RATE_SCHEDULE_FIELDS) {
      const changed = { ...V1_NUMBERS, [f]: V1_NUMBERS[f] + 1 };
      expect(rateScheduleContentHash(changed), f).not.toBe(base);
    }
  });

  it('refuses to hash a non-integer, so "3900" and 3900.0 cannot alias different rows', () => {
    expect(() => rateScheduleContentHash({ ...V1_NUMBERS, planAMonthlyCents: 39.5 })).toThrow();
    expect(() =>
      rateScheduleContentHash({ ...V1_NUMBERS, planAMonthlyCents: '3900' as unknown as number }),
    ).toThrow();
  });
});
