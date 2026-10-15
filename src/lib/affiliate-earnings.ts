/**
 * WHAT A RECRUITER MAY SEE ABOUT THE PEOPLE THEY BROUGHT IN (spec v1.5 section 5).
 *
 * "Practitioners you brought in" shows who joined through your link and what the affiliate share
 * has earned, as the ledger records it. Nothing else. In particular:
 *
 *   - no client data of any kind: no email, no name, no booking, no payment id. The ledger query
 *     selects amounts, states and dates only, and the practitioner query selects a display name,
 *     a slug and two dates;
 *   - no per-person earnings: the totals are the recruiter's own, summed. Which recruited
 *     practitioner's clients paid what is the recruited practitioner's business;
 *   - everything is scoped by the recruiter's id, which the caller takes from the verified owner
 *     of the page, never from a request parameter (IDOR discipline).
 *
 * The RECRUITED practitioner sees none of this about themselves (spec section 5); this module is
 * only ever called for the recruiter's own dashboard.
 */

import { whereRecruitedBy } from './recruiter';

export type EarningsDb = {
  practitioner: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any>;
  };
  affiliateLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any>;
  };
  affiliateBalanceAdjustment: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any>;
  };
};

/** One refund debit, as the recruiter sees it. No client data: an amount, a state and a date. */
export type RefundAdjustmentRow = {
  amountUsdCents: number;
  appliedUsdCents: number;
  state: 'OPEN' | 'APPLIED';
  createdAt: Date;
};

export type AdjustmentTotals = {
  /** Still owed by the recruiter and to be netted off their next payouts (never negative). */
  openBalanceUsdCents: number;
  /** Already netted off payouts: shown as "adjusted for a refund". */
  appliedUsdCents: number;
};

export function summarizeAdjustments(
  rows: Array<{ amountUsdCents: number; appliedUsdCents: number }>,
): AdjustmentTotals {
  let open = 0;
  let applied = 0;
  for (const r of rows) {
    open += Math.max(0, r.amountUsdCents - r.appliedUsdCents);
    applied += r.appliedUsdCents;
  }
  return { openBalanceUsdCents: open, appliedUsdCents: applied };
}

export type RecruitedPractitionerRow = {
  id: string;
  displayName: string;
  slug: string;
  recruitedAt: Date | null;
  /** Whether the profile is currently published in the directory (`listedWhere`). */
  published: boolean;
};

export type RecruiterEarnings = {
  recruits: RecruitedPractitionerRow[];
  /** Owed and not yet credited: waiting on the transfer, or on a verified Whop account. */
  accruedUsdCents: number;
  /** Actually credited to the recruiter's Whop balance. */
  settledUsdCents: number;
  /** Credited rows with their breakdown: the share, what refund debits took off it, what was credited. */
  paidGrossUsdCents: number;
  paidAdjustedUsdCents: number;
  paidNetUsdCents: number;
  /** How many credited rows carry that breakdown. */
  paidBreakdownCount: number;
  /** Refunds that came in AFTER a share was paid: the open balance and what was already netted. */
  refundBalanceOpenUsdCents: number;
  refundAdjustedUsdCents: number;
  /** Most recent first. */
  refundAdjustments: RefundAdjustmentRow[];
};

/** Upper bound on rows summed in memory; a recruiter beyond this needs a SQL aggregate instead. */
const LEDGER_ROW_CAP = 20_000;

export async function loadRecruiterEarnings(
  db: EarningsDb,
  recruiterPractitionerId: string,
  listedFilter: Record<string, unknown>,
): Promise<RecruiterEarnings> {
  const [recruits, listed, entries, adjustments] = await Promise.all([
    db.practitioner.findMany({
      where: { ...whereRecruitedBy(recruiterPractitionerId), archivedAt: null },
      select: { id: true, displayName: true, slug: true, recruitedAt: true },
      orderBy: { recruitedAt: 'desc' },
    }) as Promise<Array<{ id: string; displayName: string; slug: string; recruitedAt: Date | null }>>,
    db.practitioner.findMany({
      where: { ...whereRecruitedBy(recruiterPractitionerId), ...listedFilter },
      select: { id: true },
    }) as Promise<Array<{ id: string }>>,
    db.affiliateLedgerEntry.findMany({
      where: { recruiterPractitionerId },
      select: {
        state: true,
        shareUsdCents: true,
        reversedUsdCents: true,
        transferUsdCents: true,
        grossShareUsdCents: true,
        netPaidUsdCents: true,
        adjustmentAppliedUsdCents: true,
      },
      take: LEDGER_ROW_CAP,
    }) as Promise<
      Array<{
        state: string;
        shareUsdCents: number;
        reversedUsdCents: number;
        transferUsdCents: number | null;
        grossShareUsdCents?: number | null;
        netPaidUsdCents?: number | null;
        adjustmentAppliedUsdCents?: number | null;
      }>
    >,
    // Scoped by the recruiter's id (taken from the verified owner of the page), amounts and dates
    // only: the source ledger row, and with it any client or booking, is deliberately not selected.
    db.affiliateBalanceAdjustment.findMany({
      where: { recruiterPractitionerId },
      select: { amountUsdCents: true, appliedUsdCents: true, state: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: LEDGER_ROW_CAP,
    }) as Promise<RefundAdjustmentRow[]>,
  ]);

  const listedIds = new Set(listed.map((p) => p.id));
  const totals = summarizeEntries(entries);
  const adjusted = summarizeAdjustments(adjustments);

  return {
    recruits: recruits.map((p) => ({ ...p, published: listedIds.has(p.id) })),
    accruedUsdCents: totals.accruedUsdCents,
    settledUsdCents: totals.settledUsdCents,
    paidGrossUsdCents: totals.paidGrossUsdCents,
    paidAdjustedUsdCents: totals.paidAdjustedUsdCents,
    paidNetUsdCents: totals.paidNetUsdCents,
    paidBreakdownCount: totals.paidBreakdownCount,
    refundBalanceOpenUsdCents: adjusted.openBalanceUsdCents,
    refundAdjustedUsdCents: adjusted.appliedUsdCents,
    refundAdjustments: adjustments.slice(0, 10),
  };
}

export type LedgerAmounts = {
  state: string;
  shareUsdCents: number;
  reversedUsdCents: number;
  transferUsdCents: number | null;
  grossShareUsdCents?: number | null;
  netPaidUsdCents?: number | null;
  /** Refund debit already netted against THIS row's share (null/absent = none). */
  adjustmentAppliedUsdCents?: number | null;
};

export type LedgerTotals = {
  accruedUsdCents: number;
  settledUsdCents: number;
  paidGrossUsdCents: number;
  /** Of the paid gross, what refund debits absorbed instead of being sent. */
  paidAdjustedUsdCents: number;
  paidNetUsdCents: number;
  paidBreakdownCount: number;
};

/**
 * The one place ledger rows become the numbers a person reads. Amounts are NET of refunds
 * (share - reversed) and of any refund debit already netted against the row. REVERSED rows owe
 * nothing; SETTLED rows count what was actually transferred. A refund that arrives AFTER a transfer
 * was claimed is not a row here: it is an `AffiliateBalanceAdjustment`, summarised by
 * `summarizeAdjustments`.
 */
export function summarizeEntries(entries: LedgerAmounts[]): LedgerTotals {
  const t: LedgerTotals = {
    accruedUsdCents: 0,
    settledUsdCents: 0,
    paidGrossUsdCents: 0,
    paidAdjustedUsdCents: 0,
    paidNetUsdCents: 0,
    paidBreakdownCount: 0,
  };
  for (const e of entries) {
    const adjusted = e.adjustmentAppliedUsdCents ?? 0;
    // What the recruiter is still owed on this row: the share after refunds and after any debit
    // already netted against it.
    const net = Math.max(0, e.shareUsdCents - e.reversedUsdCents - adjusted);
    if (e.state === 'SETTLED') {
      const paid = e.transferUsdCents ?? net;
      t.settledUsdCents += paid;
      if (e.grossShareUsdCents != null && e.netPaidUsdCents != null) {
        t.paidGrossUsdCents += e.grossShareUsdCents;
        t.paidAdjustedUsdCents += adjusted;
        t.paidNetUsdCents += e.netPaidUsdCents;
        t.paidBreakdownCount += 1;
      }
    } else if (e.state === 'ACCRUED' || e.state === 'SENDING' || e.state === 'HELD') {
      t.accruedUsdCents += e.transferUsdCents ?? net;
    }
    // REVERSED: nothing is owed.
  }
  return t;
}
