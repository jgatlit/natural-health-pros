import { randomBytes } from 'node:crypto';
import { RECRUITER_TOKEN_RE } from './recruiter-cookie';
import { bookableWhere } from './practitioner-indexer';

/** 16 random bytes as 32 hex chars: URL-safe, unguessable, and the same shape the migration's
 *  backfill (`replace(gen_random_uuid()::text,'-','')`) produces. Never derived from the id. */
export function newRecruiterToken(): string {
  return randomBytes(16).toString('hex');
}

export type RecruiterDb = {
  practitioner: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst(args: any): Promise<{ id: string } | null>;
  };
};

/**
 * Resolve a captured `nhpa` token to the recruiter, or null. Ignored (null) when the token is
 * malformed or unknown, belongs to the SAME user who is signing up (R != Y), or belongs to an
 * archived practitioner. The lookup is by the unique token column only.
 */
export async function resolveRecruiterId(
  db: RecruiterDb,
  token: string | null | undefined,
  newUserId: string,
): Promise<string | null> {
  const t = token?.trim();
  if (!t || !RECRUITER_TOKEN_RE.test(t)) return null;
  const recruiter = await db.practitioner.findFirst({
    where: { recruiterToken: t, archivedAt: null, NOT: { userId: newUserId } },
    select: { id: true },
  });
  return recruiter?.id ?? null;
}

/**
 * The ONLY place `recruitedById` is ever written, and it is written as part of the CREATE of the
 * new practitioner. There is no update path, so the first value is the last (tests/recruiter.test.ts
 * scans the source to keep it that way).
 */
export function recruitedFields(recruiterId: string | null, now: Date) {
  return recruiterId
    ? { recruitedById: recruiterId, recruitedAt: now, recruitedVia: 'JOIN_LINK' as const }
    : {};
}

/** Public sign-up URL a practitioner shares. `siteUrl` is the canonical origin from site.ts. */
export function joinLinkFor(siteUrl: string, cohortSlug: string, recruiterToken: string): string {
  return `${siteUrl}/join/${cohortSlug}?nhpa=${recruiterToken}`;
}

/** Spec §5 disclosure. Shown only when a recruiter was actually captured. */
export const RECRUITER_DISCLOSURE =
  '3% of your clients’ payments through Natural Health Pros goes to the person who brought you in. It comes out of our fee when we take one; when we don’t, it comes out of your payment.';

/**
 * THE RECRUITER SEAM FOR THE FEE PATH (spec v1.5 §5) — the ONE place the checkout mint learns who
 * recruited the practitioner being paid.
 *
 * The affiliate overlay in `resolveSessionFee` takes the recruiter's id as an INPUT; this is where
 * it comes from. It reads the immutable, first-wins `Practitioner.recruitedById` and returns it only
 * when that recruiter is still ACTIVE, else null (and null means "not recruited": nothing extra is
 * charged and nothing is credited):
 *
 *   - R must not be Y (self-recruitment earns nothing). The onboarding path already refuses to record
 *     it, and the fee rule ignores it again; this is the third line of defence.
 *   - R must not be archived or retired (`bookableWhere()`): an affiliate share owed to a soft-deleted
 *     or dead-mailbox row would accrue to no one.
 *
 * Lives in this file because `tests/recruiter.test.ts` pins `recruitedById` to appear in no other
 * source file; the read belongs next to the one write.
 */
export type RecruiterReadDb = {
  practitioner: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique(args: any): Promise<{ recruitedById: string | null } | null>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst(args: any): Promise<{ id: string } | null>;
  };
};

export async function getRecruiterFor(db: RecruiterReadDb, practitionerId: string): Promise<string | null> {
  const row = await db.practitioner.findUnique({
    where: { id: practitionerId },
    select: { recruitedById: true },
  });
  const recruiterId = row?.recruitedById ?? null;
  if (!recruiterId || recruiterId === practitionerId) return null;

  const active = await db.practitioner.findFirst({
    where: { id: recruiterId, ...bookableWhere() },
    select: { id: true },
  });
  return active?.id ?? null;
}

/**
 * First wins, immutable: a recruiter already on file is never replaced. Pure so the rule is
 * testable without a database; the persistence is the single create in /onboarding.
 */
export function recordRecruiter(existing: string | null, incoming: string): string | null {
  return existing ?? incoming ?? null;
}
