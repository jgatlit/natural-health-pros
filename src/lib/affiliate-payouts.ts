/**
 * PAYING RECRUITERS (spec v1.5 section 5, operator ruling O7).
 *
 * A recruiter is paid 3% of every client payment of the practitioner they recruited, indefinitely,
 * as each payment clears: the payment webhook accrues the share and settles that one row in the
 * same run, and the hourly whop-reconcile cron retries any row that has no receipt. The share is
 * transferred in full to the recruiter's Whop balance. The state machine, the claim, the
 * refund-debit netting, the retry classification and the alerts are shared with the referral path
 * and live in `ledger-transfer.ts`; this file binds them to the affiliate ledger.
 *
 * 🚧 `WHOP_TRANSFERS_ENABLED` does not exist in production; while it is not exactly 'true' nothing
 * here reads, writes or calls anything.
 */

import { AFFILIATE_LEDGER } from './ledger-config';
import {
  settleLedger,
  settleLedgerEntryBestEffort,
  type LedgerSettlementSummary,
  type LedgerTransferDb,
  type LookupFn,
  type TransferFn,
} from './ledger-transfer';

export {
  TRANSFERS_DISABLED_REASON,
  STALE_SENDING_AFTER_MS,
  UNCONFIRMED_AFTER_MS,
  classifyTransferFailure,
  retryDelayMs,
} from './ledger-transfer';

export type AffiliateSettlementSummary = LedgerSettlementSummary;
export type AffiliatePayoutsDb = LedgerTransferDb;

export function settleAffiliateShares(
  db: AffiliatePayoutsDb,
  opts: {
    transfer: TransferFn;
    lookup: LookupFn;
    at: Date;
    /** Restrict the run to ONE ledger row (the post-payment trigger). Same rules, same guards. */
    only?: { bookingIntentId: string; recruiterPractitionerId: string };
  },
): Promise<AffiliateSettlementSummary> {
  return settleLedger(db, AFFILIATE_LEDGER, {
    transfer: opts.transfer,
    lookup: opts.lookup,
    at: opts.at,
    only: opts.only && { bookingIntentId: opts.only.bookingIntentId, payeeId: opts.only.recruiterPractitionerId },
  });
}

/** The post-payment trigger for one recruiter row. Never throws; see `settleLedgerEntryBestEffort`. */
export function settleAffiliateEntryBestEffort(
  db: AffiliatePayoutsDb,
  input: { bookingIntentId: string; recruiterPractitionerId: string },
  deps: { transfer: TransferFn; lookup: LookupFn; at?: Date },
): Promise<AffiliateSettlementSummary | null> {
  return settleLedgerEntryBestEffort(
    db,
    AFFILIATE_LEDGER,
    { bookingIntentId: input.bookingIntentId, payeeId: input.recruiterPractitionerId },
    deps,
  );
}
