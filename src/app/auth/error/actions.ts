'use server';

import { redirect } from 'next/navigation';
import { signIn } from '@/auth';
import { prisma } from '@/lib/prisma';
import { rateLimit } from '@/lib/rate-limit';
import { invitationCallbackPath, invitationTokenOf } from '@/lib/sign-in-recovery';

/**
 * "Send me a new link" from a failed invitation sign-in. The recipient is always the invitation's
 * own address, read from the database, never a value from the form, so this cannot mail anyone
 * the invitation was not already addressed to.
 */
export async function resendInvitationLink(formData: FormData): Promise<void> {
  const callback = invitationCallbackPath(String(formData.get('callbackUrl') ?? ''));
  if (!callback) redirect('/auth/signin');
  const back = `/auth/error?error=Verification&callbackUrl=${encodeURIComponent(callback)}`;

  const invitation = await prisma.invitation.findUnique({
    where: { token: invitationTokenOf(callback) },
    select: { email: true, expiresAt: true },
  });
  if (!invitation || invitation.expiresAt <= new Date()) redirect(back);

  const limit = await rateLimit('resend-invite', invitationTokenOf(callback), {
    limit: 5,
    windowSeconds: 3600,
  });
  if (!limit.success) redirect(`${back}&resend=throttled`);

  await signIn('resend', { email: invitation.email, redirectTo: callback });
}
