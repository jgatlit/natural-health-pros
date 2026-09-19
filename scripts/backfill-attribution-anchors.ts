/**
 * REPAIR LEVER — anchors every `AttributedClient` row whose term clock never started.
 * DRY RUN BY DEFAULT; --apply is the only thing that writes.
 *
 *   npx tsx --env-file=.env scripts/backfill-attribution-anchors.ts            # report only
 *   npx tsx --env-file=.env scripts/backfill-attribution-anchors.ts --apply    # write
 *
 * WHY THIS EXISTS
 * A row with `termAnchorAt` null is `PENDING_ANCHOR`: chargeable, with NO end date. That is not
 * "the clock has not started yet" — it is the clock NEVER starting, so the practitioner is billed
 * the platform share on that client forever. It is the 8-month promise inverted.
 *
 * WHO IS IN THAT STATE
 * Nothing this release writes can be: since the 2026-09-19 operator correction the anchor is the
 * transaction instant, `snapshotTerm()` refuses a null one, and `recordAttributedClient()` repairs
 * a legacy row on its next payment. Two populations are left over, and neither can fix itself:
 *
 *   1. rows written before the term columns existed (the `AttributedClient` table shipped to
 *      production in `20260918000000_plan_choice_and_attribution`, three migrations before the
 *      term columns), and
 *   2. rows the PREVIOUS deploy inserts during the migration window, which knows nothing about
 *      those columns and leaves them null.
 *
 * Both only self-heal if that client pays that practitioner again. For anyone who does not, this
 * script is the repair.
 *
 * WHY `attributedAt` IS THE RIGHT ANCHOR
 * The ledger write has always run on the `payment.succeeded` transition, and `attributedAt` is
 * stamped there — so on these rows it IS the client's first payment instant, which is exactly what
 * the corrected rule anchors on. This backfill is possible ONLY because of that correction: under
 * the superseded scheduled-start rule the anchor was a third-party scheduler's claim that we do
 * not store and often cannot read, so there was nothing to recover it from.
 *
 * WHAT IT WILL NOT DO
 * It never touches an already-anchored row — the clock is immutable once set (R1, forward-only),
 * and re-anchoring one would silently move a claim already sold. `termMonths` is preserved when
 * the row carries one; only a row that has none takes today's admin setting.
 */
import { PrismaClient } from '@prisma/client';

import { snapshotTerm } from '../src/lib/attribution-term';
import { loadSettings } from '../src/lib/platform-settings';

/** Just enough of a row to decide its repair — so the decision is testable without a database. */
export type UnanchoredRow = {
  id: string;
  attributedAt: Date | null;
  termMonths: number | null;
};

export type AnchorRepair = {
  id: string;
  termMonths: number;
  termAnchorAt: Date;
  termEndsAt: Date;
};

/**
 * The whole decision, as a pure function.
 *
 * A row with no `attributedAt` is SKIPPED rather than anchored at "now". Anchoring a row we cannot
 * date would start its 8 months today — months after the introduction it is meant to measure — and
 * bill the practitioner past the term they were sold. A skipped row stays visibly broken in
 * /admin/attributions, which is the honest outcome; a wrongly-dated one looks repaired.
 */
export function planAnchorRepairs(
  rows: UnanchoredRow[],
  defaultTermMonths: number,
): { repairs: AnchorRepair[]; undatable: string[] } {
  const repairs: AnchorRepair[] = [];
  const undatable: string[] = [];
  for (const row of rows) {
    if (!row.attributedAt) {
      undatable.push(row.id);
      continue;
    }
    const termMonths = row.termMonths ?? defaultTermMonths;
    const term = snapshotTerm({ termMonths, anchorAt: row.attributedAt });
    repairs.push({
      id: row.id,
      termMonths: term.termMonths,
      termAnchorAt: term.termAnchorAt,
      termEndsAt: term.termEndsAt,
    });
  }
  return { repairs, undatable };
}

const apply = process.argv.includes('--apply');

async function main() {
  const prisma = new PrismaClient();
  try {
    const { leadAttributionTermMonths } = await loadSettings(prisma);

    const rows = (await prisma.attributedClient.findMany({
      where: { termAnchorAt: null },
      select: { id: true, attributedAt: true, termMonths: true, practitionerId: true },
      orderBy: { attributedAt: 'asc' },
    })) as (UnanchoredRow & { practitionerId: string })[];

    const { repairs, undatable } = planAnchorRepairs(rows, leadAttributionTermMonths);

    console.log(`unanchored rows: ${rows.length}`);
    console.log(`repairable:      ${repairs.length}`);
    console.log(`undatable:       ${undatable.length}${undatable.length ? ` (${undatable.join(', ')})` : ''}`);
    for (const r of repairs) {
      console.log(
        `  ${r.id}  ${r.termAnchorAt.toISOString()} → ${r.termEndsAt.toISOString()} (${r.termMonths} months)`,
      );
    }

    if (!apply) {
      console.log('\nDRY RUN — nothing written. Re-run with --apply.');
      return;
    }

    let written = 0;
    for (const r of repairs) {
      // `termAnchorAt: null` stays in the filter even though it was just read that way: a payment
      // arriving mid-run anchors the row itself, and this must lose that race rather than win it.
      const res = await prisma.attributedClient.updateMany({
        where: { id: r.id, termAnchorAt: null },
        data: { termAnchorAt: r.termAnchorAt, termEndsAt: r.termEndsAt, termMonths: r.termMonths },
      });
      written += res.count;
    }
    console.log(`\nwrote ${written} of ${repairs.length} (a shortfall means a payment anchored it first)`);
  } finally {
    await prisma.$disconnect();
  }
}

// Only when executed, never on import — the pure helper above is unit-tested.
if (process.argv[1] && process.argv[1].endsWith('backfill-attribution-anchors.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
