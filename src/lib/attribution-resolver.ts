/**
 * THE THREE READS BEHIND AN ATTRIBUTION DECISION (spec v1.4 §3.1).
 *
 * `decideAttribution` is deliberately pure; this is the half that touches the database. Split
 * because the two halves fail differently: the rule fails as arithmetic, and this fails as a
 * query — an unscoped `where`, a wrong `orderBy`, a missing OR clause.
 *
 * 🔒 THE PRIVACY RULE IS A QUERY SHAPE, NOT A CONVENTION (operator ruling, 2026-09-18). Every read
 * below is scoped by the booked practitioner. There is no bare `emailHash` lookup anywhere in this
 * module, and `ClientListEntry` deliberately carries no bare-hash index to make one cheap — a
 * hash-only read is precisely the query that would return another practitioner's clients, and R8
 * means such a read could not be correct anyway: only Y's own list exempts Y.
 */

import { decideAttribution, type AttributionDecision, type ReferralTouchCandidate } from './attribution-decision';
import { hashClientEmail } from './attributed-clients';

/**
 * STRUCTURAL, not the generated Prisma delegate — the same reasoning as `attributed-clients.ts`.
 * Three calls; typing against the real client would force every test to stub methods it never
 * invokes, which is how a unit test acquires a database.
 */
export type AttributionResolverDb = {
  clientListEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst(args: any): Promise<any>;
  };
  bookingIntent: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst(args: any): Promise<any>;
  };
  referralTouch: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any>;
  };
};

/** The shape each read is NARROWED to below — declared once so the `select` and the use agree. */
type ListEntryRow = { addedAt: Date } | null;
type FirstBookingRow = { createdAt: Date } | null;
type TouchRow = {
  id: string;
  receivedAt: Date | null;
  referral: { referrerId: string; referredId: string; expiresAt: Date } | null;
};

export type AttributionInputs = {
  /** L — the earliest entry for this client on THIS practitioner's list. */
  listEntryAddedAt: Date | null;
  /** B — when the client's FIRST booking with this practitioner was created. */
  firstBookingAt: Date;
  /** R — every referral of this client to this practitioner that could decide anything. */
  referralTouches: ReferralTouchCandidate[];
};

export async function resolveAttributionInputs(
  db: AttributionResolverDb,
  input: {
    practitionerId: string;
    email: string;
    /** When the booking being priced was created — the fallback for B, and usually B itself. */
    bookingCreatedAt: Date;
    /** The touch carried on this booking's intent, if the visitor arrived through `/r/<token>`. */
    referralTouchId?: string | null;
  },
): Promise<AttributionInputs> {
  const emailHash = hashClientEmail(input.email);

  // Narrowed rather than inferred: the delegate types are `any` above so that both PrismaClient
  // and a structural test stub satisfy them, so this cast is where the `select` contract is stated.
  const [listEntry, firstBooking, touches] = (await Promise.all([
    db.clientListEntry.findFirst({
      where: { practitionerId: input.practitionerId, emailHash },
      orderBy: { addedAt: 'asc' },
      select: { addedAt: true },
    }),

    // THE EARLIEST booking, not this one. B is a property of the RELATIONSHIP: if the cutoff moved
    // to the booking currently being priced, a list entry added after the relationship began would
    // retro-exempt it on the client's second visit, which is R5 defeated by patience.
    //
    // `mode: 'insensitive'` because `parseCapture` lowercases every new capture but rows predating
    // it may not, and a case mismatch here silently reads as "they have never booked before".
    db.bookingIntent.findFirst({
      where: {
        practitionerId: input.practitionerId,
        email: { equals: input.email, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),

    // Two ways a referral reaches this booking, and both are needed:
    //   - already ATTACHED to this client (an emailed referral, or a link they have used before);
    //   - CARRIED on this intent but not yet attached to anyone — the copied-link path, where the
    //     touch is created at `/r/<token>` before the client's email is known. Omitting this
    //     clause drops the referrer on the one booking that actually converted.
    // Both clauses are still scoped by `referral.referredId`, so a token minted for a different
    // practitioner cannot pay anybody here.
    db.referralTouch.findMany({
      where: {
        OR: [
          { clientEmailHash: emailHash, referral: { referredId: input.practitionerId } },
          ...(input.referralTouchId
            ? [{ id: input.referralTouchId, referral: { referredId: input.practitionerId } }]
            : []),
        ],
      },
      select: {
        id: true,
        receivedAt: true,
        referral: { select: { referrerId: true, referredId: true, expiresAt: true } },
      },
    }),
  ])) as [ListEntryRow, FirstBookingRow, TouchRow[]];

  const seen = new Set<string>();
  const referralTouches: ReferralTouchCandidate[] = [];
  for (const t of touches) {
    if (!t.referral || seen.has(t.id)) continue;
    seen.add(t.id);
    referralTouches.push({
      touchId: t.id,
      referrerPractitionerId: t.referral.referrerId,
      receivedAt: t.receivedAt,
      expiresAt: t.referral.expiresAt,
    });
  }

  return {
    listEntryAddedAt: listEntry?.addedAt ?? null,
    firstBookingAt: firstBooking?.createdAt ?? input.bookingCreatedAt,
    referralTouches,
  };
}

/** Resolve the inputs and apply the rule — the one call a fee path needs. */
export async function resolveAttributionDecision(
  db: AttributionResolverDb,
  input: {
    practitionerId: string;
    email: string;
    bookingCreatedAt: Date;
    referralTouchId?: string | null;
  },
): Promise<AttributionDecision> {
  const inputs = await resolveAttributionInputs(db, input);
  return decideAttribution({ practitionerId: input.practitionerId, ...inputs });
}
