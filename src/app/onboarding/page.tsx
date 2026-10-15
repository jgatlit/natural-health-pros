import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { indexPractitioner } from '@/lib/practitioner-indexer';
import { isLlmConfigured } from '@/lib/onboarding-draft';
import { SPECIALTY_ORDER } from '@/lib/practitioner-ordering';
import { submitOnboarding } from '@/app/practitioners/[slug]/edit/actions';
import { OnboardingForm } from '@/components/practitioners/OnboardingForm';
import { newRecruiterToken, recruitedFields, resolveRecruiterId, RECRUITER_DISCLOSURE } from '@/lib/recruiter';
import { RECRUITER_COOKIE, verifyRecruiterCookie } from '@/lib/recruiter-cookie';
import { cohortRedemptionOpen } from '@/lib/join-cohort';
import { planComparison } from '@/lib/pricing-plans';
import { getPlanAListSchedule, getScheduleForCopy, signupScheduleData } from '@/lib/rate-schedules';

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

// Ordered like every other read site. This one was missed when ordering shipped, and it is not
// cosmetic here: submitOnboarding rewrites sortOrder from the order this query returns, so an
// unordered read would let a revisit to /onboarding silently destroy an arrangement the
// practitioner had made on their dashboard — reintroducing exactly the non-determinism the
// ordering work removed.
const withSpecialties = {
  city: true,
  specialties: { include: { specialty: true }, orderBy: SPECIALTY_ORDER },
  user: { select: { termsAcceptedAt: true } },
} as const;

// docs/superpowers/specs/2026-07-16-pilot-trial-design.md — "Pilot" is a 90-day trial, not a
// permanent comp. Keep in sync with scripts/backfill-trial-dates.ts (mirrors this constant).
// Not exported: a Next page module may only export its own reserved names (`default`,
// `metadata`, `revalidate`, …), and any other export fails the build's route type-check.
// scripts/backfill-trial-dates.ts mirrors this value as a literal for the same reason.
const TRIAL_DAYS = 90;

/**
 * The 90-day clock does NOT run during the pilot. Operator ruling 2026-08-12: everyone stays in
 * pilot indefinitely until we deliberately flip on live production.
 *
 * This is a config flip, not a code change, precisely so going live doesn't need a PR. Until it
 * is set, onboarding leaves `trialEndsAt` null — which `isListed()` already treats as
 * listed/pre-trial, so this needs no new listing logic. `scripts/backfill-trial-dates.ts` is the
 * lever that starts everyone's clock together on go-live day.
 *
 * Why it matters that this was wrong: Jonathan told Sarah Schindler on the 2026-08-11 call that
 * "everybody's gonna be in pilot indefinitely, until we're actually, like, okay, the 90 days
 * starts now" — while this file was stamping her a November 9th expiry as she spoke. A tool that
 * describes a future state it doesn't implement is the exact failure he named in the same call.
 */
const trialClockEnabled = process.env.PILOT_TRIAL_CLOCK_ENABLED === 'true';

export default async function OnboardingPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/auth/signin?callbackUrl=/onboarding');
  }

  const token = searchParams.invitation;
  if (!token) {
    redirect('/');
  }

  const invitation = await prisma.invitation.findUnique({
    where: { token },
    include: { cohort: { select: { enabled: true } } },
  });
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

  if (!cohortRedemptionOpen(invitation, Boolean(practitioner))) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
        <div className="w-full max-w-sm space-y-2 rounded-xl border bg-card p-6 text-center sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight">Sign-up is closed</h1>
          <p className="text-sm text-muted-foreground">
            This sign-up link is not accepting new practitioners right now. Please check with your
            program lead.
          </p>
        </div>
      </main>
    );
  }

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

    // An HHE invitation grants a 90-day pilot — not a permanent comp. Reaching this line proves
    // the grant is earned: the invitation-required, validity and email-match gates above all
    // passed, so this user was vouched for by an admin. When the clock IS running it starts
    // HERE, at genuine onboarding, and only here — never inferred from a seed/import date (see
    // the design doc: the 12 pilots' acceptedAt is the 2026-05-29 import date, not a real
    // onboarding; anchoring the clock there would put them 48 days into a 90-day trial for a
    // product they've never opened). `comped` is deprecated in favor of this clock — omitted.
    //
    // During the pilot the clock does not run at all: null means pre-trial, still listed.
    let trialEndsAt: Date | null = null;
    if (trialClockEnabled) {
      trialEndsAt = new Date();
      trialEndsAt.setUTCDate(trialEndsAt.getUTCDate() + TRIAL_DAYS);
    }
    // Recruiter (spec §3): ONLY the signed first-wins cookie of the browser redeeming the link.
    // Never anything the invitation's requester supplied (a third party can request an invitation
    // for a victim's address with their own ?nhpa=). No cookie means no recruiter. Resolved against the
    // database now; unknown / self / archived recruiters are ignored. Written here, in the create,
    // and nowhere else — so it can never be changed later.
    const recruiterToken = await verifyRecruiterCookie(
      cookies().get(RECRUITER_COOKIE)?.value,
      process.env.AUTH_SECRET,
      Date.now(),
    );
    const recruiterId = await resolveRecruiterId(prisma, recruiterToken, session.user.id);

    // PRICED UNDER THE CURRENT RATE SCHEDULE FROM THE FIRST WRITE (spec v1.5 §2): the foreign key
    // and its SIGNUP history row go in the same create, so a practitioner never exists without a
    // schedule — a practitioner with none is refused at checkout.
    const schedule = await signupScheduleData(prisma);
    practitioner = await prisma.practitioner.create({
      data: {
        userId: session.user.id,
        slug,
        displayName,
        acceptedAt: new Date(),
        trialEndsAt,
        recruiterToken: newRecruiterToken(),
        ...recruitedFields(recruiterId, new Date()),
        ...schedule,
      },
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

  const [specialties, approvedAliases] = await Promise.all([
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
  // Words only: the plan cards quote the practitioner's own schedule, or the current one for a
  // practitioner who has none yet. Never used to price anything.
  const [copySchedule, listSchedule] = await Promise.all([
    getScheduleForCopy(prisma, practitioner.rateScheduleId),
    getPlanAListSchedule(prisma),
  ]);
  const comparison = planComparison(copySchedule, listSchedule);

  return (
    <OnboardingForm
      action={action}
      isPrefilled={isPrefilled}
      llmConfigured={isLlmConfigured()}
      values={{
        displayName: practitioner.displayName,
        describe: practitioner.bio ?? '',
        cityName: practitioner.city?.name ?? '',
        cityState: practitioner.city?.state ?? '',
        yearsInPractice: practitioner.yearsInPractice,
        telehealth: practitioner.telehealth ?? false,
        inPerson: practitioner.inPerson ?? false,
        openToOutsideWork: practitioner.openToOutsideWorkUpdatedAt
          ? practitioner.openToOutsideWork
          : null,
      }}
      specialties={specialties.map((s) => ({ id: s.id, name: s.name }))}
      aliases={approvedAliases}
      initialSpecialties={initialSpecialties}
      termsAcceptedAt={practitioner.user.termsAcceptedAt}
      recruiterDisclosure={practitioner.recruitedById ? RECRUITER_DISCLOSURE : null}
      planTerms={{ plans: comparison.cards, referral: comparison.referral }}
    />
  );
}
