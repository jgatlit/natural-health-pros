import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { indexPractitioner } from '@/lib/practitioner-indexer';
import { isLlmConfigured } from '@/lib/onboarding-draft';
import { SPECIALTY_ORDER } from '@/lib/practitioner-ordering';
import { submitOnboarding } from '@/app/practitioners/[slug]/edit/actions';
import { OnboardingForm } from '@/components/practitioners/OnboardingForm';
import { newRecruiterToken, recruitedFields, resolveRecruiterId, recruiterDisclosure } from '@/lib/recruiter';
import { loadDisplaySettings } from '@/lib/platform-settings';
import { RECRUITER_COOKIE, verifyRecruiterCookie } from '@/lib/recruiter-cookie';
import { cohortRedemptionOpen } from '@/lib/join-cohort';
import { planComparison } from '@/lib/pricing-plans';
import { getPlanAListSchedule, getScheduleForCopy, signupScheduleData } from '@/lib/rate-schedules';
import { emailDerivedName, isNeverDrafted, slugBase, uniqueSlug } from '@/lib/practitioner-slug';
import { SignUpLinkNeeded } from '@/components/practitioners/SignUpLinkNeeded';

type Props = { searchParams: { invitation?: string } };

export const dynamic = 'force-dynamic';

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
  const token = searchParams.invitation;
  if (!session?.user?.id) {
    // Keep the invitation through sign-in. Dropping it sent people back here token-less and on to
    // the homepage, with no message.
    const callback = token ? `/onboarding?invitation=${encodeURIComponent(token)}` : '/onboarding';
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(callback)}`);
  }

  // No usable invitation: send an existing practitioner to their profile, and anyone else to the
  // page that explains the sign-up link. Never to the homepage.
  const userId = session.user.id;
  const ownProfile = () =>
    prisma.practitioner.findUnique({ where: { userId }, select: { slug: true } });

  if (!token) {
    const own = await ownProfile();
    if (own) redirect(`/practitioners/${own.slug}/edit`);
    return <SignUpLinkNeeded />;
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
    const own = await ownProfile();
    if (own) redirect(`/practitioners/${own.slug}/edit`);
    return <SignUpLinkNeeded expired />;
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
    // A placeholder until the first submit, which regenerates it from the name the practitioner
    // types (submitOnboarding). The name itself starts blank: the form asks for it.
    const slug = await uniqueSlug(prisma, slugBase(invitation.email.split('@')[0] ?? ''));
    const displayName = '';

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
        // Operator ruling 2026-10-15: a sign-up (cohort link, /join approval, any invitation) is
        // not HHE-verified, so it never starts with the badge. An admin grants it by hand.
        hheCertified: false,
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
  const [copySchedule, listSchedule, display] = await Promise.all([
    getScheduleForCopy(prisma, practitioner.rateScheduleId),
    getPlanAListSchedule(prisma),
    loadDisplaySettings(prisma),
  ]);
  const comparison = planComparison(copySchedule, listSchedule);

  return (
    <OnboardingForm
      action={action}
      isPrefilled={isPrefilled}
      llmConfigured={isLlmConfigured()}
      values={{
        // Rows created before this change hold a name derived from the email ("Kbbunny"). Until
        // the first submit, ask for a real one instead of prefilling that.
        displayName:
          isNeverDrafted(practitioner) &&
          practitioner.displayName === emailDerivedName(invitation.email)
            ? ''
            : practitioner.displayName,
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
      recruiterDisclosure={
        practitioner.recruitedById
          ? recruiterDisclosure(display.showCommissionTerms ? copySchedule.affiliateBps : null)
          : null
      }
      planTerms={{ plans: comparison.cards, referral: comparison.referral, display }}
    />
  );
}
