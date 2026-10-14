/**
 * Cohort sign-up core, kept free of Next/Auth imports so it is testable: given an email and a
 * cohort slug, mint (or reuse) the Invitation-equivalent the existing onboarding gate accepts.
 *
 * The invitation row is deliberately an ordinary `Invitation`: /onboarding's validity, expiry and
 * email-match checks apply to it unchanged. Anyone can request one, but it is only ever usable by
 * whoever controls the inbox (the magic link is mailed to the typed address).
 */

import { newToken } from './tokens';
import { RECRUITER_TOKEN_RE } from './recruiter-cookie';

export const COHORT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const COHORT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { invitation: { findFirst(a: any): Promise<any>; create(a: any): Promise<any> } };

export type CohortInvite = { id: string; token: string; created: boolean };

export async function ensureCohortInvitation(
  db: Db,
  input: { cohortId: string; email: string; recruiterToken?: string | null; now?: Date },
): Promise<CohortInvite> {
  const now = input.now ?? new Date();
  const existing = await db.invitation.findFirst({
    where: {
      email: input.email,
      cohortId: input.cohortId,
      acceptedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
  });
  // First-wins also holds on a re-request: the recruiter already on the row is never replaced.
  if (existing) return { id: existing.id, token: existing.token, created: false };

  const rt = input.recruiterToken && RECRUITER_TOKEN_RE.test(input.recruiterToken) ? input.recruiterToken : null;
  const row = await db.invitation.create({
    data: {
      token: newToken(),
      email: input.email,
      cohortId: input.cohortId,
      recruiterToken: rt,
      expiresAt: new Date(now.getTime() + COHORT_INVITE_TTL_MS),
    },
  });
  return { id: row.id, token: row.token, created: true };
}
