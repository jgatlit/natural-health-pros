/**
 * RECONCILE REFERRAL LEDGER ROWS MINTED BEFORE FEE RULE v1.5 (spec v1.5 section 4).
 *
 * The rule is `repriceReferralRow()` in src/lib/referral-reprice.ts; this file only reads rows,
 * logs one JSON line per decision, and (only when asked) hands the decisions to the apply module.
 *
 * DEFAULT MODE IS A DRY RUN. It issues SELECT, SHOW and one session SET, nothing else. Its first
 * statement forces the connection read-only, and it refuses to continue unless the server confirms
 * that. The statements that write live in a separate file (reconcile-referral-v15-apply.ts), which
 * is loaded only after every guard below has passed.
 *
 *   RECONCILE_DATABASE_URL=postgres://... npx tsx scripts/reconcile-referral-v15.ts
 *
 * The URL comes from RECONCILE_DATABASE_URL and nowhere else. No env file is read and there is no
 * fallback to a production variable.
 *
 * --apply additionally requires RECONCILE_CONFIRM=<today's date, YYYY-MM-DD, UTC>, and refuses a
 * *.neon.tech host unless --i-know-this-is-production is also passed. Running on production is a
 * pre-activation operator step, not part of the build.
 */

import { repriceReferralRow, type RepriceChange, type RepriceDecision } from '../src/lib/referral-reprice';

export type PgLike = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};

export type LedgerRow = {
  id: string;
  bookingIntentId: string;
  referrerPractitionerId: string;
  state: string;
  grossUsdCents: number;
  referrerShareUsdCents: number;
  collectedFeeUsdCents: number;
  paidAt: Date;
  anchorAt: Date | null;
  storedReferrerTermMonths: number | null;
  storedLeadTermMonths: number | null;
  schedReferrerBps: number | null;
  schedTotalBps: number | null;
  schedReferrerTermMonths: number | null;
  schedLeadTermMonths: number | null;
};

/** Rows priced before the schedule existed: their fee snapshot carries no schedule id. */
export const SELECT_PRE_V15_ROWS = `
SELECT r."id", r."bookingIntentId", r."referrerPractitionerId", r."state"::text AS "state",
       r."grossUsdCents", r."referrerShareUsdCents", r."collectedFeeUsdCents",
       (r."createdAt" AT TIME ZONE 'UTC') AS "paidAt",
       (COALESCE(ac."termAnchorAt", ac."attributedAt") AT TIME ZONE 'UTC') AS "anchorAt",
       ac."referrerTermMonths" AS "storedReferrerTermMonths",
       ac."termMonths" AS "storedLeadTermMonths",
       s."referrerBps" AS "schedReferrerBps",
       s."referralTotalBps" AS "schedTotalBps",
       s."referrerTermMonths" AS "schedReferrerTermMonths",
       s."leadTermMonths" AS "schedLeadTermMonths"
  FROM "ReferralLedgerEntry" r
  LEFT JOIN "BookingFeeSnapshot" f ON f."bookingIntentId" = r."bookingIntentId"
  LEFT JOIN "AttributedClient" ac
         ON ac."practitionerId" = r."servingPractitionerId" AND ac."emailHash" = r."clientEmailHash"
  LEFT JOIN "Practitioner" sp ON sp."id" = r."servingPractitionerId"
  LEFT JOIN "RateSchedule" s ON s."id" = COALESCE(ac."rateScheduleId", sp."rateScheduleId")
 WHERE f."rateScheduleId" IS NULL
 ORDER BY r."createdAt", r."id"`;

export type RunOptions = {
  apply: boolean;
  now: Date;
  log: (line: Record<string, unknown>) => void;
};

export type RunSummary = {
  mode: 'dry-run' | 'apply';
  rows: number;
  reprice: number;
  noop: number;
  flaggedSettled: number;
  skipped: number;
  totalDeltaUsdCents: number;
  nhpOverCollectedUsdCents: number;
  applied: number;
  alreadyApplied: number;
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toDecision(r: LedgerRow): RepriceDecision {
  const haveSchedule =
    r.schedReferrerBps !== null &&
    r.schedTotalBps !== null &&
    r.schedReferrerTermMonths !== null &&
    r.schedLeadTermMonths !== null;
  return repriceReferralRow({
    id: r.id,
    state: r.state,
    grossUsdCents: r.grossUsdCents,
    referrerShareUsdCents: r.referrerShareUsdCents,
    collectedFeeUsdCents: r.collectedFeeUsdCents,
    paidAt: r.paidAt,
    anchorAt: r.anchorAt,
    storedReferrerTermMonths: r.storedReferrerTermMonths,
    storedLeadTermMonths: r.storedLeadTermMonths,
    schedule: haveSchedule
      ? {
          referrerBps: r.schedReferrerBps as number,
          referralTotalBps: r.schedTotalBps as number,
          referrerTermMonths: r.schedReferrerTermMonths as number,
          leadTermMonths: r.schedLeadTermMonths as number,
        }
      : null,
  });
}

export async function runReconcile(client: PgLike, opts: RunOptions): Promise<RunSummary> {
  // FIRST STATEMENT, ALWAYS: read-only by default for every statement that follows.
  await client.query('SET default_transaction_read_only = on');
  const shown = await client.query('SHOW default_transaction_read_only');
  const value = shown.rows[0] && Object.values(shown.rows[0])[0];
  if (value !== 'on') {
    throw new Error(`refusing to continue: default_transaction_read_only is '${String(value)}', expected 'on'`);
  }

  const res = await client.query(SELECT_PRE_V15_ROWS);
  const rows: LedgerRow[] = res.rows.map((r) => ({
    id: String(r.id),
    bookingIntentId: String(r.bookingIntentId),
    referrerPractitionerId: String(r.referrerPractitionerId),
    state: String(r.state),
    grossUsdCents: Number(r.grossUsdCents),
    referrerShareUsdCents: Number(r.referrerShareUsdCents),
    collectedFeeUsdCents: Number(r.collectedFeeUsdCents),
    paidAt: new Date(r.paidAt as string | Date),
    anchorAt: r.anchorAt ? new Date(r.anchorAt as string | Date) : null,
    storedReferrerTermMonths: num(r.storedReferrerTermMonths),
    storedLeadTermMonths: num(r.storedLeadTermMonths),
    schedReferrerBps: num(r.schedReferrerBps),
    schedTotalBps: num(r.schedTotalBps),
    schedReferrerTermMonths: num(r.schedReferrerTermMonths),
    schedLeadTermMonths: num(r.schedLeadTermMonths),
  }));

  const summary: RunSummary = {
    mode: opts.apply ? 'apply' : 'dry-run',
    rows: rows.length,
    reprice: 0,
    noop: 0,
    flaggedSettled: 0,
    skipped: 0,
    totalDeltaUsdCents: 0,
    nhpOverCollectedUsdCents: 0,
    applied: 0,
    alreadyApplied: 0,
  };
  const toApply: Array<{ row: LedgerRow; decision: RepriceChange }> = [];

  for (const row of rows) {
    const d = toDecision(row);
    opts.log({ event: 'row', mode: summary.mode, ...d });
    if (d.action === 'SKIP') summary.skipped += 1;
    else {
      summary.nhpOverCollectedUsdCents += d.nhpOverCollectedUsdCents ?? 0;
      if (d.action === 'NOOP') summary.noop += 1;
      else if (d.action === 'FLAG_SETTLED') summary.flaggedSettled += 1;
      else if (d.action === 'REPRICE') {
        summary.reprice += 1;
        summary.totalDeltaUsdCents += d.deltaUsdCents;
        toApply.push({ row, decision: d });
      }
    }
  }

  if (opts.apply && toApply.length > 0) {
    const { applyRepricing } = await import('./reconcile-referral-v15-apply');
    const out = await applyRepricing(client, toApply, opts.now);
    summary.applied = out.applied;
    summary.alreadyApplied = out.alreadyApplied;
  }

  opts.log({ event: 'summary', ...summary });
  return summary;
}

/** Guards for the apply flag. Pure, so the CLI and the tests share them. */
export function checkApplyGuards(args: {
  argv: string[];
  env: Record<string, string | undefined>;
  host: string;
  now: Date;
}): string | null {
  if (!args.argv.includes('--apply')) return null;
  const today = args.now.toISOString().slice(0, 10);
  if (args.env.RECONCILE_CONFIRM !== today) {
    return `--apply needs RECONCILE_CONFIRM=${today} (today's date, UTC)`;
  }
  if (/\.neon\.tech$/i.test(args.host) && !args.argv.includes('--i-know-this-is-production')) {
    return `host ${args.host} is a Neon host: --apply also needs --i-know-this-is-production`;
  }
  return null;
}

async function main(): Promise<void> {
  const url = process.env.RECONCILE_DATABASE_URL;
  if (!url) {
    console.error('RECONCILE_DATABASE_URL is required (no other variable is read).');
    process.exit(2);
  }
  const host = new URL(url).hostname;
  const apply = process.argv.includes('--apply');
  const refusal = checkApplyGuards({ argv: process.argv, env: process.env, host, now: new Date() });
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }

  const { Client } = await import('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await runReconcile(client as unknown as PgLike, {
      apply,
      now: new Date(),
      log: (line) => console.log(JSON.stringify(line)),
    });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && /reconcile-referral-v15\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
