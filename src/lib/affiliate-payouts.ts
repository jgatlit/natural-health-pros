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
 *
 * PAYEE ABSORBS WHOP'S TRANSFER FEE (spec v1.5 s4): the amount SENT, the fee and the net all come
 * from `planTransfer()` (transfer-fee.ts). The claim records grossShareUsdCents and
 * transferFeeUsdCents; settlement records netPaidUsdCents. A share too small to cover the fee is
 * never sent; it stays ACCRUED with `lastError` = BELOW_TRANSFER_FEE.
 */

import { isPayable } from './referral-settlement';
import { payoutsGuard, toTransferDollars, type TransferFn } from './referral-payouts';
import {
  loadTransferFeeConfig,
  minimumSendableShareCents,
  planTransfer,
  BELOW_FEE_REASON,
  type TransferFeeConfig,
} from './transfer-fee';
import { WhopNotConfigured } from './whop';
import { RETIREMENT_SENTINEL, bookableWhere } from './practitioner-indexer';

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
  /** Rows whose share cannot cover Whop's transfer fee: not sent, left ACCRUED with a recorded reason. */
  belowFee: number;
  /** Set when nothing ran, with the reason. Null when settlement ran. */
  blocked: string | null;
};

type Candidate = {
  id: string;
  shareUsdCents: number;
  reversedUsdCents: number;
  transferAttempts: number;
  recruiterPractitionerId: string;
  recruiterPractitioner: {
    whopCompanyId: string | null;
    whopPayoutsEnabled: boolean;
    archivedAt: Date | null;
    trialEndsAt: Date | null;
  } | null;
};

/**
 * "While both are active" (spec section 5), checked again at the moment of payment: the same
 * `bookableWhere()` predicate the fee path used to accept the recruiter at mint (not archived, not
 * retired). The debt was earned and is NOT dropped when a recruiter goes inactive: the row simply
 * stays ACCRUED, unselected, and pays if they are reinstated.
 */
function isActiveRecruiter(p: { archivedAt: Date | null; trialEndsAt: Date | null } | null): boolean {
  if (!p || p.archivedAt != null) return false;
  return p.trialEndsAt == null || p.trialEndsAt.getTime() > RETIREMENT_SENTINEL.getTime();
}

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
    belowFee: 0,
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

  let feeConfig: TransferFeeConfig;
  try {
    feeConfig = loadTransferFeeConfig();
  } catch (err) {
    summary.blocked = `transfer fee configuration invalid: ${err instanceof Error ? err.message : String(err)}`;
    return summary;
  }
  const minShare = minimumSendableShareCents(feeConfig);

  // Rows that can never cover the fee are not selected (they would crowd the oldest-first batch
  // forever); their reason is recorded here, once, by a guarded update that never touches a row
  // that already carries one.
  const tiny = await db.affiliateLedgerEntry.updateMany({
    where: {
      state: 'ACCRUED',
      settledAt: null,
      holdUntil: { lte: opts.at },
      shareUsdCents: { lt: minShare },
      lastError: null,
    },
    data: { lastError: `${BELOW_FEE_REASON}: share is below the ${minShare}c minimum that covers the transfer fee` },
  });
  summary.belowFee += tiny.count;

  const rows = (await db.affiliateLedgerEntry.findMany({
    // ACCRUED only: HELD and SENDING are deliberately outside the automatic sweep (see above).
    // Past the hold, and only for a recruiter who can actually receive money today. A recruiter
    // without a verified wallet is simply not selected and stays ACCRUED, forfeiting nothing.
    where: {
      state: 'ACCRUED',
      settledAt: null,
      holdUntil: { lte: opts.at },
      shareUsdCents: { gte: minShare },
      recruiterPractitioner: { whopCompanyId: { not: null }, whopPayoutsEnabled: true, ...bookableWhere() },
    },
    select: {
      id: true,
      shareUsdCents: true,
      reversedUsdCents: true,
      transferAttempts: true,
      recruiterPractitionerId: true,
      recruiterPractitioner: {
        select: { whopCompanyId: true, whopPayoutsEnabled: true, archivedAt: true, trialEndsAt: true },
      },
    },
    orderBy: { holdUntil: 'asc' },
    take: BATCH,
  })) as Candidate[];
  summary.matched = rows.length;

  for (const row of rows) {
    const destination = row.recruiterPractitioner?.whopCompanyId ?? null;
    // Re-checked in code: the query filter is an optimisation, this is the rule.
    if (!destination || !isPayable(row.recruiterPractitioner) || !isActiveRecruiter(row.recruiterPractitioner)) {
      summary.skipped += 1;
      continue;
    }

    // The payable amount is what is left after refunds. A fully reversed row is skipped here (and
    // the refund path moves it to REVERSED), never sent as a zero transfer.
    const amount = row.shareUsdCents - row.reversedUsdCents;
    if (amount <= 0) {
      // HEAL, don't just skip: a fully reversed row that the refund path did not get to flip would
      // otherwise sit at the front of the oldest-first batch forever and starve the rows behind it.
      // Guarded on the state and the reversed total we read, so it cannot touch a row that moved.
      await db.affiliateLedgerEntry.updateMany({
        where: { id: row.id, state: 'ACCRUED', reversedUsdCents: row.reversedUsdCents },
        data: { state: 'REVERSED' },
      });
      summary.skipped += 1;
      continue;
    }

    const plan = planTransfer(amount, feeConfig);
    if (!plan.sendable) {
      // Reached only when refunds shrank an otherwise sendable share. Recorded, not sent, no claim.
      await db.affiliateLedgerEntry.updateMany({
        where: { id: row.id, state: 'ACCRUED', reversedUsdCents: row.reversedUsdCents },
        data: { lastError: plan.reason.slice(0, 500) },
      });
      summary.belowFee += 1;
      summary.skipped += 1;
      continue;
    }

    let dollars: number;
    try {
      dollars = toTransferDollars(plan.sendCents);
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
        transferUsdCents: plan.sendCents,
        grossShareUsdCents: plan.grossCents,
        transferFeeUsdCents: plan.feeCents,
        netPaidUsdCents: null,
        transferAttempts: row.transferAttempts + 1,
        lastError: null,
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
        // So a transfer that left but was never recorded can be FOUND (see the reconcile
        // procedure in the PR / runbook), and so Whop can refuse a duplicate if it honours the key.
        metadata: { kind: 'affiliate', affiliate_ledger_entry_id: row.id },
        idempotenceKey: `affiliate-ledger:${row.id}`,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.failed += 1;
      const retryable =
        isDefinitiveTransferRejection(err) && row.transferAttempts + 1 < MAX_TRANSFER_ATTEMPTS;
      // Back to ACCRUED only when we KNOW no transfer exists. Otherwise HELD: out of the sweep.
      await db.affiliateLedgerEntry.updateMany({
        where: { id: row.id, state: 'SENDING' },
        data: {
          state: retryable ? 'ACCRUED' : 'HELD',
          lastError: message.slice(0, 500),
          // A row going back to ACCRUED has had no transfer, so it carries no fee; a HELD row may
          // have been sent, so what was claimed stays on it for the human who reconciles it.
          ...(retryable ? { transferFeeUsdCents: null } : {}),
        },
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
        data: {
          state: 'SETTLED',
          settledAt: opts.at,
          whopTransferId: transferId,
          netPaidUsdCents: plan.netCents,
          lastError: null,
        },
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

/** A transfer that has been "in flight" this long without a receipt is stuck, not slow. */
export const STUCK_SENDING_AFTER_MS = 60 * 60 * 1000;

export type StuckAffiliateRow = {
  id: string;
  state: 'SENDING' | 'HELD';
  recruiterPractitionerId: string;
  /** What was claimed for transfer (SENDING) or is held (HELD), in cents. */
  amountUsdCents: number;
  lastError: string | null;
  updatedAt: Date;
};

/**
 * Rows the automatic sweep will never touch again, and that therefore need a human:
 *
 *   SENDING older than an hour: a transfer was claimed (and may have LEFT) but no receipt was
 *     recorded. Never re-sent, because `POST /transfers` may have succeeded.
 *   HELD: a failure that could not be proven harmless (network error, timeout, 5xx), or a bad amount.
 *
 * Read-only and independent of `WHOP_TRANSFERS_ENABLED`: stuck money must be visible even if the
 * flag has since been switched off. The cron turns a non-empty result into an error (so `ok` is
 * false) and a console.error naming the row ids.
 */
export async function findStuckAffiliateShares(
  db: AffiliatePayoutsDb,
  opts: { at: Date },
): Promise<StuckAffiliateRow[]> {
  const rows = (await db.affiliateLedgerEntry.findMany({
    where: {
      OR: [
        { state: 'HELD' },
        { state: 'SENDING', updatedAt: { lte: new Date(opts.at.getTime() - STUCK_SENDING_AFTER_MS) } },
      ],
    },
    select: {
      id: true,
      state: true,
      recruiterPractitionerId: true,
      shareUsdCents: true,
      reversedUsdCents: true,
      transferUsdCents: true,
      lastError: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'asc' },
    take: 200,
  })) as Array<{
    id: string;
    state: 'SENDING' | 'HELD';
    recruiterPractitionerId: string;
    shareUsdCents: number;
    reversedUsdCents: number;
    transferUsdCents: number | null;
    lastError: string | null;
    updatedAt: Date;
  }>;
  return rows.map((r) => ({
    id: r.id,
    state: r.state,
    recruiterPractitionerId: r.recruiterPractitionerId,
    amountUsdCents: r.transferUsdCents ?? Math.max(0, r.shareUsdCents - r.reversedUsdCents),
    lastError: r.lastError,
    updatedAt: r.updatedAt,
  }));
}
