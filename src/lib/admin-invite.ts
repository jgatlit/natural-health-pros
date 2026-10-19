import { signIn } from '@/auth';
import { prisma } from '@/lib/prisma';
import { newToken } from '@/lib/tokens';
import { normalizeEmail } from '@/lib/email';

/**
 * The admin-invitation core, shared by /admin/invites and the join-request approval.
 *
 * Deliberately NOT a `'use server'` module: every exported async function in such a file is a
 * publicly callable server action, and these take an arbitrary email and inviter id with no
 * admin check of their own. Callers check ADMIN first.
 */

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ONE-EMAIL INVITE. Instead of mailing a link to /auth/invite-accept (which then mailed a
 * SECOND sign-in link), we hand the whole job to `signIn`: Auth.js mints + stores the
 * verification token and dispatches it through our branded sender (`sendBrandedVerificationRequest`
 * in src/auth.ts), with `callbackUrl` carrying the invitation token — so one click both signs
 * the practitioner in AND lands them on /onboarding?invitation=<token>.
 *
 * Auth.js owns the token + its hashing, so an upgrade can't silently break invites.
 *
 * `redirect: false` is essential: signIn() would otherwise redirect the ADMIN to verify-request,
 * even though the mail is for someone else. Auth.js runs with `raw`, so a plain send failure does
 * NOT throw — it returns an `?error=` URL, which is what we detect here.
 */
export async function sendInviteMagicLink(email: string, invitationToken: string): Promise<boolean> {
  try {
    const res = await signIn('resend', {
      email,
      redirectTo: `/onboarding?invitation=${invitationToken}`,
      redirect: false,
    });
    return typeof res === 'string' ? !/[?&]error=/.test(res) : true;
  } catch (e) {
    // Auth.js DOES rethrow here for AuthError subclasses on the `raw` path (isAuthError &&
    // isRaw && !isRedirect). The notable case: send-token.js runs
    // `Promise.all([sendRequest, createToken])`, so if Resend succeeds while the adapter's
    // VerificationToken write fails, we land here having ALREADY delivered a real email whose
    // link is dead. Rolling the invitation back is still correct (the invite genuinely didn't
    // work) — but it must not vanish silently, or that's undiagnosable from the admin's
    // generic "send-failed" banner.
    console.error('[invite-send-failed]', { email }, e);
    return false;
  }
}

export type InviteOutcome = 'created' | 'reused' | 'invalid' | 'send-failed';

export type InviteResult = { outcome: InviteOutcome; invitationId: string | null };

/**
 * Core of a single invite: idempotency check, create, send, rollback-on-fail. Shared by
 * `createInvitation` (one email, redirects on the outcome), `createInvitationsBulk` (many
 * emails, aggregates the outcomes instead of redirecting per-row) and `approveJoinRequest`.
 * `invitationId` is set only when the invitation was delivered.
 */
export async function invite(rawEmail: string, invitedById: string): Promise<InviteResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { outcome: 'invalid', invitationId: null };

  // Idempotency: reuse pending unexpired invitation for this email if present.
  const existing = await prisma.invitation.findFirst({
    // cohortId: null — a pending cohort sign-up is hidden from this list, so reusing it would
    // silently skip creating the admin invite the admin thinks they just sent.
    where: { email, cohortId: null, acceptedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });

  const token = existing?.token ?? newToken();

  // Persist BEFORE sending — the inverse of the old order, and deliberately so: the emailed
  // link now lands on /onboarding?invitation=<token>, whose gate resolves that row, so it must
  // already exist when the recipient clicks. PR #21's invariant (a rejected send leaves no
  // orphaned row) is re-established by rolling back on failure instead of by ordering.
  //
  // Precisely: that holds for the Invitation table only. Auth.js's send-token.js runs
  // `Promise.all([sendRequest, createToken])`, writing its VerificationToken in PARALLEL with
  // the send — so a rejected send can still leave an undelivered token row we neither see nor
  // own. Not exploitable (its plaintext existed only in the email that never arrived) and it
  // expires on its own; it's the unavoidable cost of letting Auth.js own token minting rather
  // than forging tokens ourselves.
  let createdId: string | null = null;
  if (!existing) {
    const row = await prisma.invitation.create({
      data: {
        token,
        email,
        invitedById,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
    });
    createdId = row.id;
  }

  const sent = await sendInviteMagicLink(email, token);
  if (!sent) {
    if (createdId) {
      // Log before swallowing: send-failed AND rollback-failed is the ONLY path where the
      // no-orphaned-invitation guarantee actually breaks, so it must leave a trace — the
      // admin just sees a generic banner either way.
      await prisma.invitation
        .delete({ where: { id: createdId } })
        .catch((e) => console.error('[invite-rollback-failed] create', { email, createdId }, e));
    }
    return { outcome: 'send-failed', invitationId: null };
  }

  return existing
    ? { outcome: 'reused', invitationId: existing.id }
    : { outcome: 'created', invitationId: createdId };
}

export async function inviteOne(rawEmail: string, invitedById: string): Promise<InviteOutcome> {
  return (await invite(rawEmail, invitedById)).outcome;
}
