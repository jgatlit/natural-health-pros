import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { indexPractitioner } from '@/lib/practitioner-indexer';

type Props = { searchParams: { invitation?: string } };

export const dynamic = 'force-dynamic';

async function generateUniqueSlug(email: string): Promise<string> {
  const base =
    email
      .split('@')[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'practitioner';
  let slug = base;
  let suffix = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const exists = await prisma.practitioner.findUnique({ where: { slug } });
    if (!exists) return slug;
    suffix++;
    slug = `${base}-${suffix}`;
  }
}

export default async function OnboardingPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/auth/signin?callbackUrl=/onboarding');
  }

  const token = searchParams.invitation;
  if (!token) {
    redirect('/');
  }

  const invitation = await prisma.invitation.findUnique({ where: { token } });
  if (
    !invitation ||
    invitation.expiresAt < new Date() ||
    (invitation.acceptedAt && invitation.acceptedByUserId !== session.user.id)
  ) {
    redirect('/auth/error?error=Verification');
  }

  // Confirm the signed-in email matches the invitation.
  if (session.user.email?.toLowerCase() !== invitation.email.toLowerCase()) {
    redirect('/auth/error?error=AccessDenied');
  }

  // Idempotent: if the user already has a practitioner record, treat the invitation as fully
  // accepted and route them to edit.
  let practitioner = await prisma.practitioner.findUnique({
    where: { userId: session.user.id },
  });

  if (!practitioner) {
    const slug = await generateUniqueSlug(invitation.email);
    const displayName =
      session.user.name?.trim() ||
      invitation.email
        .split('@')[0]
        .split(/[^a-z]+/i)
        .filter(Boolean)
        .map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase())
        .join(' ') ||
      'New Practitioner';

    practitioner = await prisma.practitioner.create({
      data: {
        userId: session.user.id,
        slug,
        displayName,
        acceptedAt: new Date(),
      },
    });

    await prisma.user.update({
      where: { id: session.user.id },
      data: { role: 'PRACTITIONER' },
    });
  }

  // Mark invitation accepted (idempotent on already-accepted).
  await prisma.invitation.update({
    where: { id: invitation.id },
    data: {
      acceptedAt: invitation.acceptedAt ?? new Date(),
      acceptedByUserId: session.user.id,
    },
  });

  // Push initial sparse record into Typesense so search reflects them immediately.
  await indexPractitioner(practitioner.id).catch((err) =>
    console.error('Typesense index failed for new practitioner:', err),
  );

  redirect(`/practitioners/${practitioner.slug}/edit?welcome=1`);
}
