/**
 * THE LEAD ATTRIBUTION TERM — the single piece of date arithmetic that decides whether a session
 * is inside the window we are paid on (spec v1.4 §1.1, operator rulings 5 and 7, 2026-09-18).
 *
 * Three rules, all operator-ruled rather than derived, and all of them previously lived as
 * different numbers in different files:
 *
 *  1. ONE TERM GOVERNS BOTH PLANS. Plan A and Plan B both drop to 0% at the same boundary. Plan A
 *     was previously carried as "20% forever"; that is now wrong and is asserted against.
 *  2. THE ANCHOR IS THE FIRST BOOKED SESSION'S SCHEDULED START — not the payment, not the click,
 *     not the row's creation. A client who books in January for a March session is attributed from
 *     March. Anchoring at payment (the shipped behaviour) quietly shortened every term.
 *  3. THE BOUNDARY IS EXCLUSIVE. Month 8 exactly is OUTSIDE an 8-month term (spec §9 test 3). This
 *     is the off-by-one that decides real money, so it is stated here and tested directly.
 *
 * ⚠️ NO PRISMA, NO `next/headers`. This is imported by the fee path AND by middleware-adjacent
 * code; pulling Prisma into that graph is what blew Vercel's 1 MB Edge limit before.
 */

/** Where a session falls relative to a client's attribution term. */
export type TermState =
  /** We have no claim on this client at all — this session INTRODUCES them. Chargeable. */
  | 'NONE'
  /** Inside the term. Chargeable at the plan's rate, on EVERY sourced session (ruling, 09-18). */
  | 'IN_TERM'
  /** The term has run out. 0% on BOTH plans. Never re-charge a first-session fee here. */
  | 'OUT_OF_TERM'
  /**
   * We hold a claim, but the first session has not happened yet, so the clock has not started.
   * Treated as IN_TERM for fees — the term cannot have expired before it began.
   */
  | 'PENDING_ANCHOR';

/**
 * Add whole calendar months, CLAMPING to the end of the target month.
 *
 * Calendar months, not 30-day blocks: an 8-month term sold in January ends in September, and a
 * practitioner reading "8 months" on their dashboard will check it against a calendar. Clamping
 * matters at the edges — 31 January + 1 month is 28/29 February, not 2/3 March, which is what
 * naive date arithmetic produces and what would hand a client an extra two days of term.
 */
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const targetMonth = d.getUTCMonth() + months;
  const dayOfMonth = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(targetMonth);
  const lastDayOfTarget = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(dayOfMonth, lastDayOfTarget));
  return d;
}

/**
 * Compute the term snapshot written onto an attribution row.
 *
 * SNAPSHOT, not a live read: the admin setting is editable, and a row that resolved its term at
 * read time would silently re-open claims already closed (and close ones already sold) the moment
 * an operator changed the number. Forward-only per R1 — this is the enforcement of that rule.
 */
export function snapshotTerm(input: {
  termMonths: number;
  /** The first booked session's scheduled start. Null when it is not known yet. */
  anchorAt: Date | null;
}): { termMonths: number; termAnchorAt: Date | null; termEndsAt: Date | null } {
  const { termMonths, anchorAt } = input;
  if (!Number.isInteger(termMonths) || termMonths <= 0) {
    throw new Error(`termMonths must be a positive integer (got ${termMonths})`);
  }
  return {
    termMonths,
    termAnchorAt: anchorAt,
    termEndsAt: anchorAt ? addMonths(anchorAt, termMonths) : null,
  };
}

/**
 * Where does `now` sit relative to a stored attribution row?
 *
 * `row` is null when we have never seen this client for this practitioner.
 *
 * ⚠️ THE `< termEndsAt` IS EXCLUSIVE ON PURPOSE. A session at exactly the boundary instant is
 * outside the term and charges nothing. See spec §9 test 3: months 0/3/6 charge, month 9 does not,
 * and month 8 exactly is outside.
 */
export function termState(
  row: { termEndsAt: Date | null; termAnchorAt: Date | null } | null,
  now: Date = new Date(),
): TermState {
  if (!row) return 'NONE';
  if (!row.termAnchorAt || !row.termEndsAt) return 'PENDING_ANCHOR';
  return now.getTime() < row.termEndsAt.getTime() ? 'IN_TERM' : 'OUT_OF_TERM';
}

/** Does this state mean the platform may charge its share? */
export function isChargeable(state: TermState): boolean {
  return state !== 'OUT_OF_TERM';
}

/**
 * When a held referral share lapses — hold start + the hold period (90 days, operator ruling 7).
 *
 * PER ROW. A referrer owed five shares has five clocks, because each was owed on a different day
 * and a shared clock would either expire money early or hold it late.
 */
export function holdExpiry(from: Date, holdDays: number): Date {
  if (!Number.isInteger(holdDays) || holdDays <= 0) {
    throw new Error(`holdDays must be a positive integer (got ${holdDays})`);
  }
  return new Date(from.getTime() + holdDays * 86_400_000);
}
