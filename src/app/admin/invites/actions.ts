'use server';

import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { auth, signIn } from '@/auth';
import { prisma } from '@/lib/prisma';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function newToken(): string {
  return randomBytes(24).toString('base64url');
}

// (baseUrl() removed: Auth.js now builds the magic-link URL itself via signIn(), so this
// action no longer constructs any absolute URLs.)

async function requireAdmin() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/invites');
  }
  return session;
}

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
async function sendInviteMagicLink(email: string, invitationToken: string): Promise<boolean> {
  try {
    const res = await signIn('resend', {
      email,
      redirectTo: `/onboarding?invitation=${invitationToken}`,
      redirect: false,
    });
    return typeof res === 'string' ? !/[?&]error=/.test(res) : true;
  } catch {
    return false;
  }
}

export async function createInvitation(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    redirect('/admin/invites?error=invalid-email');
  }

  // Idempotency: reuse pending unexpired invitation for this email if present.
  const existing = await prisma.invitation.findFirst({
    where: { email, acceptedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });

  const token = existing?.token ?? newToken();

  // Persist BEFORE sending — the inverse of the old order, and deliberately so: the emailed
  // link now lands on /onboarding?invitation=<token>, whose gate resolves that row, so it must
  // already exist when the recipient clicks. PR #21's invariant (a rejected send must leave no
  // orphaned invitation) is preserved by rolling the row back on failure instead.
  let createdId: string | null = null;
  if (!existing) {
    const row = await prisma.invitation.create({
      data: {
        token,
        email,
        invitedById: session.user.id,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
    });
    createdId = row.id;
  }

  const sent = await sendInviteMagicLink(email, token);
  if (!sent) {
    if (createdId) await prisma.invitation.delete({ where: { id: createdId } }).catch(() => {});
    redirect('/admin/invites?error=send-failed');
  }

  revalidatePath('/admin/invites');
}

export async function revokeInvitation(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) return;
  await prisma.invitation.update({
    where: { id },
    data: { expiresAt: new Date(0) },
  });
  revalidatePath('/admin/invites');
}

export async function resendInvitation(formData: FormData): Promise<void> {
  // Guard still runs — only the (now-unused) session binding is dropped: the branded sender
  // composes the email, so this action no longer needs invitedByName.
  await requireAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) return;

  const invitation = await prisma.invitation.findUnique({ where: { id } });
  if (!invitation) redirect('/admin/invites?error=not-found');
  if (invitation.acceptedAt) redirect('/admin/invites?error=already-accepted');

  // Expired or revoked (expiresAt in the past) → reactivate with a FRESH token so
  // any previously-shared/revoked dead link stays dead. A still-valid pending invite
  // keeps its token so the link already emailed to the practitioner keeps working.
  const inactive = invitation.expiresAt <= new Date();
  const token = inactive ? newToken() : invitation.token;

  // Persist BEFORE sending (see createInvitation): the emailed magic link resolves this row,
  // so the reactivation must be committed before the recipient can click. On send failure we
  // restore the exact prior state, keeping the old guarantee that the stored row never
  // diverges from what was actually delivered.
  const prevToken = invitation.token;
  const prevExpires = invitation.expiresAt;
  await prisma.invitation.update({
    where: { id },
    data: {
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      ...(inactive ? { token } : {}),
    },
  });

  const sent = await sendInviteMagicLink(invitation.email, token);
  if (!sent) {
    await prisma.invitation
      .update({ where: { id }, data: { token: prevToken, expiresAt: prevExpires } })
      .catch(() => {});
    redirect('/admin/invites?error=send-failed');
  }

  revalidatePath('/admin/invites');
}
