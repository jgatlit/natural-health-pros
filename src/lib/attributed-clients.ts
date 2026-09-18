import { createHash } from 'node:crypto';

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
 * How long a platform-sourced client stays attributed. Operator decision, 2026-09-17: one year.
 * Parameterised because it is a COMMERCIAL term, not a technical default — the same reason plan
 * prices live in env.
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
    findUnique(args: any): Promise<{ expiresAt: Date } | null>;
  };
};

/**
 * Record (or refresh) an attribution claim.
 *
 * Idempotent by (practitionerId, emailHash). A repeat platform-sourced booking EXTENDS the window
 * rather than creating a second row — the claim is on the relationship, not on the transaction.
 * `attributedAt` is never moved backwards, so the original introduction date survives.
 */
export async function recordAttributedClient(
  db: Db,
  input: {
    practitionerId: string;
    email: string;
    party?: 'PRACTITIONER' | 'NHP' | null;
    source?: string | null;
    bookingIntentId?: string | null;
    at?: Date;
  },
): Promise<{ emailHash: string }> {
  const at = input.at ?? new Date();
  const emailHash = hashClientEmail(input.email);
  await db.attributedClient.upsert({
    where: { practitionerId_emailHash: { practitionerId: input.practitionerId, emailHash } },
    create: {
      practitionerId: input.practitionerId,
      emailHash,
      party: input.party ?? null,
      source: input.source ?? null,
      firstBookingIntentId: input.bookingIntentId ?? null,
      attributedAt: at,
      expiresAt: attributionExpiry(at),
    },
    update: { expiresAt: attributionExpiry(at) },
  });
  return { emailHash };
}

/**
 * Has this practitioner already had a platform-sourced session with this client, inside the window?
 *
 * Returns true when the ledger holds a LIVE claim. An expired row is deliberately not deleted —
 * it is history, and the sweep reads it — but it no longer suppresses a first-session fee.
 */
/**
 * The three states a client can be in for fee purposes. "NONE" and "EXPIRED" are deliberately
 * distinct: never-seen means we are introducing them (a first session), while expired means we
 * introduced them over a year ago and no longer have a claim at all.
 */
export type ClaimState = 'NONE' | 'LIVE' | 'EXPIRED';

export async function claimState(
  db: Db,
  input: { practitionerId: string; email: string; now?: Date },
): Promise<ClaimState> {
  const now = input.now ?? new Date();
  const row = await db.attributedClient.findUnique({
    where: {
      practitionerId_emailHash: {
        practitionerId: input.practitionerId,
        emailHash: hashClientEmail(input.email),
      },
    },
    select: { expiresAt: true },
  });
  if (!row) return 'NONE';
  return row.expiresAt > now ? 'LIVE' : 'EXPIRED';
}

export async function hasLiveAttribution(
  db: Db,
  input: { practitionerId: string; email: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const row = await db.attributedClient.findUnique({
    where: {
      practitionerId_emailHash: {
        practitionerId: input.practitionerId,
        emailHash: hashClientEmail(input.email),
      },
    },
    select: { expiresAt: true },
  });
  return !!row && row.expiresAt > now;
}

/**
 * Is the booking about to be paid a FIRST session for fee purposes?
 *
 * First session = no live claim yet. The fee is therefore charged once per client relationship per
 * window, which is exactly how Plan B was described to practitioners.
 */
export async function isFirstSession(
  db: Db,
  input: { practitionerId: string; email: string; now?: Date },
): Promise<boolean> {
  return !(await hasLiveAttribution(db, input));
}
