/**
 * WHO OWNS A CLIENT — the earliest-touch lock (spec v1.4 §3.1, rulings R4/R5/R8/R9).
 *
 * Decided ONCE, when client C first books practitioner Y, and never recomputed. Three timestamps
 * decide it:
 *
 *   L = the earliest entry for C on **Y's own** client list
 *   B = when C's first booking with Y was created
 *   R = the earliest unexpired referral of C to Y by somebody else
 *
 *   cutoff = min(B, R)
 *   owner  = PRACTITIONER   iff  L exists and L < cutoff        → 0% forever (R4)
 *          = NHP            otherwise, with the referrer named when one exists (R6/R7)
 *
 * ⚠️ THE CUTOFF IS `min(B, R)`, NOT `B`, AND THAT IS THE WHOLE POINT OF R5. Without R in it, Y
 * could watch a referred client arrive and add them to their list before the booking completed,
 * taking the referrer's 20% away after the introduction had already been made. Spec §9 test 11 is
 * that exact sequence.
 *
 * ⚠️ R8: only Y's OWN list exempts Y. X's list is irrelevant here and is never read — which is
 * also the privacy property, since a decision that consulted another practitioner's list would be
 * a query path capable of returning their clients.
 *
 * ⚠️ R9: the referrer needs no session of their own with C. Nothing in this module's input can
 * express such a precondition, deliberately — adding one would require adding a field, which is
 * where that decision would surface for review.
 *
 * NO PRISMA HERE. The inputs are resolved by the caller (`resolveAttributionInputs` in
 * attributed-clients.ts) so the rule itself is testable without a database, and so this module
 * stays importable from the fee path without dragging Prisma into that graph.
 */

export type AttributionOwner = 'PRACTITIONER' | 'NHP';

export type AttributionRule = 'LIST_BEFORE_CUTOFF' | 'NHP_SOURCED' | 'CROSS_REFERRED';

/** One referral touch, already scoped to this (client, practitioner) pair by the caller. */
export type ReferralTouchCandidate = {
  touchId: string;
  referrerPractitionerId: string;
  /** Immutable once set. EMAIL → the send time; LINK → the first open. Null = not yet attached. */
  receivedAt: Date | null;
  /** The issuing referral's expiry — `issuedAt` + the snapshotted term. */
  expiresAt: Date;
};

export type AttributionDecision = {
  owner: AttributionOwner;
  decidedByRule: AttributionRule;
  referrerPractitionerId: string | null;
  referralTouchId: string | null;
};

/**
 * The referrals that may decide anything: received, unexpired, and not made by the booked
 * practitioner themselves.
 *
 * ⚠️ EXPIRY IS JUDGED AT `receivedAt`, NOT AT BOOKING TIME. §5.4.7 gates the link at the moment it
 * is OPENED — "after expires_at, the link still goes to Y's page, but no referral is recorded" —
 * so a touch that exists at all was created while the link was live. Re-testing it against the
 * booking instant would retroactively unpay a referrer whose introduction demonstrably worked and
 * whose client simply took a while to book. The check is kept anyway, as a guard against a touch
 * written by some future path that does not gate at open.
 *
 * A self-referral is dropped HERE rather than at the end, so it cannot enter the cutoff either.
 * Counting Y's own referral toward `min(B, R)` would let Y invalidate their own list entry.
 */
export function eligibleReferralTouches(
  touches: ReferralTouchCandidate[],
  bookedPractitionerId: string,
): Array<ReferralTouchCandidate & { receivedAt: Date }> {
  return touches.filter(
    (t): t is ReferralTouchCandidate & { receivedAt: Date } =>
      t.receivedAt !== null &&
      t.receivedAt.getTime() < t.expiresAt.getTime() &&
      t.referrerPractitionerId !== bookedPractitionerId,
  );
}

/**
 * Order referrals so the winner is the earliest received, with a DETERMINISTIC tie-break.
 *
 * The tie-break is not decoration. Two referrals can share a `receivedAt` (two emails sent in the
 * same batch, two opens in the same millisecond), and without a total order the winner would
 * depend on the database's row order — so the same booking could pay different people on a replay
 * or after a reindex. Ordering on the touch id makes it reproducible.
 */
function earliestReferral(
  touches: Array<ReferralTouchCandidate & { receivedAt: Date }>,
): (ReferralTouchCandidate & { receivedAt: Date }) | null {
  if (touches.length === 0) return null;
  return [...touches].sort(
    (a, b) =>
      a.receivedAt.getTime() - b.receivedAt.getTime() || (a.touchId < b.touchId ? -1 : 1),
  )[0]!;
}

export function decideAttribution(input: {
  /** Y — the practitioner being booked. */
  practitionerId: string;
  /** L. Null when this client has never been on Y's list. */
  listEntryAddedAt: Date | null;
  /** B — when the client's first booking with Y was created. */
  firstBookingAt: Date;
  referralTouches: ReferralTouchCandidate[];
}): AttributionDecision {
  const eligible = eligibleReferralTouches(input.referralTouches, input.practitionerId);
  const winner = earliestReferral(eligible);

  const cutoff = winner
    ? Math.min(input.firstBookingAt.getTime(), winner.receivedAt.getTime())
    : input.firstBookingAt.getTime();

  // STRICTLY before (R5). An entry made at the same instant as the cutoff does not exempt: the
  // tie has to break against the practitioner, or "added them as the booking came in" becomes a
  // free session.
  if (input.listEntryAddedAt && input.listEntryAddedAt.getTime() < cutoff) {
    return {
      owner: 'PRACTITIONER',
      decidedByRule: 'LIST_BEFORE_CUTOFF',
      referrerPractitionerId: null,
      referralTouchId: null,
    };
  }

  if (winner) {
    return {
      owner: 'NHP',
      decidedByRule: 'CROSS_REFERRED',
      referrerPractitionerId: winner.referrerPractitionerId,
      referralTouchId: winner.touchId,
    };
  }

  return {
    owner: 'NHP',
    decidedByRule: 'NHP_SOURCED',
    referrerPractitionerId: null,
    referralTouchId: null,
  };
}
