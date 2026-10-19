'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { invite } from '@/lib/admin-invite';
import { sendDeclineEmail } from '@/lib/join-request';

const BASE = '/admin/requests';

async function requireAdmin() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect(`/auth/signin?callbackUrl=${BASE}`);
  }
  return session;
}

async function hasPractitioner(email: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { practitioner: { select: { id: true } } },
  });
  return Boolean(user?.practitioner);
}

/**
 * Approve = an ordinary admin invitation through the shared invite core. The row is claimed
 * (PENDING -> APPROVED) BEFORE the send, so a double-click or a second admin finds nothing
 * PENDING and sends nothing; a failed send puts it back to PENDING.
 */
export async function approveJoinRequest(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) return;

  const request = await prisma.joinRequest.findUnique({
    where: { id },
    select: { email: true, status: true },
  });
  if (!request) redirect(`${BASE}?error=not-found`);
  if (request.status !== 'PENDING') redirect(`${BASE}?error=not-pending`);
  // A second invitation would lead to a second practitioner path for the same person.
  if (await hasPractitioner(request.email)) redirect(`${BASE}?error=has-profile`);

  const claim = await prisma.joinRequest.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'APPROVED', reviewedAt: new Date(), reviewedById: session.user.id },
  });
  if (claim.count === 0) redirect(`${BASE}?error=not-pending`);

  const result = await invite(request.email, session.user.id);
  if (!result.invitationId) {
    await prisma.joinRequest
      .updateMany({
        where: { id, status: 'APPROVED', invitationId: null },
        data: { status: 'PENDING', reviewedAt: null, reviewedById: null },
      })
      .catch((e) => console.error('[join-request-unclaim-failed]', { id }, e));
    revalidatePath(BASE);
    redirect(`${BASE}?error=${result.outcome === 'invalid' ? 'invalid-email' : 'send-failed'}`);
  }

  await prisma.joinRequest
    .update({ where: { id }, data: { invitationId: result.invitationId } })
    .catch((e) =>
      console.error('[join-request-link-failed] invitation sent but not recorded', {
        id,
        invitationId: result.invitationId,
      }, e),
    );

  revalidatePath(BASE);
  revalidatePath('/admin/invites');
  redirect(`${BASE}?done=approved`);
}

export async function declineJoinRequest(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) return;
  const notify = formData.get('notify') === 'on';

  const request = await prisma.joinRequest.findUnique({
    where: { id },
    select: { email: true, name: true },
  });
  if (!request) redirect(`${BASE}?error=not-found`);

  const res = await prisma.joinRequest.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'DECLINED', reviewedAt: new Date(), reviewedById: session.user.id },
  });
  if (res.count === 0) redirect(`${BASE}?error=not-pending`);

  revalidatePath(BASE);
  if (notify && !(await sendDeclineEmail(id, request.email, request.name))) {
    redirect(`${BASE}?error=decline-email-failed`);
  }
  redirect(`${BASE}?done=declined`);
}
