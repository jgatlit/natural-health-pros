import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE ATTRIBUTED-CLIENT SCHEDULE BACKFILL (review round 1, MAJOR 2).
 *
 * Without it, a client row that existed at deploy has a NULL `rateScheduleId`, the fee path falls
 * back to the practitioner's CURRENT schedule, and the first cohort migration silently re-prices
 * every pre-v1.5 client still in term. Verified against a real Postgres (Docker, baseline schema +
 * the migrations in folder order) when it was written; these tests keep the file honest.
 */

const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const NEW = '20261014152000_attributed_client_schedule_backfill';
const FIRST = '20261014150000_rate_schedules_fee_rule_v15';

const sql = (dir: string) => readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
const code = (dir: string) => sql(dir).replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();

describe('20261014152000_attributed_client_schedule_backfill', () => {
  it('is exactly one idempotent UPDATE that fills NULL snapshots from the practitioner’s schedule', () => {
    expect(code(NEW)).toBe(
      'UPDATE "AttributedClient" SET "rateScheduleId" = p."rateScheduleId" FROM "Practitioner" p ' +
        'WHERE "AttributedClient"."practitionerId" = p."id" AND "AttributedClient"."rateScheduleId" IS NULL ' +
        'AND p."rateScheduleId" IS NOT NULL;',
    );
  });

  it('never overwrites a snapshot, and is expand-only (no DDL at all)', () => {
    const c = code(NEW);
    expect(c).toMatch(/"AttributedClient"\."rateScheduleId" IS NULL/);
    expect(c).not.toMatch(/\b(DROP|RENAME|ALTER|CREATE|DELETE|TRUNCATE)\b/i);
  });

  it('leaves the referrer-term snapshot columns NULL, and says why', () => {
    expect(code(NEW)).not.toMatch(/referrerTerm/);
    expect(sql(NEW)).toMatch(/referrerTermMonths[\s\S]*left NULL on\s*-- purpose/);
  });

  it('sorts AFTER the migration that creates the column and BEFORE the later ones, in folder order', () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
    expect(dirs.indexOf(NEW)).toBeGreaterThan(dirs.indexOf(FIRST));
    expect(dirs.indexOf(NEW)).toBe(dirs.indexOf(FIRST) + 1);
    expect(sql(FIRST)).toMatch(/ADD COLUMN\s+"rateScheduleId" TEXT/);
  });
});

describe('the first L1 migration was already applied by a preview and must never change', () => {
  it('is byte-identical to the version a72669f shipped (sha256 pin)', () => {
    const hash = createHash('sha256').update(readFileSync(join(MIGRATIONS, FIRST, 'migration.sql'))).digest('hex');
    expect(hash).toBe('39e1edacd15118add5f4aacb1d98780be2f53d2b9c5bd09174218cb6e1fd81da');
  });
});
