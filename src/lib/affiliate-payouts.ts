/**
 * PAYING RECRUITERS (spec v1.5 section 5, operator ruling O7; lane R2 timing and refund policy).
 *
 * 🚧 BUILT AND DELIBERATELY NOT ACTIVE, exactly like `referral-payouts.ts`: `WHOP_TRANSFERS_ENABLED`
 * is false in production and stays false until the parent company is business-verified. While it
 * is off this function reads nothing, writes nothing and calls nothing; it reports
 * `skipped: transfers disabled`.
 *
 * WHEN A RECRUITER IS PAID (operator ruling 2026-10-14): as each client payment comes in, once
 * payouts are live. A row is eligible when it is ACCRUED, its `holdUntil` has passed (with the
 * default `affiliate_hold_days` = 0 that is the instant of payment) and the recruiter is active
 * and payee-verified. When the flag is on, the payment webhook triggers a best-effort settle of
 * that one row (`settleAffiliateEntryBestEffort`) and the hourly whop-reconcile cron is the
 * backstop. The client-referral (referrer) hold is a different setting and is not touched here.
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
 *     concurrent runs (the webhook trigger and the cron, or two crons) both try it; the database
 *     lets exactly one through. The loser skips.
 *   - SENDING IS NEVER RE-SELECTED. A crash between the transfer and the confirmation leaves the
 *     row there for a human to reconcile against `GET /transfers?origin_id=`. It is not retried.
 *   - A FAILURE IS CLASSIFIED. Only a response proving Whop refused the request (HTTP 4xx) puts the
 *     row back to ACCRUED for the next run, and only a few times. Anything that could have reached
 *     Whop and still failed on the way back (timeout, network error, 5xx) takes the row out of the
 *     automatic sweep as HELD, because retrying it blind could pay twice.
 *   - The claim also names `reversedUsdCents`, so a refund that lands between reading the row and
 *     claiming it makes the claim miss; the next run re-reads the reduced amount.
 *
 * REFUND NETTING (lane R2). A refund that arrives AFTER a recruiter's share was paid is recorded
 * as an `AffiliateBalanceAdjustment` debit (see `applyAffiliateReversal`); nothing is clawed back
 * by transfer. Settling a recruiter's NEXT payable share first nets their open debits against it,
 * oldest debit first:
 *
 *   gross share (share - reversed)  -  debit applied  =  amount that goes through the fee helper
 *
 * The claim, the debit applications and the row's own bookkeeping are ONE database transaction,
 * and every debit application is a compare-and-swap on `appliedUsdCents`. Two settles that read
 * the same open debit therefore cannot both apply it: the loser's swap misses, its transaction
 * rolls back (taking its claim with it) and it re-reads. The transfer itself is made AFTER the
 * transaction commits, never inside it. A share the debits swallow whole is SETTLED with net 0 and
 * NO transfer; the unpaid remainder of a debit carries to later payouts; a recruiter's payouts can
 * therefore never go negative (applied is capped at min(share, open balance)).
 *
 * PAYEE ABSORBS WHOP'S TRANSFER FEE (spec v1.5 s4): the amount SENT, the fee and the net all come
 * from `planTransfer()` (transfer-fee.ts), applied to the share AFTER netting. The claim records
 * grossShareUsdCents (share - reversed), adjustmentAppliedUsdCents and transferFeeUsdCents;
 * settlement records netPaidUsdCents. A remainder too small to cover the fee is never sent and no
 * debit is applied for it; the row stays ACCRUED with `lastError` = BELOW_TRANSFER_FEE.
 */

import { isPayable } from './referral-settlement';
import { payoutsGuard, toTransferDollars, type TransferFn } from './referral-payouts';
import {
  loadTransferFeeConfig,
  minimumSendableShareCents,
  planTransfer,
  BELOW_FEE_REASON,
  type TransferFeeConfig,
  type TransferPlan,
} from './transfer-fee';
import { WhopNotConfigured } from './whop';
import { RETIREMENT_SENTINEL, bookableWhere } from './practitioner-indexer';

export const TRANSFERS_DISABLED_REASON = 'skipped: transfers disabled';

/** A definitive refusal is retried this many times before the row is parked as HELD. */
export const MAX_TRANSFER_ATTEMPTS = 5;

/** A netting transaction that loses its compare-and-swap is re-read and retried this many times. */
const MAX_NETTING_ATTEMPTS = 4;

const BATCH = 50;

/** What the claim-and-net transaction touches. */
export type AffiliatePayoutsTx = {
  affiliateLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany(args: any): Promise<{ count: number }>;
  };
  affiliateBalanceAdjustment: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any[]>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany(args: any): Promise<{ count: number }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createMany(args: any): Promise<{ count: number }>;
  };
};

export type AffiliatePayoutsDb = AffiliatePayoutsTx & {
  affiliateLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany(args: any): Promise<{ count: number }>;
  };
  $transaction<T>(fn: (tx: AffiliatePayoutsTx) => Promise<T>): Promise<T>;
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
  /** Rows on which at least one refund debit was netted this run. */
  netted: number;
  /** Total cents of refund debits netted this run (sum of the rows' adjustments). */
  debitAppliedUsdCents: number;
  /** Set when nothing ran, with the reason. Null when settlement ran. */
  blocked: string | null;
};

type Candidate = {
  id: string;
  shareUsdCents: number;
  reversedUsdCents: number;
  adjustmentAppliedUsdCents: number | null;
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

/** Thrown inside the netting transaction to roll it back when a debit was taken by someone else. */
class NettingConflict extends Error {}

type SendablePlan = Extract<TransferPlan, { sendable: true }>;

type NettingOutcome =
  /** The claim missed: the row moved (another run, or a refund). Nothing was written. */
  | { kind: 'MISSED' }
  /** The remainder after netting cannot cover the fee. Nothing was written; no debit was applied. */
  | { kind: 'BELOW_FEE'; reason: string }
  /** The remainder is not a valid transfer amount. Nothing was written. */
  | { kind: 'BAD_AMOUNT'; message: string }
  /** Claimed SENDING (and debits applied, atomically). The caller now makes the transfer. */
  | { kind: 'SEND'; plan: SendablePlan; dollars: number; debitApplied: number }
  /** Debits swallowed the whole share: SETTLED with net 0, and no transfer is owed. */
  | { kind: 'SWALLOWED'; debitApplied: number }
  /**
   * Relief applied by an earlier (rejected) attempt now exceeds what the share is worth because of
   * a refund. SETTLED with net 0; the excess is re-opened as a new debit.
   */
  | { kind: 'OVER_APPLIED'; excess: number };

/**
 * The atomic heart of the lane: read the recruiter's open debits, decide what to net, CLAIM the
 * row, and apply the debits, all in one transaction. See the module docstring.
 */
async function claimAndNet(
  db: AffiliatePayoutsDb,
  row: Candidate,
  ctx: { feeConfig: TransferFeeConfig; at: Date },
): Promise<NettingOutcome> {
  return db.$transaction(async (tx) => {
    const gross = row.shareUsdCents - row.reversedUsdCents;
    const prior = row.adjustmentAppliedUsdCents ?? 0;
    const remaining = gross - prior;

    // The claim names the state, the refund total AND the relief already recorded, so none of the
    // three can have moved since this row was read.
    const claimWhere = {
      id: row.id,
      state: 'ACCRUED',
      reversedUsdCents: row.reversedUsdCents,
      adjustmentAppliedUsdCents: row.adjustmentAppliedUsdCents ?? null,
    };

    if (remaining < 0) {
      const excess = -remaining;
      const claimed = await tx.affiliateLedgerEntry.updateMany({
        where: claimWhere,
        data: {
          state: 'SETTLED',
          settledAt: ctx.at,
          transferUsdCents: 0,
          grossShareUsdCents: gross,
          transferFeeUsdCents: 0,
          netPaidUsdCents: 0,
          lastError: null,
        },
      });
      if (claimed.count === 0) return { kind: 'MISSED' };
      await tx.affiliateBalanceAdjustment.createMany({
        data: [
          {
            recruiterPractitionerId: row.recruiterPractitionerId,
            sourceLedgerEntryId: row.id,
            amountUsdCents: excess,
            appliedUsdCents: 0,
            state: 'OPEN',
            reason: 'REFUND',
            dedupeKey: `OVERAPPLIED:${row.id}:${row.reversedUsdCents}`,
          },
        ],
        skipDuplicates: true,
      });
      return { kind: 'OVER_APPLIED', excess };
    }

    // Oldest debit first, with the id as the tie-break so concurrent settles lock in the same order.
    const debits = ((await tx.affiliateBalanceAdjustment.findMany({
      where: { recruiterPractitionerId: row.recruiterPractitionerId, state: 'OPEN' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, amountUsdCents: true, appliedUsdCents: true },
    })) as Array<{ id: string; amountUsdCents: number; appliedUsdCents: number }>).filter(
      (d) => d.amountUsdCents - d.appliedUsdCents > 0,
    );
    const openBalance = debits.reduce((sum, d) => sum + (d.amountUsdCents - d.appliedUsdCents), 0);

    // Never more than the share is worth, never more than is owed: the payout cannot go negative.
    const debitApplied = Math.min(remaining, openBalance);
    const net = remaining - debitApplied;

    let plan: SendablePlan | null = null;
    let dollars = 0;
    if (net > 0) {
      const candidate = planTransfer(net, ctx.feeConfig);
      if (!candidate.sendable) return { kind: 'BELOW_FEE', reason: candidate.reason };
      try {
        dollars = toTransferDollars(candidate.sendCents);
      } catch (err) {
        return { kind: 'BAD_AMOUNT', message: err instanceof Error ? err.message : String(err) };
      }
      plan = candidate;
    }

    const appliedTotal = prior + debitApplied;
    const claimed = await tx.affiliateLedgerEntry.updateMany({
      where: claimWhere,
      data: plan
        ? {
            state: 'SENDING',
            transferUsdCents: plan.sendCents,
            grossShareUsdCents: gross,
            transferFeeUsdCents: plan.feeCents,
            netPaidUsdCents: null,
            transferAttempts: row.transferAttempts + 1,
            lastError: null,
            ...(debitApplied > 0 ? { adjustmentAppliedUsdCents: appliedTotal } : {}),
          }
        : {
            state: 'SETTLED',
            settledAt: ctx.at,
            transferUsdCents: 0,
            grossShareUsdCents: gross,
            transferFeeUsdCents: 0,
            netPaidUsdCents: 0,
            lastError: null,
            ...(debitApplied > 0 ? { adjustmentAppliedUsdCents: appliedTotal } : {}),
          },
    });
    if (claimed.count === 0) return { kind: 'MISSED' };

    let left = debitApplied;
    for (const d of debits) {
      if (left <= 0) break;
      const take = Math.min(left, d.amountUsdCents - d.appliedUsdCents);
      const nowApplied = d.appliedUsdCents + take;
      const swapped = await tx.affiliateBalanceAdjustment.updateMany({
        // The CAS: still OPEN and still at the applied total we read. Another settle that took any
        // of this debit in between makes it miss, and the whole transaction (claim included) rolls back.
        where: { id: d.id, state: 'OPEN', appliedUsdCents: d.appliedUsdCents },
        data: { appliedUsdCents: nowApplied, state: nowApplied >= d.amountUsdCents ? 'APPLIED' : 'OPEN' },
      });
      if (swapped.count === 0) throw new NettingConflict();
      left -= take;
    }

    return plan ? { kind: 'SEND', plan, dollars, debitApplied } : { kind: 'SWALLOWED', debitApplied };
  });
}

export async function settleAffiliateShares(
  db: AffiliatePayoutsDb,
  opts: {
    transfer: TransferFn;
    at: Date;
    /** Restrict the run to ONE ledger row (the post-payment trigger). Same rules, same guards. */
    only?: { bookingIntentId: string; recruiterPractitionerId: string };
  },
): Promise<AffiliateSettlementSummary> {
  const summary: AffiliateSettlementSummary = {
    matched: 0,
    settled: 0,
    skipped: 0,
    failed: 0,
    held: 0,
    belowFee: 0,
    netted: 0,
    debitAppliedUsdCents: 0,
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
  const scope = opts.only
    ? { bookingIntentId: opts.only.bookingIntentId, recruiterPractitionerId: opts.only.recruiterPractitionerId }
    : {};

  // Rows that can never cover the fee are not selected (they would crowd the oldest-first batch
  // forever); their reason is recorded here, once, by a guarded update that never touches a row
  // that already carries one.
  const tiny = await db.affiliateLedgerEntry.updateMany({
    where: {
      ...scope,
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
    // Past the hold (none by default), and only for a recruiter who can actually receive money
    // today. A recruiter without a verified wallet is simply not selected and stays ACCRUED,
    // forfeiting nothing.
    where: {
      ...scope,
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
      adjustmentAppliedUsdCents: true,
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
    if (amount <= 0 && !(row.adjustmentAppliedUsdCents ?? 0)) {
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

    let outcome: NettingOutcome | null = null;
    for (let attempt = 0; attempt < MAX_NETTING_ATTEMPTS && !outcome; attempt += 1) {
      try {
        outcome = await claimAndNet(db, row, { feeConfig, at: opts.at });
      } catch (err) {
        if (!(err instanceof NettingConflict)) throw err;
        // Another settle took a debit we were about to apply; our transaction rolled back whole.
        // Re-read and try again (the claim will simply miss if that run took this row too).
      }
    }
    if (!outcome) {
      summary.skipped += 1;
      console.error('[affiliate-payouts] NETTING CONFLICT, left for the next run', JSON.stringify({ entryId: row.id }));
      continue;
    }

    if (outcome.kind === 'MISSED') {
      summary.skipped += 1;
      continue;
    }
    if (outcome.kind === 'BELOW_FEE') {
      // Reached when the share is sendable on its own but refunds or debits shrank it below the
      // fee. Recorded, not sent, no claim, no debit applied.
      await db.affiliateLedgerEntry.updateMany({
        where: { id: row.id, state: 'ACCRUED', reversedUsdCents: row.reversedUsdCents },
        data: { lastError: outcome.reason.slice(0, 500) },
      });
      summary.belowFee += 1;
      summary.skipped += 1;
      continue;
    }
    if (outcome.kind === 'BAD_AMOUNT') {
      // A malformed amount reached the payout boundary: an upstream bug, not a transient fault.
      // Parked for a human rather than retried every hour.
      await db.affiliateLedgerEntry.updateMany({
        where: { id: row.id, state: 'ACCRUED' },
        data: { state: 'HELD', lastError: outcome.message.slice(0, 500) },
      });
      summary.held += 1;
      summary.failed += 1;
      console.error('[affiliate-payouts] BAD AMOUNT', JSON.stringify({ entryId: row.id, error: outcome.message }));
      continue;
    }
    if (outcome.kind === 'OVER_APPLIED') {
      summary.settled += 1;
      console.error(
        '[affiliate-payouts] REFUND EXCEEDED DEBIT RELIEF ALREADY APPLIED: re-opened as a debit',
        JSON.stringify({ entryId: row.id, excessUsdCents: outcome.excess }),
      );
      continue;
    }
    if (outcome.debitApplied > 0) {
      summary.netted += 1;
      summary.debitAppliedUsdCents += outcome.debitApplied;
    }
    if (outcome.kind === 'SWALLOWED') {
      // The debits consumed the whole share. Recorded as paid-in-kind: no transfer, no Whop call.
      summary.settled += 1;
      continue;
    }

    const { plan, dollars } = outcome;
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
      // Any refund debit applied at the claim STAYS applied (recorded on the row's
      // adjustmentAppliedUsdCents): the next claim nets only what is still open on top of it, so a
      // rejected transfer can neither lose the netting nor apply it twice.
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

/**
 * The post-payment trigger: settle ONE just-accrued row right away, best effort.
 *
 * Contract, because it runs on the payment webhook's path:
 *   - the flag is checked FIRST and literally: not exactly 'true' means zero reads, zero writes,
 *     zero calls, and it returns null;
 *   - it NEVER throws and never rejects: every failure is logged loudly with the row's ids and the
 *     hourly whop-reconcile cron (which runs the same function over every eligible row) is the
 *     backstop. A webhook ack must never wait on, or fail because of, a payout;
 *   - it is safe to run concurrently with the cron or a webhook redelivery: the guarded claim lets
 *     exactly one of them pay.
 */
export async function settleAffiliateEntryBestEffort(
  db: AffiliatePayoutsDb,
  input: { bookingIntentId: string; recruiterPractitionerId: string },
  deps: { transfer: TransferFn; at?: Date },
): Promise<AffiliateSettlementSummary | null> {
  if (process.env.WHOP_TRANSFERS_ENABLED !== 'true') return null;
  try {
    const summary = await settleAffiliateShares(db, {
      transfer: deps.transfer,
      at: deps.at ?? new Date(),
      only: input,
    });
    if (summary.blocked) {
      console.error('[affiliate-payouts] IMMEDIATE SETTLE BLOCKED (cron will retry)', JSON.stringify({ ...input, reason: summary.blocked }));
    } else if (summary.failed > 0 || summary.held > 0) {
      console.error('[affiliate-payouts] IMMEDIATE SETTLE FAILED (cron will report it)', JSON.stringify({ ...input, summary }));
    }
    return summary;
  } catch (err) {
    console.error(
      '[affiliate-payouts] IMMEDIATE SETTLE THREW (cron will retry)',
      JSON.stringify({ ...input, error: err instanceof Error ? err.message : String(err) }),
    );
    return null;
  }
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
  db: Pick<AffiliatePayoutsDb, 'affiliateLedgerEntry'>,
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
