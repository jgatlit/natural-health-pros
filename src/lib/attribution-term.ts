/**
 * THE LEAD ATTRIBUTION TERM — the single piece of date arithmetic that decides whether a session
 * is inside the window we are paid on (spec v1.4 §1.1, operator rulings 5 and 7, 2026-09-18, as
 * corrected 2026-09-19).
 *
 * Three rules, all operator-ruled rather than derived, and all of them previously lived as
 * different numbers in different files:
 *
 *  1. ONE TERM GOVERNS BOTH PLANS. Plan A and Plan B both drop to 0% at the same boundary. Plan A
 *     was previously carried as "20% forever"; that is now wrong and is asserted against.
 *  2. THE ANCHOR IS THE DAY OF TRANSACTION — the instant the client's FIRST payment to that
 *     practitioner succeeds. Not the session's scheduled start, not the click, not the row's
 *     creation. The per-session boundary is that session's own transaction instant, so the clock
 *     and the boundary read the SAME calendar.
 *  3. THE BOUNDARY IS EXCLUSIVE. Month 8 exactly is OUTSIDE an 8-month term (spec §9 test 3). This
 *     is the off-by-one that decides real money, so it is stated here and tested directly.
 *
 * ⚠️ RULE 2 REVERSES `c98bf6d`, WHICH ANCHORED ON THE SCHEDULED START (operator correction,
 * 2026-09-19). Two reasons, and the second is the load-bearing one:
 *
 *   - The payment date is the only instant all three parties can observe and agree on. The client
 *     has a receipt, the practitioner has a Whop payment, we have the webhook. A scheduled start
 *     is a claim made by a third-party scheduler we do not control and cannot always read.
 *   - It makes `PENDING_ANCHOR` unreachable by construction rather than by fallback. The old
 *     anchor depended on a field that is legitimately null for every practitioner without a
 *     scheduler link and that nothing ever back-fills; a payment instant ALWAYS exists on the
 *     transition that writes the row. The whole bug class disappears instead of being caught.
 *
 * The cost, stated plainly: anchoring at payment starts the clock EARLIER for any advance booking,
 * so a January payment for a March session reaches 0% sooner than it would have. That is a small
 * concession in the practitioner's favour and is the direct price of the two properties above.
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
   * A STORED ROW WITH NO ANCHOR. Treated as IN_TERM for fees — a term cannot have expired before
   * it began.
   *
   * ⚠️ KEPT DELIBERATELY, AND NO LONGER PRODUCIBLE BY THE WRITE PATH (2026-09-19). Since the
   * anchor became the payment instant, `snapshotTerm()` refuses a null anchor outright, so nothing
   * this codebase writes can land here. What CAN still land here is data:
   *
   *   - every `AttributedClient` row written before the term columns existed, and
   *   - any row the previous deploy inserts during the migration window, which knows nothing
   *     about those columns and leaves them null.
   *
   * Those rows are chargeable with NO END DATE, which is the 8-month promise inverted. The fix is
   * a backfill (`scripts/backfill-attribution-anchors.ts`) — possible only under this rule,
   * because `attributedAt` on such a row IS the payment instant. Re-reading a null anchor as
   * OUT_OF_TERM here would zero the fee on real stored rows instead, which is an operator's
   * revenue decision rather than a refactor's.
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
  /** The DAY OF TRANSACTION — the instant this client's payment to this practitioner succeeded. */
  anchorAt: Date;
}): { termMonths: number; termAnchorAt: Date; termEndsAt: Date } {
  const { termMonths, anchorAt } = input;
  if (!Number.isInteger(termMonths) || termMonths <= 0) {
    throw new Error(`termMonths must be a positive integer (got ${termMonths})`);
  }
  // REFUSE, rather than return a row that can never expire. The type already forbids null, and
  // the type is erased at runtime — this is the guard that actually holds, and it is the whole
  // reason `PENDING_ANCHOR` is now unreachable from the write path rather than merely unlikely.
  // It throws inside the webhook's ledger try/catch, which stamps /admin/whop-webhooks red; the
  // alternative is a silent claim that charges the platform share forever.
  if (!(anchorAt instanceof Date) || Number.isNaN(anchorAt.getTime())) {
    throw new Error(
      'snapshotTerm needs a real anchor date — the term anchors on the transaction instant, ' +
        'which always exists on the transition that writes the row',
    );
  }
  return {
    termMonths,
    termAnchorAt: anchorAt,
    termEndsAt: addMonths(anchorAt, termMonths),
  };
}

/**
 * Where does `now` sit relative to a stored attribution row?
 *
 * `row` is null when we have never seen this client for this practitioner.
 *
 * ⚠️ `now` IS THIS SESSION'S OWN TRANSACTION INSTANT, not the wall clock and not its scheduled
 * start (operator correction, 2026-09-19). The boundary must read the same calendar the anchor was
 * set from, or a session paid inside the term for a date outside it is charged inconsistently with
 * the clock it is being measured against.
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
