/**
 * RECONCILE REFERRAL LEDGER ROWS MINTED BEFORE FEE RULE v1.5 (spec v1.5 section 4): DRY RUN ONLY.
 *
 * The rule is `repriceReferralRow()` in src/lib/referral-reprice.ts; this file only reads rows and
 * logs one JSON line per decision plus a summary. It CANNOT write: it issues SELECT, SHOW and one
 * session SET, and it does not import the writer. Its first statement forces the connection
 * read-only and it refuses to continue unless the server confirms that. The separate entry point
 * `reconcile-referral-v15-apply.ts` is the only code that can change data, and it carries its own
 * guards.
 *
 *   RECONCILE_DATABASE_URL=postgres://... npx tsx scripts/reconcile-referral-v15.ts
 *
 * The URL comes from RECONCILE_DATABASE_URL and nowhere else. No env file is read and there is no
 * fallback to a production variable.
 *
 * ⚠️ THE SUMMARY'S `nhpExcessUsdCents` / `practitionerOverchargedUsdCents` ARE AN OPERATOR
 * DECISION. Zeroing past-term referrer shares leaves that money with NHP while the practitioner
 * stays charged the old rule's rate. Applying needs the operator's sign-off on those totals.
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
  schedPlanASourcedBps: number | null;
  schedPlanBSourcedBps: number | null;
  plan: string | null;
  transferStatus: string | null;
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
       s."leadTermMonths" AS "schedLeadTermMonths",
       s."planASourcedBps" AS "schedPlanASourcedBps",
       s."planBSourcedBps" AS "schedPlanBSourcedBps",
       sp."plan" AS "plan",
       t."status" AS "transferStatus"
  FROM "ReferralLedgerEntry" r
  LEFT JOIN "BookingFeeSnapshot" f ON f."bookingIntentId" = r."bookingIntentId"
  LEFT JOIN "AttributedClient" ac
         ON ac."practitionerId" = r."servingPractitionerId" AND ac."emailHash" = r."clientEmailHash"
  LEFT JOIN "Practitioner" sp ON sp."id" = r."servingPractitionerId"
  LEFT JOIN "FeeLedgerEntry" t ON t."dedupeKey" = 'REFERRER_TRANSFER:' || r."id"
  LEFT JOIN "RateSchedule" s ON s."id" = COALESCE(ac."rateScheduleId", sp."rateScheduleId")
 WHERE f."rateScheduleId" IS NULL
 ORDER BY r."createdAt", r."id"`;

export type RunOptions = {
  log: (line: Record<string, unknown>) => void;
};

export type RunSummary = {
  mode: 'dry-run' | 'apply';
  rows: number;
  reprice: number;
  noop: number;
  flaggedSettled: number;
  skipped: number;
  /** Sum of referrer shares taken away (positive cents). */
  referrerSharesRemovedUsdCents: number;
  /** Of which: shares zeroed because the payment was past the referrer term. */
  referrerSharesZeroedUsdCents: number;
  /** Over every non-skipped row: what was collected, what NHP retains, what v1.5 would have charged / kept. */
  collectedUsdCents: number;
  nhpRetainsUsdCents: number;
  v15ChargeUsdCents: number;
  v15NhpWouldKeepUsdCents: number;
  nhpExcessUsdCents: number;
  practitionerOverchargedUsdCents: number;
  /** Rows whose v1.5 charge could not be priced (practitioner plan unknown); excluded from the totals above. */
  unpricedRows: number;
  /** What those unpriced rows collected and what NHP retains of it, so they are never silently absent. */
  unpricedCollectedUsdCents: number;
  unpricedNhpRetainsUsdCents: number;
  applied: number;
  alreadyApplied: number;
  note: string;
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
    plan: r.plan,
    transferStatus: r.transferStatus,
    schedule: haveSchedule
      ? {
          planASourcedBps: r.schedPlanASourcedBps ?? 0,
          planBSourcedBps: r.schedPlanBSourcedBps ?? 0,
          referrerBps: r.schedReferrerBps as number,
          referralTotalBps: r.schedTotalBps as number,
          referrerTermMonths: r.schedReferrerTermMonths as number,
          leadTermMonths: r.schedLeadTermMonths as number,
        }
      : null,
  });
}

export const SIGN_OFF_NOTE =
  'Applying needs operator sign-off on nhpExcessUsdCents and practitionerOverchargedUsdCents: re-priced rows keep the old rule\'s collected fee with NHP.';

export type Planned = { row: LedgerRow; decision: RepriceChange };

/** SET read-only, verify, SELECT, decide, log. Never writes; the apply entry point reuses it. */
export async function collectReconcile(
  client: PgLike,
  opts: RunOptions & { mode?: 'dry-run' | 'apply' },
): Promise<{ summary: RunSummary; planned: Planned[] }> {
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
    schedPlanASourcedBps: num(r.schedPlanASourcedBps),
    schedPlanBSourcedBps: num(r.schedPlanBSourcedBps),
    plan: r.plan === null || r.plan === undefined ? null : String(r.plan),
    transferStatus: r.transferStatus === null || r.transferStatus === undefined ? null : String(r.transferStatus),
  }));

  const summary: RunSummary = {
    mode: opts.mode ?? 'dry-run',
    rows: rows.length,
    reprice: 0,
    noop: 0,
    flaggedSettled: 0,
    skipped: 0,
    referrerSharesRemovedUsdCents: 0,
    referrerSharesZeroedUsdCents: 0,
    collectedUsdCents: 0,
    nhpRetainsUsdCents: 0,
    v15ChargeUsdCents: 0,
    v15NhpWouldKeepUsdCents: 0,
    nhpExcessUsdCents: 0,
    practitionerOverchargedUsdCents: 0,
    unpricedRows: 0,
    unpricedCollectedUsdCents: 0,
    unpricedNhpRetainsUsdCents: 0,
    applied: 0,
    alreadyApplied: 0,
    note: SIGN_OFF_NOTE,
  };
  const planned: Planned[] = [];

  for (const row of rows) {
    const d = toDecision(row);
    opts.log({ event: 'row', mode: summary.mode, ...d });
    if (d.action === 'SKIP') {
      summary.skipped += 1;
      continue;
    }
    if (d.v15ChargeUsdCents === null || d.v15NhpWouldKeepUsdCents === null) {
      summary.unpricedRows += 1;
      summary.unpricedCollectedUsdCents += d.collectedUsdCents;
      summary.unpricedNhpRetainsUsdCents += d.nhpRetainsUsdCents;
    }
    else {
      summary.collectedUsdCents += d.collectedUsdCents;
      summary.nhpRetainsUsdCents += d.nhpRetainsUsdCents;
      summary.v15ChargeUsdCents += d.v15ChargeUsdCents;
      summary.v15NhpWouldKeepUsdCents += d.v15NhpWouldKeepUsdCents;
      summary.nhpExcessUsdCents += d.nhpExcessUsdCents ?? 0;
      summary.practitionerOverchargedUsdCents += d.practitionerOverchargedUsdCents ?? 0;
    }
    if (d.action === 'NOOP') summary.noop += 1;
    else if (d.action === 'FLAG_SETTLED') summary.flaggedSettled += 1;
    else if (d.action === 'REPRICE') {
      summary.reprice += 1;
      summary.referrerSharesRemovedUsdCents += -d.deltaUsdCents;
      if (d.newShareUsdCents === 0) summary.referrerSharesZeroedUsdCents += d.currentShareUsdCents;
      planned.push({ row, decision: d });
    }
  }

  return { summary, planned };
}

export async function runReconcile(client: PgLike, opts: RunOptions): Promise<RunSummary> {
  const { summary } = await collectReconcile(client, opts);
  opts.log({ event: 'summary', ...summary });
  return summary;
}

async function main(): Promise<void> {
  const url = process.env.RECONCILE_DATABASE_URL;
  if (!url) {
    console.error('RECONCILE_DATABASE_URL is required (no other variable is read).');
    process.exit(2);
  }
  if (process.argv.includes('--apply')) {
    console.error('This entry point is read-only. Use scripts/reconcile-referral-v15-apply.ts to apply.');
    process.exit(2);
  }
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await runReconcile(client as unknown as PgLike, { log: (line) => console.log(JSON.stringify(line)) });
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
