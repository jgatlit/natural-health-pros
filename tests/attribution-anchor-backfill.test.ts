import { describe, it, expect } from 'vitest';

import { planAnchorRepairs } from '../scripts/backfill-attribution-anchors';

/**
 * The repair for rows that are `PENDING_ANCHOR` — chargeable, with no end date, so the client is
 * billed the platform share forever.
 *
 * Only the DECISION is tested. The script's Prisma half is a dry-run-by-default operator lever and
 * is deliberately not exercised here; what decides money is which date each row is anchored on,
 * and that is a pure function precisely so it can be asserted without a database.
 */
describe('planAnchorRepairs', () => {
  const row = (over: Partial<Parameters<typeof planAnchorRepairs>[0][number]> = {}) => ({
    id: 'ac_1',
    attributedAt: new Date('2026-01-10T00:00:00Z'),
    termMonths: null as number | null,
    ...over,
  });

  it('anchors a row on its OWN attributedAt — the first payment it recorded', () => {
    // ⚠️ NOT "now", and not the run date. `attributedAt` is stamped on the `payment.succeeded`
    // transition, so on these rows it IS the client's first payment — the instant the corrected
    // rule anchors on. Anchoring at run time would start the 8 months months after the
    // introduction and bill the practitioner well past the term they were sold.
    const { repairs } = planAnchorRepairs([row()], 8);
    expect(repairs).toEqual([
      {
        id: 'ac_1',
        termMonths: 8,
        termAnchorAt: new Date('2026-01-10T00:00:00Z'),
        termEndsAt: new Date('2026-09-10T00:00:00Z'),
      },
    ]);
  });

  it('keeps a term the row already carries instead of repricing it to today’s setting', () => {
    // R1 is forward-only. A row that was sold a 6-month term keeps it even if the operator has
    // since moved the admin setting to 8 — the snapshot is the enforcement of that rule, and a
    // backfill that re-read the setting would quietly re-open claims already closed.
    const { repairs } = planAnchorRepairs([row({ termMonths: 6 })], 8);
    expect(repairs[0]?.termMonths).toBe(6);
    expect(repairs[0]?.termEndsAt).toEqual(new Date('2026-07-10T00:00:00Z'));
  });

  it('SKIPS a row it cannot date rather than anchoring it at an invented instant', () => {
    // A repaired-but-wrongly-dated row looks fixed and bills wrong; a skipped one stays visibly
    // broken in /admin/attributions, which is the outcome somebody can act on.
    const { repairs, undatable } = planAnchorRepairs(
      [row({ id: 'ac_bad', attributedAt: null }), row({ id: 'ac_ok' })],
      8,
    );
    expect(undatable).toEqual(['ac_bad']);
    expect(repairs.map((r) => r.id)).toEqual(['ac_ok']);
  });
});
