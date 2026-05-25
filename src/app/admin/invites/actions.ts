'use server';

import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { sendInvitationEmail } from '@/lib/email';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function newToken(): string {
  return randomBytes(24).toString('base64url');
}

function baseUrl(): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

async function requireAdmin() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/invites');
  }
  return session;
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

  const invitation =
    existing ??
    (await prisma.invitation.create({
      data: {
        token: newToken(),
        email,
        invitedById: session.user!.id ?? null,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
    }));

  await sendInvitationEmail({
    to: email,
    acceptUrl: `${baseUrl()}/auth/invite-accept/${invitation.token}`,
    invitedByName: session.user!.name ?? undefined,
  });

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
