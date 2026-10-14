/**
 * APPLY ENTRY POINT of the v1.5 reconcile, and the ONLY file that writes.
 *
 *   RECONCILE_DATABASE_URL=... RECONCILE_CONFIRM=<today UTC> npx tsx scripts/reconcile-referral-v15-apply.ts
 *
 * The guards live INSIDE `runApply()`, so any caller (the CLI below, a test, another script) is
 * guarded; there is no way to reach the writer around them:
 *   - RECONCILE_CONFIRM must equal today's date (UTC);
 *   - the host must be local (localhost / 127.0.0.1 / ::1) unless `--i-know-this-is-production` is
 *     also passed. This is an allow-list, not a deny-list of hosting providers, so a production
 *     database behind a tunnel or a custom host name is refused too;
 *   - applying needs the operator's sign-off on the dry run's nhpExcessUsdCents and
 *     practitionerOverchargedUsdCents totals (the log says so).
 *
 * It reuses the read-only collector (SET read-only first, SHOW must say on), then writes in ONE
 * `BEGIN READ WRITE` transaction, which is what lets it past the session's read-only default. For
 * each repriced row an audit marker keyed `REPRICE_V15:<ledger id>` (unique) is inserted first, and
 * the share is changed only if the marker was new AND the share and state still match what was
 * read. Any unexpected row count rolls the whole batch back.
 */

import { collectReconcile, type LedgerRow, type PgLike, type RunSummary } from './reconcile-referral-v15';
import type { RepriceChange } from '../src/lib/referral-reprice';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Returns a refusal message, or null when applying is allowed. */
export function checkApplyGuards(args: {
  argv: string[];
  env: Record<string, string | undefined>;
  host: string;
  now: Date;
}): string | null {
  const today = args.now.toISOString().slice(0, 10);
  if (args.env.RECONCILE_CONFIRM !== today) {
    return `apply needs RECONCILE_CONFIRM=${today} (today's date, UTC)`;
  }
  if (!LOCAL_HOSTS.has(args.host.toLowerCase()) && !args.argv.includes('--i-know-this-is-production')) {
    return `host ${args.host} is not local: apply also needs --i-know-this-is-production`;
  }
  return null;
}

export async function applyRepricing(
  client: PgLike,
  items: Array<{ row: LedgerRow; decision: RepriceChange }>,
  now: Date,
): Promise<{ applied: number; alreadyApplied: number }> {
  let applied = 0;
  let alreadyApplied = 0;
  await client.query('BEGIN READ WRITE');
  try {
    for (const { row, decision } of items) {
      const marker = await client.query(
        `INSERT INTO "FeeLedgerEntry"
           ("id", "kind", "status", "bookingIntentId", "practitionerId", "amountUsdCents", "note", "dedupeKey", "updatedAt")
         VALUES ('repr_' || replace(gen_random_uuid()::text, '-', ''), 'ADMIN_ADJUSTMENT', 'SETTLED', $1, $2, $3, $4, $5, $6)
         ON CONFLICT ("dedupeKey") DO NOTHING
         RETURNING "id"`,
        [
          row.bookingIntentId,
          row.referrerPractitionerId,
          decision.deltaUsdCents,
          JSON.stringify({
            reason: 'fee rule v1.5 re-price',
            ledgerEntryId: row.id,
            from: decision.currentShareUsdCents,
            to: decision.newShareUsdCents,
            detail: decision.reason,
          }),
          `REPRICE_V15:${row.id}`,
          now,
        ],
      );
      if (marker.rows.length === 0) {
        alreadyApplied += 1;
        continue;
      }
      const changed = await client.query(
        `UPDATE "ReferralLedgerEntry"
            SET "referrerShareUsdCents" = $2, "grossShareUsdCents" = $2, "updatedAt" = $4
          WHERE "id" = $1 AND "referrerShareUsdCents" = $3 AND "state" IN ('PAYABLE', 'HELD', 'EXPIRED_UNCLAIMED')`,
        [row.id, decision.newShareUsdCents, decision.currentShareUsdCents, now],
      );
      if (changed.rowCount !== 1) {
        throw new Error(`ledger row ${row.id} changed under the reconcile (rowCount ${changed.rowCount}); rolled back`);
      }
      applied += 1;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  return { applied, alreadyApplied };
}

export async function runApply(
  client: PgLike,
  opts: {
    argv: string[];
    env: Record<string, string | undefined>;
    host: string;
    now: Date;
    log: (line: Record<string, unknown>) => void;
  },
): Promise<RunSummary> {
  const refusal = checkApplyGuards(opts);
  if (refusal) throw new Error(refusal);

  const { summary, planned } = await collectReconcile(client, { mode: 'apply', log: opts.log });
  opts.log({ event: 'sign-off-required', note: summary.note });
  if (planned.length > 0) {
    const out = await applyRepricing(
      client,
      planned.map((p) => ({ row: p.row, decision: p.decision })),
      opts.now,
    );
    summary.applied = out.applied;
    summary.alreadyApplied = out.alreadyApplied;
  }
  opts.log({ event: 'summary', ...summary });
  return summary;
}

async function main(): Promise<void> {
  const url = process.env.RECONCILE_DATABASE_URL;
  if (!url) {
    console.error('RECONCILE_DATABASE_URL is required (no other variable is read).');
    process.exit(2);
  }
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url });
  // Guards run before the first connection is opened.
  const refusal = checkApplyGuards({
    argv: process.argv,
    env: process.env,
    host: new URL(url).hostname,
    now: new Date(),
  });
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }
  await client.connect();
  try {
    await runApply(client as unknown as PgLike, {
      argv: process.argv,
      env: process.env,
      host: new URL(url).hostname,
      now: new Date(),
      log: (line) => console.log(JSON.stringify(line)),
    });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && /reconcile-referral-v15-apply\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
