'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { normalizeEmail } from '@/lib/email';
import { checkBotGuard, clientIp, type RateRule } from '@/lib/bot-guard';
import { notifyAdminsOfJoinRequest, parseJoinRequest } from '@/lib/join-request';

const RATE_LIMITS: RateRule[] = [
  { prefix: 'join-request-ip', by: 'ip', limit: 5, windowSeconds: 60 * 60 },
  { prefix: 'join-request-ip-1d', by: 'ip', limit: 20, windowSeconds: 24 * 60 * 60 },
  { prefix: 'join-request-email', by: 'email', limit: 3, windowSeconds: 24 * 60 * 60 },
];

const SENT = '/join?sent=1';

/**
 * Public, unauthenticated. Stores a JoinRequest for an admin to review and creates nothing else:
 * no User, no Practitioner, no Invitation, no sign-in email. The reply is the same whether the
 * address is new, already has a pending request, or already belongs to a practitioner.
 */
export async function requestToJoin(formData: FormData): Promise<void> {
  const email = normalizeEmail(String(formData.get('email') ?? ''));

  const guard = await checkBotGuard({
    form: 'join-request',
    formData,
    email,
    ip: clientIp(headers()),
    rateLimits: RATE_LIMITS,
  });
  if (!guard.ok) {
    if (guard.outcome === 'pretend-success') redirect(SENT);
    redirect(`/join?error=${guard.outcome}`);
  }

  const input = parseJoinRequest(formData);
  if (!input) redirect('/join?error=invalid');

  const pending = await prisma.joinRequest.findFirst({
    where: { email: input.email, status: 'PENDING' },
    select: { id: true },
  });
  if (pending) redirect(SENT);

  const created = await prisma.joinRequest.create({ data: input, select: { id: true } });
  await notifyAdminsOfJoinRequest({ ...input, id: created.id });

  redirect(SENT);
}
