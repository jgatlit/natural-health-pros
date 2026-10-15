/**
 * PAYING REFERRERS (spec v1.4 §6.2, operator rulings 6 and 7).
 *
 * A referrer who can receive money is paid when the client's payment clears: the payment webhook
 * records the share and settles that one row in the same run, and the hourly whop-reconcile cron
 * retries any row with no receipt. The share is transferred in full to the referrer's Whop balance.
 * The state machine, the claim, the refund-debit netting, the retry classification and the alerts are
 * shared with the recruiter path and live in `ledger-transfer.ts`; this file binds them to the
 * referral ledger and owns the unclaimed-share window.
 *
 * THE UNCLAIMED-SHARE WINDOW (rulings 6 and 7). A share owed to a referrer who cannot receive money
 * yet is HELD, not lost: the referrer is told to claim their Whop account, the share settles
 * retroactively the moment they become payable (`promoteHeldToPayable`), and a hold that runs out
 * becomes EXPIRED_UNCLAIMED with no money action (`expireLapsedHolds`).
 *
 * 🚧 `WHOP_TRANSFERS_ENABLED` does not exist in production; while it is not exactly 'true' nothing
 * here moves money. Whop also refuses every transfer from the unverified parent company ("Please
 * verify your business before transferring funds"), which is an operator action in the Whop
 * dashboard, not a code fix.
 */

import { REFERRAL_LEDGER } from './ledger-config';
import {
  settleLedger,
  settleLedgerEntryBestEffort,
  type LedgerSettlementSummary,
  type LedgerTransferDb,
  type LookupFn,
  type TransferFn,
} from './ledger-transfer';

export {
  MAX_TRANSFER_USD_CENTS,
  payoutsGuard,
  toTransferDollars,
  type PayoutsGuard,
  type TransferFn,
} from './ledger-transfer';

export type SettlementSummary = LedgerSettlementSummary;

export function settlePayableShares(
  db: LedgerTransferDb,
  opts: {
    transfer: TransferFn;
    lookup: LookupFn;
    at: Date;
    /** Restrict the run to ONE ledger row (the post-payment trigger). Same rules, same guards. */
    only?: { bookingIntentId: string; referrerPractitionerId: string };
    /** Wall-clock budget (epoch ms): stop cleanly once it passes. See `SettleOptions`. */
    deadlineMs?: number;
  },
): Promise<SettlementSummary> {
  return settleLedger(db, REFERRAL_LEDGER, {
    transfer: opts.transfer,
    lookup: opts.lookup,
    at: opts.at,
    deadlineMs: opts.deadlineMs,
    only: opts.only && { bookingIntentId: opts.only.bookingIntentId, payeeId: opts.only.referrerPractitionerId },
  });
}

/** The post-payment trigger for one referrer row. Never throws; see `settleLedgerEntryBestEffort`. */
export function settleReferralEntryBestEffort(
  db: LedgerTransferDb,
  input: { bookingIntentId: string; referrerPractitionerId: string },
  deps: { transfer: TransferFn; lookup: LookupFn; at?: Date },
): Promise<SettlementSummary | null> {
  return settleLedgerEntryBestEffort(
    db,
    REFERRAL_LEDGER,
    { bookingIntentId: input.bookingIntentId, payeeId: input.referrerPractitionerId },
    deps,
  );
}

export type PayoutsDb = {
  referralLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany(args: any): Promise<{ count: number }>;
  };
  practitioner: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any>;
  };
};

/**
 * Ruling 6 — a held share settles RETROACTIVELY once its referrer becomes payable.
 *
 * Driven by a sweep rather than by the `identity_profile.approved` webhook on purpose: Whop drops
 * an event permanently after ~70 s of retries, and a referrer whose approval webhook was lost
 * would otherwise stay held forever with nothing reporting it.
 */
export async function promoteHeldToPayable(db: PayoutsDb): Promise<number> {
  const held = (await db.referralLedgerEntry.findMany({
    where: { state: 'HELD' },
    select: { id: true, referrerPractitionerId: true },
    take: 500,
  })) as Array<{ id: string; referrerPractitionerId: string }>;
  if (held.length === 0) return 0;

  const referrerIds = Array.from(new Set(held.map((r) => r.referrerPractitionerId)));
  const referrers = (await db.practitioner.findMany({
    where: { id: { in: referrerIds } },
    select: { id: true, whopCompanyId: true, whopPayoutsEnabled: true },
  })) as Array<{ id: string; whopCompanyId: string | null; whopPayoutsEnabled: boolean }>;

  const payable = new Set(
    referrers.filter((p) => p.whopCompanyId && p.whopPayoutsEnabled).map((p) => p.id),
  );
  const ids = held.filter((r) => payable.has(r.referrerPractitionerId)).map((r) => r.id);
  if (ids.length === 0) return 0;

  // Filtered on `state: 'HELD'` as well as the ids: an EXPIRED_UNCLAIMED row must never be swept
  // back into the payable set by this, because leaving that state is an operator decision.
  // `notifiedAt` is deliberately NOT cleared: it records that we told this referrer their money
  // was stuck, which stays true after it unsticks. Clearing it would re-queue the claim email.
  const { count } = await db.referralLedgerEntry.updateMany({
    where: { id: { in: ids }, state: 'HELD' },
    data: { state: 'PAYABLE' },
  });
  return count;
}

/**
 * Ruling 7 §4 — a hold that runs out becomes EXPIRED_UNCLAIMED, and NOTHING ELSE HAPPENS.
 *
 * ⚠️ NO MONEY ACTION, IN EITHER DIRECTION. Nothing is forfeited to the platform, nothing is
 * released, nothing is deleted. The amount, the referrer and the payment reference are all left
 * exactly as they were, so the balance stays reconcilable and settleable by an explicit operator
 * action. Day-91 policy is deliberately unruled; defaulting it either way silently moves real
 * money, and this transition exists so that the question is asked against real numbers rather
 * than answered by a default nobody chose.
 */
export async function expireLapsedHolds(db: PayoutsDb, opts: { at: Date }): Promise<number> {
  const { count } = await db.referralLedgerEntry.updateMany({
    where: { state: 'HELD', holdExpiresAt: { lte: opts.at } },
    data: { state: 'EXPIRED_UNCLAIMED' },
  });
  return count;
}
