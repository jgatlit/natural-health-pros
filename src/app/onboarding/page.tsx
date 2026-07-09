import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { indexPractitioner } from '@/lib/practitioner-indexer';
import { isLlmConfigured } from '@/lib/onboarding-draft';
import { submitOnboarding } from '@/app/practitioners/[slug]/edit/actions';
import { OnboardingForm } from '@/components/practitioners/OnboardingForm';

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

const withSpecialties = { specialties: { include: { specialty: true } } } as const;

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

  // Idempotent: reuse the practitioner record if it already exists (pre-filled case),
  // else create a blank one to fill in.
  let practitioner = await prisma.practitioner.findUnique({
    where: { userId: session.user.id },
    include: withSpecialties,
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
      data: { userId: session.user.id, slug, displayName, acceptedAt: new Date() },
      include: withSpecialties,
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

  // Push the (possibly sparse) record into Typesense so search reflects them immediately.
  await indexPractitioner(practitioner.id).catch((err) =>
    console.error('Typesense index failed for new practitioner:', err),
  );

  const [cities, specialties, approvedAliases] = await Promise.all([
    prisma.city.findMany({ orderBy: [{ state: 'asc' }, { name: 'asc' }] }),
    prisma.specialty.findMany({
      where: { status: { in: ['ACTIVE', 'PROPOSED'] } },
      orderBy: { name: 'asc' },
    }),
    prisma.specialtyAlias.findMany({
      where: { status: 'APPROVED' },
      select: { label: true, specialtyId: true },
    }),
  ]);

  const initialSpecialties = practitioner.specialties.map((ps) => ({
    specialtyId: ps.specialtyId,
    rawLabel: ps.rawLabel?.trim() || ps.specialty.name,
  }));

  // Pre-filled = they already have narrative or specialties (revise → regenerate);
  // otherwise a blank first-time build.
  const isPrefilled = Boolean(
    practitioner.bio?.trim() || practitioner.headline?.trim() || practitioner.specialties.length > 0,
  );

  const action = submitOnboarding.bind(null, practitioner.slug);

  return (
    <OnboardingForm
      action={action}
      isPrefilled={isPrefilled}
      llmConfigured={isLlmConfigured()}
      values={{
        displayName: practitioner.displayName,
        describe: practitioner.bio ?? '',
        cityId: practitioner.cityId ?? '',
        yearsInPractice: practitioner.yearsInPractice,
        telehealth: practitioner.telehealth ?? false,
        inPerson: practitioner.inPerson ?? false,
      }}
      cities={cities}
      specialties={specialties.map((s) => ({ id: s.id, name: s.name }))}
      aliases={approvedAliases}
      initialSpecialties={initialSpecialties}
    />
  );
}
