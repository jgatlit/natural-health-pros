import { randomBytes } from 'node:crypto';
import { RECRUITER_TOKEN_RE } from './recruiter-cookie';

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
