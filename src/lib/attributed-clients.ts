import { createHash } from 'node:crypto';

import { snapshotTerm, termState, type TermState } from './attribution-term';

/**
 * The attribution ledger — which clients Natural Health Pros sourced for a practitioner, and for
 * how long that claim lasts.
 *
 * This exists to answer ONE question the money depends on: is this the FIRST platform-sourced
 * session with this client, or a repeat? Plan B charges a large first-session split and nothing
 * after it, so without a durable record of who we introduced, every booking looks like a first
 * booking and the split is charged forever — the opposite of what was promised on the 2026-09-14
 * call.
 *
 * It is also the evidence base for the leakage question (a Plan B practitioner rebooking a
 * platform-sourced client privately). See docs/2026-09-17-plan-ab-onboarding-and-attribution.md.
 */

/**
 * DEPRECATED — superseded by the Lead Attribution Term (operator ruling 5, 2026-09-18: one term,
 * 8 months, one admin setting, governing BOTH plans and snapshotted per row).
 *
 * Retained ONLY to keep writing the legacy `expiresAt` column while the previously-deployed
 * release still reads it (expand/contract). Nothing may branch on this for money — `termState()`
 * is the authority. Delete with the column.
 */
export function attributionWindowDays(): number {
  const raw = process.env.ATTRIBUTION_CLAIM_WINDOW_DAYS;
  if (raw === undefined || raw.trim() === '') return 365;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`ATTRIBUTION_CLAIM_WINDOW_DAYS must be a positive integer (got ${raw})`);
  }
  return n;
}

/**
 * Emails are stored HASHED, never in the clear.
 *
 * The ledger's only job is equality matching, which a hash does exactly as well as plaintext, and
 * this is a health-adjacent directory: a table of "people who saw a practitioner" is the most
 * sensitive thing we would hold. Normalisation is lowercase + trim only — deliberately NOT
 * gmail-style dot/plus stripping, which silently merges genuinely different addresses at other
 * providers and would attribute one person's booking to another.
 *
 * ATTRIBUTION_EMAIL_SALT makes the hashes useless outside our own database. If it is ever
 * rotated, every existing row stops matching, so treat it as permanent once set.
 */
export function hashClientEmail(email: string): string {
  const normalised = email.trim().toLowerCase();
  if (!normalised) throw new Error('cannot hash an empty email');
  const salt = process.env.ATTRIBUTION_EMAIL_SALT ?? '';
  return createHash('sha256').update(`${salt}:${normalised}`).digest('hex');
}

export function attributionExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + attributionWindowDays() * 86_400_000);
}

/**
 * STRUCTURAL, not `Pick<PrismaClient, 'attributedClient'>`. This module needs exactly two calls,
 * and typing it against the generated delegate would force every test to stub sixteen methods it
 * never invokes — which is how a unit test ends up depending on a database.
 */
type Db = {
  attributedClient: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(args: any): Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany(args: any): Promise<{ count: number }>;
  };
};

/** The columns the fee path reads. `expiresAt` is legacy; the term fields are the authority. */
export type AttributionRow = {
  expiresAt: Date;
  termMonths?: number | null;
  termAnchorAt?: Date | null;
  termEndsAt?: Date | null;
  referrerPractitionerId?: string | null;
};

/**
 * Record an attribution claim — THE EARLIEST-TOUCH LOCK.
 *
 * Idempotent by (practitionerId, emailHash), and on a repeat booking it deliberately changes
 * ALMOST NOTHING. This is the behavioural reversal in stage 2, and it is worth being explicit
 * about what it fixes:
 *
 * ⚠️ THE SHIPPED CODE EXTENDED THE WINDOW ON EVERY REPEAT BOOKING (`update: { expiresAt: … }`).
 * That made the claim a ROLLING window rather than a fixed term, with two consequences that both
 * moved money the wrong way. A practitioner could never age out of a claim while the client kept
 * booking — the term was unbounded in practice, which is not what was sold. And the mirror image
 * was worse: when a row DID finally lapse, the next booking with a client we introduced years ago
 * re-entered as a fresh first session and was charged a SECOND first-session fee (see the
 * `EXPIRED` branch of the old `sessionFeeBps`). One client relationship, two first-session
 * charges. The term is now fixed at the earliest touch and never moves.
 *
 * The ONLY fields a later call may fill are ones that were unknowable at first touch:
 *   - `termAnchorAt`/`termEndsAt`, ONLY while the anchor is still null. Since 2026-09-19 the
 *     anchor is the transaction instant, which is always known here, so a CREATE always sets it
 *     and this fill now reaches only rows written before the term columns existed. Once anchored,
 *     the clock is immutable.
 *   - `referrerPractitionerId`, same rule: first referrer named wins, for the same reason the
 *     first booking that introduced a client is never rewritten.
 * `attributedAt` is never moved. `termMonths` is snapshotted at creation and never re-read from
 * the admin setting, so an operator editing the term cannot reprice a claim already sold.
 */
export async function recordAttributedClient(
  db: Db,
  input: {
    practitionerId: string;
    email: string;
    party?: 'PRACTITIONER' | 'NHP' | null;
    source?: string | null;
    bookingIntentId?: string | null;
    /** The term to snapshot, in months. Resolve it from `loadSettings()` at the call site. */
    termMonths: number;
    /**
     * THE DAY OF TRANSACTION — the instant this client's payment to this practitioner succeeded.
     *
     * REQUIRED and non-null (operator correction, 2026-09-19). It was `sessionStartsAt`, optional,
     * and null meant "anchor it later" — except nothing ever did, because this is the only place
     * an anchor is ever supplied. The payment instant always exists on the transition that calls
     * this, so there is no legitimate null left to accept.
     */
    transactedAt: Date;
    /** The practitioner who referred this client, when the booking carried a referral token. */
    referrerPractitionerId?: string | null;
    /**
     * THE DECISION TAKEN AT MINT (spec §3.1/§3.2), committed here rather than re-derived.
     *
     * Passed in because the fee the buyer was actually charged was computed from it, before this
     * handler ran. Re-deriving it here could disagree with the amount Whop has already taken, and
     * that disagreement has no resolution — the money has moved.
     */
    owner?: 'PRACTITIONER' | 'NHP' | null;
    decidedByRule?: string | null;
    /** The referral touch that carried this client in, when the referral actually earned. */
    referralTouchId?: string | null;
    at?: Date;
  },
): Promise<{ emailHash: string }> {
  const at = input.at ?? new Date();
  const emailHash = hashClientEmail(input.email);
  const term = snapshotTerm({ termMonths: input.termMonths, anchorAt: input.transactedAt });
  const where = { practitionerId_emailHash: { practitionerId: input.practitionerId, emailHash } };

  // CREATE-ONLY. The update branch is deliberately EMPTY: on a repeat booking there is nothing
  // about an existing claim that this call is entitled to change. Everything a later touch may
  // legitimately fill is written below, each behind its own "only if still unset" filter, so the
  // lock is enforced by the database rather than by the order in which handlers happen to run.
  const stored = (await db.attributedClient.upsert({
    where,
    create: {
      practitionerId: input.practitionerId,
      emailHash,
      party: input.party ?? null,
      source: input.source ?? null,
      firstBookingIntentId: input.bookingIntentId ?? null,
      attributedAt: at,
      // Legacy column, still written for the currently-deployed release. Not read for money.
      expiresAt: attributionExpiry(at),
      termMonths: term.termMonths,
      termAnchorAt: term.termAnchorAt,
      termEndsAt: term.termEndsAt,
      referrerPractitionerId: input.referrerPractitionerId ?? null,
      owner: input.owner ?? 'NHP',
      decidedAt: input.owner ? at : null,
      decidedByRule: input.decidedByRule ?? null,
      referralTouchId: input.referralTouchId ?? null,
    },
    update: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)) as
    | { attributedAt?: Date | null; termAnchorAt?: Date | null; termMonths?: number | null }
    | null
    | undefined;

  // REPAIR A LEGACY UNANCHORED ROW, ONCE — and anchor it on ITS OWN first payment.
  //
  // Since 2026-09-19 the CREATE above always writes an anchor, so this can no longer fire for a
  // row this release made. What it exists for is the rows it cannot create: an `AttributedClient`
  // written before the term columns existed, or one the previous deploy inserted during the
  // migration window. Those are `PENDING_ANCHOR` — chargeable with NO end date — and if they are
  // left alone the client is charged the platform share forever.
  //
  // ⚠️ THE ANCHOR COMES FROM `attributedAt`, NOT FROM THIS PAYMENT. `attributedAt` on such a row
  // IS its first payment instant (the ledger write has always run on the `payment.succeeded`
  // transition), so it is the correct clock. Anchoring on THIS payment instead would run the term
  // from the client's second or fifth session and bill the practitioner months past the eight they
  // were sold — a money bug in our favour, which is the kind that never gets reported.
  //
  // `termAnchorAt: null` stays in the filter: an already-anchored row matches nothing, and two
  // concurrent payments cannot race each other into re-anchoring because only one can match.
  //
  // ⚠️ AND IT KEEPS THE ROW'S OWN `termMonths`. Filling a missing anchor is not a licence to also
  // rewrite a term already sold — R1 is forward-only, and the per-row snapshot exists so that an
  // operator moving the admin setting cannot reprice a live claim. `input.termMonths` is today's
  // setting and is only correct for a row that never had one.
  const legacyAnchor = stored && !stored.termAnchorAt ? (stored.attributedAt ?? null) : null;
  if (legacyAnchor) {
    const repaired = snapshotTerm({
      termMonths: stored?.termMonths ?? input.termMonths,
      anchorAt: legacyAnchor,
    });
    await db.attributedClient.updateMany({
      where: { practitionerId: input.practitionerId, emailHash, termAnchorAt: null },
      data: {
        termAnchorAt: repaired.termAnchorAt,
        termEndsAt: repaired.termEndsAt,
        termMonths: repaired.termMonths,
      },
    });
  }

  // DECIDE THE OWNER, ONCE. Same lock shape as the anchor, and it exists for the rows that
  // predate this column: they carry `owner` at its schema default and `decidedAt` null, which
  // means "never decided" rather than "decided as NHP". Filtering on `decidedAt: null` fills those
  // in on their next payment without ever re-deciding a row that already has an answer.
  if (input.owner) {
    await db.attributedClient.updateMany({
      where: { practitionerId: input.practitionerId, emailHash, decidedAt: null },
      data: {
        owner: input.owner,
        decidedAt: at,
        decidedByRule: input.decidedByRule ?? null,
        referralTouchId: input.referralTouchId ?? null,
      },
    });
  }

  // NAME THE REFERRER, ONCE, for the same reason: a later referral link must not steal credit —
  // and therefore money — from whoever actually made the introduction.
  if (input.referrerPractitionerId) {
    await db.attributedClient.updateMany({
      where: { practitionerId: input.practitionerId, emailHash, referrerPractitionerId: null },
      data: { referrerPractitionerId: input.referrerPractitionerId },
    });
  }

  return { emailHash };
}

/**
 * Where this client sits in this practitioner's attribution term.
 *
 * ⚠️ NOT ON THE FEE PATH, despite what this docstring used to claim. `resolveBookingFee()` reads
 * the row itself (it needs `owner` and `referrerPractitionerId` from the same query) and calls
 * `termState()` directly, so nothing in `src/` calls this. It is the integration-level expression
 * of the rule and is exercised by the regression suite; treat it as a read helper, not as the
 * place to change behaviour — an edit here moves no money.
 *
 * Replaces `claimState()`'s NONE/LIVE/EXPIRED, which encoded the once-per-client rule that the
 * operator reversed on 2026-09-18. The states are no longer about whether a fee has been charged
 * before; they are about whether we are inside the term we sold.
 *
 * ⚠️ `asOf` IS THIS SESSION'S OWN TRANSACTION INSTANT, and it is REQUIRED for exactly that reason.
 * Spec §6.1's "sessions count by scheduled start" was SUPERSEDED on 2026-09-19: the boundary now
 * reads the same calendar the anchor was set from, because a boundary on one calendar and a clock
 * on another charge inconsistently at the edge — a session paid inside the term for a date outside
 * it, or the reverse. Spec §9 test 5 (months 0, 4 and 8) is precisely that off-by-one, and it is
 * now measured on payment dates. An optional parameter defaulting to `new Date()` is what let the
 * fee path read the wrong clock while every unit test — which passes the instant explicitly —
 * still passed, so it stays required even though "now" is frequently the right answer.
 */
export async function attributionTermState(
  db: Db,
  input: { practitionerId: string; email: string; asOf: Date },
): Promise<TermState> {
  const row = (await db.attributedClient.findUnique({
    where: {
      practitionerId_emailHash: {
        practitionerId: input.practitionerId,
        emailHash: hashClientEmail(input.email),
      },
    },
    select: { expiresAt: true, termMonths: true, termAnchorAt: true, termEndsAt: true },
  })) as AttributionRow | null;
  if (!row) return 'NONE';
  return termState(
    { termAnchorAt: row.termAnchorAt ?? null, termEndsAt: row.termEndsAt ?? null },
    input.asOf,
  );
}

/**
 * Does the ledger hold ANY claim on this client for this practitioner, live or lapsed?
 *
 * The leakage sweep and the Clients & Referrals list both need "have we ever introduced them",
 * which is a different question from "may we charge for this session" and must not be answered
 * with the fee-path helper.
 */
export async function hasAnyAttribution(
  db: Db,
  input: { practitionerId: string; email: string },
): Promise<boolean> {
  const row = await db.attributedClient.findUnique({
    where: {
      practitionerId_emailHash: {
        practitionerId: input.practitionerId,
        emailHash: hashClientEmail(input.email),
      },
    },
    select: { expiresAt: true },
  });
  return !!row;
}
