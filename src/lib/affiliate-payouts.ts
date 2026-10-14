/**
 * PAYING RECRUITERS (spec v1.5 section 5, operator ruling O7).
 *
 * 🚧 BUILT AND DELIBERATELY NOT ACTIVE, exactly like `referral-payouts.ts`: `WHOP_TRANSFERS_ENABLED`
 * is false in production and stays false until the parent company is business-verified. While it
 * is off this function reads nothing, writes nothing and calls nothing; it reports
 * `skipped: transfers disabled`.
 *
 * It reuses the referral path's pieces rather than restating them: the unit boundary
 * (`toTransferDollars`: transfers take DOLLARS, the ledger holds CENTS), the configuration guard
 * (`payoutsGuard`), and the payee check (`isPayable`: a connected Whop company with payouts
 * enabled, the WEBHOOK-authoritative value).
 *
 * ⚠️ `POST /transfers` HAS NO IDEMPOTENCY KEY. Everything below exists to make a double payment
 * impossible without one:
 *
 *   - CLAIM, THEN CALL. A single guarded `UPDATE ... WHERE id = ? AND state = 'ACCRUED' AND
 *     reversedUsdCents = ?` moves the row to SENDING and records the amount claimed. Two
 *     concurrent runs both try it; the database lets exactly one through. The loser skips.
 *   - SENDING IS NEVER RE-SELECTED. A crash between the transfer and the confirmation leaves the
 *     row there for a human to reconcile against `GET /transfers?origin_id=`. It is not retried.
 *   - A FAILURE IS CLASSIFIED. Only a response proving Whop refused the request (HTTP 4xx) puts the
 *     row back to ACCRUED for the next run, and only a few times. Anything that could have reached
 *     Whop and still failed on the way back (timeout, network error, 5xx) takes the row out of the
 *     automatic sweep as HELD, because retrying it blind could pay twice.
 *   - The claim also names `reversedUsdCents`, so a refund that lands between reading the row and
 *     claiming it makes the claim miss; the next run re-reads the reduced amount.
 */

import { isPayable } from './referral-settlement';
import { payoutsGuard, toTransferDollars, type TransferFn } from './referral-payouts';
import { WhopNotConfigured } from './whop';

export const TRANSFERS_DISABLED_REASON = 'skipped: transfers disabled';

/** A definitive refusal is retried this many times before the row is parked as HELD. */
export const MAX_TRANSFER_ATTEMPTS = 5;

const BATCH = 50;

export type AffiliatePayoutsDb = {
  affiliateLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany(args: any): Promise<{ count: number }>;
  };
};

export type AffiliateSettlementSummary = {
  matched: number;
  settled: number;
  skipped: number;
  failed: number;
  /** Rows taken out of the automatic sweep by a failure that cannot be proven harmless. */
  held: number;
  /** Set when nothing ran, with the reason. Null when settlement ran. */
  blocked: string | null;
};

type Candidate = {
  id: string;
  shareUsdCents: number;
  reversedUsdCents: number;
  transferAttempts: number;
  recruiterPractitionerId: string;
  recruiterPractitioner: { whopCompanyId: string | null; whopPayoutsEnabled: boolean } | null;
};

/**
 * Did Whop REFUSE this request (so no transfer exists), as opposed to something that may have
 * succeeded on their side? `whopPost` throws `Whop /transfers failed (<status>): ...` only for a
 * non-2xx response; a 4xx is a rejection of the request itself.
 */
export function isDefinitiveTransferRejection(err: unknown): boolean {
  if (err instanceof WhopNotConfigured) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /^Whop \/transfers failed \(4\d\d\)/.test(message);
}

export async function settleAffiliateShares(
  db: AffiliatePayoutsDb,
  opts: { transfer: TransferFn; at: Date },
): Promise<AffiliateSettlementSummary> {
  const summary: AffiliateSettlementSummary = {
    matched: 0,
    settled: 0,
    skipped: 0,
    failed: 0,
    held: 0,
    blocked: null,
  };

  // The literal string, not a truthy check: "false" or "0" must not open a money path. Checked
  // BEFORE any read so a disabled run is provably inert.
  if (process.env.WHOP_TRANSFERS_ENABLED !== 'true') {
    summary.blocked = TRANSFERS_DISABLED_REASON;
    return summary;
  }
  const guard = payoutsGuard();
  if (!guard.allowed) {
    summary.blocked = guard.reason;
    return summary;
  }

  const rows = (await db.affiliateLedgerEntry.findMany({
    // ACCRUED only: HELD and SENDING are deliberately outside the automatic sweep (see above).
    // Past the hold, and only for a recruiter who can actually receive money today. A recruiter
    // without a verified wallet is simply not selected and stays ACCRUED, forfeiting nothing.
    where: {
      state: 'ACCRUED',
      settledAt: null,
      holdUntil: { lte: opts.at },
      recruiterPractitioner: { whopCompanyId: { not: null }, whopPayoutsEnabled: true },
    },
    select: {
      id: true,
      shareUsdCents: true,
      reversedUsdCents: true,
      transferAttempts: true,
      recruiterPractitionerId: true,
      recruiterPractitioner: { select: { whopCompanyId: true, whopPayoutsEnabled: true } },
    },
    orderBy: { holdUntil: 'asc' },
    take: BATCH,
  })) as Candidate[];
  summary.matched = rows.length;

  for (const row of rows) {
    const destination = row.recruiterPractitioner?.whopCompanyId ?? null;
    // Re-checked in code: the query filter is an optimisation, this is the rule.
    if (!destination || !isPayable(row.recruiterPractitioner)) {
      summary.skipped += 1;
      continue;
    }

    // The payable amount is what is left after refunds. A fully reversed row is skipped here (and
    // the refund path moves it to REVERSED), never sent as a zero transfer.
    const amount = row.shareUsdCents - row.reversedUsdCents;
    if (amount <= 0) {
      summary.skipped += 1;
      continue;
    }

    let dollars: number;
    try {
      dollars = toTransferDollars(amount);
    } catch (err) {
      // A malformed amount reached the payout boundary: an upstream bug, not a transient fault.
      // Parked for a human rather than retried every hour.
      const message = err instanceof Error ? err.message : String(err);
      await db.affiliateLedgerEntry.updateMany({
        where: { id: row.id, state: 'ACCRUED' },
        data: { state: 'HELD', lastError: message.slice(0, 500) },
      });
      summary.held += 1;
      summary.failed += 1;
      console.error('[affiliate-payouts] BAD AMOUNT', JSON.stringify({ entryId: row.id, error: message }));
      continue;
    }

    // CLAIM, THEN CALL.
    const claimed = await db.affiliateLedgerEntry.updateMany({
      where: { id: row.id, state: 'ACCRUED', reversedUsdCents: row.reversedUsdCents },
      data: {
        state: 'SENDING',
        transferUsdCents: amount,
        transferAttempts: row.transferAttempts + 1,
      },
    });
    if (claimed.count === 0) {
      summary.skipped += 1;
      continue;
    }

    let transferId: string;
    try {
      ({ transferId } = await opts.transfer({
        originId: process.env.WHOP_PARENT_COMPANY_ID!,
        destinationId: destination,
        amountUsdDollars: dollars,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.failed += 1;
      const retryable =
        isDefinitiveTransferRejection(err) && row.transferAttempts + 1 < MAX_TRANSFER_ATTEMPTS;
      // Back to ACCRUED only when we KNOW no transfer exists. Otherwise HELD: out of the sweep.
      await db.affiliateLedgerEntry.updateMany({
        where: { id: row.id, state: 'SENDING' },
        data: { state: retryable ? 'ACCRUED' : 'HELD', lastError: message.slice(0, 500) },
      });
      if (!retryable) summary.held += 1;
      console.error(
        '[affiliate-payouts] TRANSFER FAILED',
        JSON.stringify({ entryId: row.id, error: message, retry: retryable }),
      );
      continue;
    }

    // The money has moved. If recording it fails, the row stays SENDING (never re-selected), so
    // the worst case is a missing receipt, not a second payment; say so loudly with the id.
    try {
      const done = await db.affiliateLedgerEntry.updateMany({
        where: { id: row.id, state: 'SENDING' },
        data: { state: 'SETTLED', settledAt: opts.at, whopTransferId: transferId, lastError: null },
      });
      if (done.count === 0) {
        console.error(
          '[affiliate-payouts] TRANSFER SENT BUT ROW NOT SENDING',
          JSON.stringify({ entryId: row.id, transferId }),
        );
        summary.failed += 1;
        continue;
      }
      summary.settled += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(
        '[affiliate-payouts] TRANSFER SENT BUT NOT RECORDED',
        JSON.stringify({ entryId: row.id, transferId, error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  return summary;
}
