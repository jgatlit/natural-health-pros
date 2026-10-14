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
};

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
  /** Earned but still inside the hold period. */
  pendingUsdCents: number;
  /** Past the hold and owed: waiting on a payout run, or on a verified Whop wallet. */
  accruedUsdCents: number;
  /** Actually paid out. */
  settledUsdCents: number;
};

/** Upper bound on rows summed in memory; a recruiter beyond this needs a SQL aggregate instead. */
const LEDGER_ROW_CAP = 20_000;

export async function loadRecruiterEarnings(
  db: EarningsDb,
  recruiterPractitionerId: string,
  now: Date,
  listedFilter: Record<string, unknown>,
): Promise<RecruiterEarnings> {
  const [recruits, listed, entries] = await Promise.all([
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
        holdUntil: true,
      },
      take: LEDGER_ROW_CAP,
    }) as Promise<
      Array<{
        state: string;
        shareUsdCents: number;
        reversedUsdCents: number;
        transferUsdCents: number | null;
        holdUntil: Date;
      }>
    >,
  ]);

  const listedIds = new Set(listed.map((p) => p.id));
  const totals = summarizeEntries(entries, now);

  return {
    recruits: recruits.map((p) => ({ ...p, published: listedIds.has(p.id) })),
    pendingUsdCents: totals.pendingUsdCents,
    accruedUsdCents: totals.accruedUsdCents,
    settledUsdCents: totals.settledUsdCents,
  };
}

export type LedgerAmounts = {
  state: string;
  shareUsdCents: number;
  reversedUsdCents: number;
  transferUsdCents: number | null;
  holdUntil: Date;
};

export type LedgerTotals = {
  pendingUsdCents: number;
  accruedUsdCents: number;
  settledUsdCents: number;
  /** Rows parked by a failure that needs a human (`HELD`). Part of `accrued`, broken out. */
  heldUsdCents: number;
  /** Paid out and since refunded: owed BACK by the recruiter. Recorded, never clawed. */
  recoveryOwedUsdCents: number;
};

/**
 * The one place ledger rows become the three numbers a person reads. Amounts are NET of refunds
 * (share - reversed). REVERSED rows owe nothing; SETTLED rows count what was actually transferred.
 */
export function summarizeEntries(entries: LedgerAmounts[], now: Date): LedgerTotals {
  const t: LedgerTotals = {
    pendingUsdCents: 0,
    accruedUsdCents: 0,
    settledUsdCents: 0,
    heldUsdCents: 0,
    recoveryOwedUsdCents: 0,
  };
  for (const e of entries) {
    const net = Math.max(0, e.shareUsdCents - e.reversedUsdCents);
    if (e.state === 'SETTLED') {
      const paid = e.transferUsdCents ?? net;
      t.settledUsdCents += paid;
      t.recoveryOwedUsdCents += Math.max(0, paid - net);
    } else if (e.state === 'ACCRUED') {
      if (e.holdUntil.getTime() > now.getTime()) t.pendingUsdCents += net;
      else t.accruedUsdCents += net;
    } else if (e.state === 'HELD') {
      t.accruedUsdCents += net;
      t.heldUsdCents += net;
    } else if (e.state === 'SENDING') {
      t.accruedUsdCents += net;
      t.recoveryOwedUsdCents += Math.max(0, (e.transferUsdCents ?? 0) - net);
    }
    // REVERSED: nothing is owed.
  }
  return t;
}
