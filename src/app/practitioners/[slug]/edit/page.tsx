import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Check, AlertCircle, X, Sparkles } from 'lucide-react';
import { auth } from '@/auth';
import { QUALIFICATIONS_HEADING } from '@/lib/profile-sections';
import { prisma } from '@/lib/prisma';
import { monthlyFeeLabel } from '@/lib/pricing-plans';
import { isWhopPlatformsReady } from '@/lib/whop';
import { profileCompletenessSignals } from '@/lib/practitioner-indexer';
import { OFFERING_ORDER, SPECIALTY_ORDER } from '@/lib/practitioner-ordering';
import { isLlmConfigured } from '@/lib/onboarding-draft';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { CityField } from '@/components/practitioners/CityField';
import { UnsavedChangesBar } from '@/components/practitioners/UnsavedChangesBar';
import {
  updatePractitioner,
  generateDraftAction,
  removeCaseStudy,
  createOffering,
  updateOffering,
  deleteOffering,
  publishOffering,
  unpublishOffering,
  reorderOfferings as reorderOffering,
  startWhopOnboarding,
  openPayoutPortal,
  startSubscriptionCheckout,
  requestAccountEmailChange,
} from './actions';
import { OfferingsEditor } from '@/components/practitioners/OfferingsEditor';
import { resolveHeroLink, offeringsForLink, ctaLabelFor } from '@/lib/profile-ctas';
import { SubscriptionSection } from '@/components/practitioners/SubscriptionSection';
import { PaymentsSection } from '@/components/practitioners/PaymentsSection';
import { AccountEmailSection } from '@/components/practitioners/AccountEmailSection';
import { BookingsSection, type BookingRow } from '@/components/practitioners/BookingsSection';
import { paymentsLive } from '@/lib/booking-flow';
import { BookingLinksField } from '@/components/practitioners/BookingLinksField';
import { SpecialtyComboboxField } from '@/components/practitioners/SpecialtyComboboxField';
import { PhotoUploadField } from '@/components/practitioners/PhotoUploadField';
import { PhotoFramingField } from '@/components/practitioners/PhotoFramingField';
import { AiDraftPanel } from '@/components/practitioners/AiDraftPanel';

type Props = {
  params: { slug: string };
  searchParams: {
    welcome?: string;
    saved?: string;
    error?: string;
    drafted?: string;
    source?: string;
    whop?: string;
    /** Echoed-back concurrency token — see the hidden `profileUpdatedAt` field below. */
    v?: string;
  };
};

export const dynamic = 'force-dynamic';

// Named once, referenced everywhere it's needed: the profile form's id and BookingLinksField's
// `formId` prop (which each of its inputs uses as `form={formId}` to submit with this form despite
// rendering outside its DOM subtree — see BookingLinksField's own doc comment) must be the exact
// same string, or those fields silently drop out of the submission with no error. Two independent
// string literals kept in sync "by convention" is exactly how that drift happens; one constant
// makes it impossible.
const PROFILE_FORM_ID = 'profile-form';

export default async function EditPractitionerPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/auth/signin?callbackUrl=/practitioners/${params.slug}/edit`);
  }

  const practitioner = await prisma.practitioner.findUnique({
    where: { slug: params.slug },
    include: {
      city: true,
      specialties: { include: { specialty: true }, orderBy: SPECIALTY_ORDER },
      // Must match the public profile exactly — these two diverging (desc here, asc there) is
      // what made a practitioner's arranged order appear reversed on her live page.
      whopProducts: { where: { archived: false }, orderBy: OFFERING_ORDER },
      bookingLinks: { orderBy: { sortOrder: 'asc' } },
      caseStudies: { orderBy: { createdAt: 'desc' } },
      // The PROFILE OWNER's role — the subject of the billing exemption, and not the same
      // person as the viewer. Read from the DB, never from the session: isListed() gates on
      // this exact value server-side, and session.user.role is the VIEWER's own role, which
      // differs from the owner's whenever an admin is editing someone else's profile.
      user: {
        select: {
          role: true,
          email: true,
          emailChangeRequests: {
            where: { expiresAt: { gt: new Date() } },
            select: { newEmail: true },
            take: 1,
          },
        },
      },
    },
  });
  if (!practitioner) notFound();

  const completeness = profileCompletenessSignals(practitioner);
  type MissingField = { key: keyof typeof completeness; label: string };
  const allFields: MissingField[] = [
    { key: 'hasDisplayName', label: 'Display name' },
    { key: 'hasCity', label: 'City' },
    { key: 'hasBio', label: 'Bio (20+ characters)' },
    { key: 'hasSpecialty', label: 'At least one specialty' },
  ];
  const missing = allFields.filter((f) => !completeness[f.key]);

  const isOwner = practitioner.userId === session.user.id;
  // Two different people, deliberately kept apart: isViewerAdmin is who is LOOKING (access
  // control + the "Signed in as" footer), ownerIsAdmin is whose PROFILE this is (the billing
  // exemption). An admin may open any practitioner's dashboard, so conflating them told Amy
  // that every pilot she inspected was "exempt from the listing subscription".
  const isViewerAdmin = session.user.role === 'ADMIN';
  const ownerIsAdmin = practitioner.user.role === 'ADMIN';
  if (!isOwner && !isViewerAdmin) {
    redirect('/auth/error?error=AccessDenied');
  }

  const [specialties, approvedAliases, intents] = await Promise.all([
    prisma.specialty.findMany({
      where: { status: { in: ['ACTIVE', 'PROPOSED'] } },
      orderBy: { name: 'asc' },
    }),
    prisma.specialtyAlias.findMany({
      where: { status: 'APPROVED' },
      select: { label: true, specialtyId: true },
    }),
    // §10 — the scheduled-but-unpaid obligation, PLUS paid bookings.
    //
    // Paid ones were previously excluded as "not a work queue item". That made the row simply
    // VANISH the moment payment landed — no notification, no completed state — so from the
    // practitioner's side a collected booking and a deleted one looked identical, and the only
    // way to tell was to go and read Whop. Showing them is what makes the outstanding list
    // trustworthy: a row leaving it now means something visible happened.
    prisma.bookingIntent.findMany({
      where: { practitionerId: practitioner.id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        note: true,
        status: true,
        scheduleSignal: true,
        scheduledAt: true,
        createdAt: true,
        paidAt: true,
        offering: {
          select: {
            title: true,
            priceUsdCents: true,
            acceptsPayments: true,
            whopPlanId: true,
            // Without this the dashboard calls an archived offering payable while the flow page
            // refuses to render its checkout — a permanent, unpayable dun.
            archived: true,
          },
        },
      },
      // `nulls: 'last'` is load-bearing. Postgres sorts NULL as LARGER, so a bare
      // `scheduledAt DESC` puts every PENDING lead (scheduledAt null) ABOVE every scheduled
      // booking — and with a take cap, a practitioner with 50+ leads would see the
      // scheduled-but-unpaid rows disappear entirely. That is the exact failure this section was
      // built to fix, so the ordering has to put them first.
      // Unpaid first regardless of age — those are the ones needing action. `nulls: 'last'` on
      // BOTH: Postgres sorts NULL as LARGER, so a bare DESC would float every unpaid row (paidAt
      // null) above the paid ones on the first key and every lead above every booking on the
      // second — burying the rows this section exists to surface behind a take cap.
      orderBy: [
        { paidAt: { sort: 'asc', nulls: 'first' } },
        { scheduledAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      take: 50,
    }),
  ]);

  const bookingRows: BookingRow[] = intents.map((i) => ({
    id: i.id,
    name: i.name,
    email: i.email,
    phone: i.phone,
    note: i.note,
    status: i.status,
    scheduleSignal: i.scheduleSignal,
    scheduledAt: i.scheduledAt,
    createdAt: i.createdAt,
    paidAt: i.paidAt,
    offeringTitle: i.offering?.title ?? null,
    offeringPriceUsdCents: i.offering?.priceUsdCents ?? null,
    // Resolved HERE via the shared helper rather than in the component, so the dashboard's idea
    // of "was there a payment to make?" cannot drift from the flow page's or the sweep's.
    //
    // The `archived` test is part of that agreement, not an extra: resumeDecision() refuses an
    // archived offering and the flow page nulls it, so omitting it here left the dashboard duns
    // for money the buyer has no way to pay, under a hint reading "a nudge usually does it".
    paymentsLive:
      i.offering && !i.offering.archived
        ? paymentsLive({
            acceptsPayments: i.offering.acceptsPayments,
            practitionerPayoutsEnabled: practitioner.whopPayoutsEnabled,
            whopPlanId: i.offering.whopPlanId,
          })
        : false,
  }));

  // Dual-label: seed the combobox with each selected specialty's raw phrasing (their voice),
  // falling back to the canonical name when no rawLabel was captured.
  const initialSpecialties = practitioner.specialties.map((ps) => ({
    specialtyId: ps.specialtyId,
    rawLabel: ps.rawLabel?.trim() || ps.specialty.name,
  }));

  // Bind the slug for the form actions
  const action = updatePractitioner.bind(null, params.slug);
  const draftAction = generateDraftAction.bind(null, params.slug);
  const createOfferingAction = createOffering.bind(null, params.slug);
  const updateOfferingAction = updateOffering.bind(null, params.slug);
  const deleteOfferingAction = deleteOffering.bind(null, params.slug);
  const publishOfferingAction = publishOffering.bind(null, params.slug);
  const unpublishOfferingAction = unpublishOffering.bind(null, params.slug);
  const reorderOfferingsAction = reorderOffering.bind(null, params.slug);

  // WHICH LINK BECOMES THE BIG ROSE BUTTON — computed with resolveHeroLink(), the SAME function
  // the public profile uses, so the edit page cannot drift from what it is predicting. Telling a
  // practitioner the wrong one is worse than telling them nothing.
  const ctaLinks = practitioner.bookingLinks.map((b) => ({
    id: b.id,
    label: b.label,
    url: b.url,
    ctaLabel: b.ctaLabel,
  }));
  const ctaOfferingsForHint = practitioner.whopProducts.map((o) => ({
    id: o.id,
    title: o.title,
    priceUsdCents: o.priceUsdCents,
    duration: o.duration,
    isConsult: o.isConsult,
    bookingLinkId: o.bookingLinkId,
    listingVisibility: o.listingVisibility,
  }));
  const heroLink = resolveHeroLink(ctaLinks, practitioner.primaryBookingLinkId ?? null);
  const heroLabel = heroLink
    ? ctaLabelFor(heroLink, offeringsForLink(ctaOfferingsForHint, heroLink.id))
    : null;

  // §22: which Offering(s) each Booking Link actually carries — the visibility gap that let Amy
  // Sprouse's own "3 Month Health Transformation" offering sit attached to her "1 Month of
  // Support" link, unnoticed, while the identically-named link sat empty. Same offeringsForLink
  // helper the public page/chooser use, so this can't drift from what actually renders.
  const offeringsByLinkId: Record<string, { title: string; priceUsdCents: number }[]> =
    Object.fromEntries(
      ctaLinks.map((l) => [
        l.id,
        offeringsForLink(ctaOfferingsForHint, l.id).map((o) => ({
          title: o.title,
          priceUsdCents: o.priceUsdCents,
        })),
      ]),
    );
  const startWhopOnboardingAction = startWhopOnboarding.bind(null, params.slug);
  const openPayoutPortalAction = openPayoutPortal.bind(null, params.slug);
  const startSubscriptionCheckoutAction = startSubscriptionCheckout.bind(null, params.slug);
  const requestAccountEmailChangeAction = requestAccountEmailChange.bind(null, params.slug);

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:py-14">
      <div className="mx-auto max-w-2xl space-y-4">
        <Link
          href={`/practitioners/${params.slug}`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to profile
        </Link>

        {searchParams.welcome && (
          <Card className="border-primary/30 bg-primary/5 p-4">
            <p className="text-sm">
              <strong>Welcome to Natural Health Pros.</strong> Fill in your profile below to make it
              public — or let AI draft a first pass from a short description.
            </p>
          </Card>
        )}

        {searchParams.drafted && (
          <Card className="border-primary/40 bg-primary/5 p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15">
                <Sparkles className="h-4 w-4 text-primary" aria-hidden />
              </span>
              <div className="space-y-0.5">
                <p className="text-sm font-semibold">
                  {searchParams.source === 'llm'
                    ? 'AI-drafted your profile.'
                    : 'Drafted a starting template.'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Review and edit each field below, then Save to publish. Nothing is public until
                  you save a complete profile.
                </p>
              </div>
            </div>
          </Card>
        )}

        <AiDraftPanel action={draftAction} llmConfigured={isLlmConfigured()} />

        {missing.length > 0 && (
          <Card className="border-amber-500/30 bg-amber-500/5 p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500/15">
                <AlertCircle className="h-4 w-4 text-amber-700 dark:text-amber-400" aria-hidden />
              </span>
              <div className="flex-1 space-y-2">
                <div>
                  <p className="text-sm font-semibold">Profile in progress</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Your profile is hidden from search + the landing page until these fields are
                    filled. Direct profile links still work.
                  </p>
                </div>
                <ul className="space-y-0.5 text-xs">
                  {missing.map((f) => (
                    <li key={f.key} className="flex items-center gap-1.5">
                      <X className="h-3 w-3 shrink-0 text-destructive" aria-hidden />
                      <span>{f.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Card>
        )}

        {missing.length === 0 && (
          <Card className="border-green-500/30 bg-green-500/5 p-3">
            <p className="flex items-center gap-1.5 text-xs">
              <Check className="h-3.5 w-3.5 text-green-600" />
              Profile complete — visible on /search and the landing page.
            </p>
          </Card>
        )}

        {searchParams.saved && searchParams.saved !== 'email-pending' && (
          <Card className="border-green-500/30 bg-green-500/5 p-3">
            <p className="flex items-center gap-1.5 text-xs">
              <Check className="h-3.5 w-3.5 text-green-600" />
              Profile saved.{' '}
              <Link
                href={`/practitioners/${params.slug}`}
                className="font-medium underline underline-offset-2"
              >
                View public page
              </Link>
            </p>
          </Card>
        )}

        {searchParams.error === 'name-required' && (
          <Card className="border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">Display name is required.</p>
          </Card>
        )}
        {searchParams.error === 'terms-required' && (
          <Card className="border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">
              You need to accept the Terms &amp; Conditions to continue. Go back and check the box
              at the bottom of the form.
            </p>
          </Card>
        )}
        {searchParams.error === 'invalid-booking-url' && (
          <Card className="border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">
              Booking URL doesn&apos;t look like a valid scheduling link. Use a full URL like
              <code className="mx-1 rounded bg-background px-1 py-0.5 text-foreground">
                https://cal.com/your-username
              </code>
              or a Calendly / SavvyCal / Acuity link.
            </p>
          </Card>
        )}
        {searchParams.error === 'profile-changed-elsewhere' && (
          <Card className="border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">
              This profile changed somewhere else while you had it open, so nothing was saved —
              saving would have quietly discarded that change. Your edits are still here; reload
              the page to pick up the newer version, then reapply them.
            </p>
            {/* Deliberately not "someone else saved this". A background update can move the row
                without any person editing it — a Whop payout webhook, a subscription change, an
                admin resetting a trial — because `@updatedAt` fires on every column. Naming a
                culprit that may not exist would be a worse lie than being vague. */}
            <p className="mt-1 text-[11px] text-muted-foreground">
              Saving again without reloading will keep being refused, on purpose.
            </p>
          </Card>
        )}
        {searchParams.error === 'too-many-booking-links' && (
          <Card className="border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">
              That is more booking links than we can save at once. Remove a few and try again.
            </p>
          </Card>
        )}
        {searchParams.error === 'payouts-not-ready' && (
          <Card className="border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">
              Set up payouts before publishing an offering — see &ldquo;Client payments&rdquo;
              below.
            </p>
          </Card>
        )}
        {searchParams.error === 'offering-not-ready' && (
          <Card className="border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">
              That offering needs a price above $0 before it can be published.
            </p>
          </Card>
        )}
        {searchParams.error === 'offering-not-found' && (
          <Card className="border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">
              That offering couldn&apos;t be found — it may have already been removed.
            </p>
          </Card>
        )}
        {searchParams.error === 'offering-no-plan' && (
          <Card className="border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">
              Whop set that offering up but didn&apos;t return a payment plan for it, so checkout
              can&apos;t be shown to clients yet. Try publishing again — nothing was charged and
              nothing was lost.
            </p>
          </Card>
        )}

        {searchParams.error === 'offering-title-too-long' && (
          <Card className="border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">
              That offering&apos;s title is too long to publish — shorten it to 80 characters or
              fewer and try again.
            </p>
          </Card>
        )}

        <Card className="p-6 sm:p-8">
          <form id={PROFILE_FORM_ID} action={action} className="space-y-5">
            {/* Optimistic-concurrency token. Compared server-side before any write, so a save from
                a stale tab (or from an admin editing this profile in support) is refused instead of
                silently discarding the other editor's rows.

                On a refused save the action echoes the token back as `?v=`, and we re-render THAT
                rather than the current server value. The refusal is a soft navigation, so this
                form stays mounted with the practitioner's typed text intact — but React would
                refresh a server-valued token in place, and the next click on Save would then match
                and write the stale data the guard just blocked. Echoing keeps it armed until a
                real reload. */}
            <input
              type="hidden"
              name="profileUpdatedAt"
              value={searchParams.v ?? practitioner.updatedAt.toISOString()}
            />
            <div className="space-y-1.5">
              <h1 className="text-xl font-semibold tracking-tight">Edit profile</h1>
              <p className="text-xs text-muted-foreground">
                Your slug: <code className="rounded bg-muted px-1.5 py-0.5">/{params.slug}</code>
              </p>
            </div>

            <Separator />

            <Field
              label="Profile photo"
              hint="Shown on your profile hero and search card. Falls back to your initials when empty."
            >
              <PhotoUploadField slug={params.slug} initial={practitioner.photoUrl} />
              {/* Framing sits directly under the uploader because the two are one task in a
                  practitioner's head: "make my photo look right". Separating them is what forced
                  a re-upload to fix a bad crop. */}
              <PhotoFramingField
                photoUrl={practitioner.photoUrl}
                initial={{
                  photoFocalX: practitioner.photoFocalX,
                  photoFocalY: practitioner.photoFocalY,
                  photoZoom: practitioner.photoZoom,
                }}
              />
            </Field>

            <Field label="Display name" required>
              <input
                type="text"
                name="displayName"
                required
                defaultValue={practitioner.displayName}
                className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
              />
            </Field>

            <Field
              label="Headline / credentials"
              hint="Your professional title line under your name (e.g. 'Functional Nutritionist, FDN-P · 10+ yrs')."
            >
              <input
                type="text"
                name="headline"
                defaultValue={practitioner.headline ?? ''}
                className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
              />
            </Field>

            <Field
              label="Tagline"
              hint="One short hook shown above “Who you help” on your public page (e.g. 'Root-cause work for women navigating perimenopause'). Optional — leave blank and it simply won't show. When generated, it only ever compresses your own words."
            >
              <input
                type="text"
                name="tagline"
                maxLength={70}
                defaultValue={practitioner.tagline ?? ''}
                className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
              />
            </Field>

            <Field
              label="Bio"
              hint="Short, plain-English description. What you do, who you work with, what makes you HHE-style."
            >
              <textarea
                name="bio"
                rows={5}
                defaultValue={practitioner.bio ?? ''}
                className="w-full rounded-md border bg-card px-3 py-2 text-sm outline-none ring-ring/30 focus-visible:ring-2"
              />
            </Field>

            <Field
              label="Who you help / how you work"
              hint="The matching signal: who you serve and how you help them. Surfaced on your profile and used by search."
            >
              <textarea
                name="whoIHelp"
                rows={3}
                defaultValue={practitioner.whoIHelp ?? ''}
                className="w-full rounded-md border bg-card px-3 py-2 text-sm outline-none ring-ring/30 focus-visible:ring-2"
              />
            </Field>

            <Field
              label={QUALIFICATIONS_HEADING}
              hint="One per line — degrees, certifications and training, in your own words. Shown on your public profile. “Draft my profile with AI” fills this in from what you paste, and you can edit every line."
            >
              <textarea
                name="qualifications"
                rows={4}
                defaultValue={practitioner.qualifications.join('\n')}
                placeholder={'BS in Nutrition, Bastyr University\nCertified Herbalist, HHE'}
                className="w-full rounded-md border bg-card px-3 py-2 text-sm outline-none ring-ring/30 focus-visible:ring-2"
              />
            </Field>

            <Field
              label="Website / affiliations"
              hint="Your practice site or primary professional link (any URL)."
            >
              <input
                type="url"
                name="websiteUrl"
                defaultValue={practitioner.websiteUrl ?? ''}
                placeholder="https://your-practice.com"
                className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
              />
            </Field>

            <Field label="Session formats">
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="telehealth"
                    defaultChecked={practitioner.telehealth ?? false}
                    className="h-4 w-4 rounded border"
                  />
                  Telehealth / virtual
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="inPerson"
                    defaultChecked={practitioner.inPerson ?? false}
                    className="h-4 w-4 rounded border"
                  />
                  In-person
                </label>
              </div>
            </Field>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="City">
                <CityField
                  defaultName={practitioner.city?.name}
                  defaultState={practitioner.city?.state}
                />
              </Field>

              <Field label="Years in practice">
                <input
                  type="number"
                  name="yearsInPractice"
                  min={0}
                  max={70}
                  defaultValue={practitioner.yearsInPractice ?? ''}
                  className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
                />
              </Field>
            </div>

            <Field
              label="Specialties"
              hint="Search the curated list, or type your own term — we'll keep your wording on your profile and match it to the right category. Nothing is blocked while we review new terms."
            >
              <SpecialtyComboboxField
                options={specialties.map((s) => ({ id: s.id, name: s.name }))}
                aliases={approvedAliases}
                initial={initialSpecialties}
              />
            </Field>

            <Separator />

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
              <Link
                href={`/practitioners/${params.slug}`}
                className="inline-flex h-10 items-center justify-center rounded-md border bg-card px-4 text-sm font-medium hover:bg-accent"
              >
                Cancel
              </Link>
              <button
                type="submit"
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Save profile
              </button>
            </div>
            <UnsavedChangesBar />
          </form>
        </Card>

        {practitioner.caseStudies.length > 0 && (
          <Card className="space-y-4 p-6 sm:p-8">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" aria-hidden />
                <h2 className="text-sm font-semibold">Client outcomes (AI-drafted)</h2>
              </div>
              <p className="text-xs text-muted-foreground">
                Anonymized highlights drafted from your description — a matching signal for search.
                Remove any that aren&apos;t accurate.
              </p>
            </div>
            <Separator />
            <ul className="space-y-3">
              {practitioner.caseStudies.map((cs) => {
                const remove = removeCaseStudy.bind(null, params.slug, cs.id);
                return (
                  <li key={cs.id} className="flex items-start justify-between gap-3 rounded-md border p-3">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">{cs.title}</p>
                      <p className="text-xs text-muted-foreground">{cs.summary}</p>
                      {cs.outcome && (
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Outcome:</span> {cs.outcome}
                        </p>
                      )}
                    </div>
                    <form action={remove}>
                      <button
                        type="submit"
                        aria-label="Remove outcome"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </form>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {/* Above billing and offerings deliberately: someone holding a slot on this
            practitioner's calendar is the most time-sensitive thing on the page. */}
        <BookingsSection rows={bookingRows} />

        <SubscriptionSection
          status={practitioner.subscriptionStatus}
          trialEndsAt={practitioner.trialEndsAt}
          isAdmin={ownerIsAdmin}
          isComplete={missing.length === 0}
          // The action mints a per-practitioner checkout carrying metadata.practitioner_id and
          // reuses whopSubscriptionCheckoutUrl once minted. The generic hosted URL is the last
          // resort only: it has no metadata, so the webhook can only match the payer by EMAIL —
          // which fails silently when someone pays from a different address than their profile.
          subscribeAction={startSubscriptionCheckoutAction}
          fallbackCheckoutUrl={process.env.WHOP_PLATFORM_CHECKOUT_URL ?? null}
          priceLabel={monthlyFeeLabel('PLAN_A')}
        />

        {/* OFFERINGS ABOVE BOOKING LINKS, STACKED FULL-WIDTH — operator ruling 2026-08-27,
            reversing the side-by-side pairing added 2026-08-25 (queue item 7).

            Two complaints from the 08-26 Amy call, and this section answers both:

            1. ORDER. Amy: "I'd almost move the offerings up to where booking links are, and just
               use it as is." She reacts well to the offerings block and finds booking links
               barren; leading with the weaker one sets the wrong expectation.
            2. WIDTH. Jonathan, live on the call: the fields were "crushed side by side…
               unmanageable this way." `lg:grid-cols-2` halved an editor whose rows already hold a
               title, price, duration and a description textarea. Stacked, each gets the full
               column.

            The deeper goal is that the edit page VISUALLY PREDICTS the public profile, so a
            practitioner can tell which link becomes the big rose button without Sarah explaining
            it — which she currently has to do for every person she onboards.

            Booking links still physically renders HERE, not inside the profile form above, even
            though its inputs submit with that form: `form="profile-form"` on each of
            BookingLinksField's inputs is what makes an element outside a `<form>`'s DOM subtree
            part of its submission. Offerings can't move up next to the profile form either —
            each offering is its own <form>. BookingsSection stays ahead of both for
            time-sensitivity, a separate ordering rule this does not touch. */}
        <div className="space-y-4">
          <OfferingsEditor
            offerings={practitioner.whopProducts.map((o) => ({
              id: o.id,
              title: o.title,
              description: o.description,
              priceUsdCents: o.priceUsdCents,
              interval: o.interval,
              category: o.category,
              duration: o.duration,
              isConsult: o.isConsult,
              acceptsPayments: o.acceptsPayments,
              bookingLinkId: o.bookingLinkId,
              listingVisibility: o.listingVisibility,
              whopPlanId: o.whopPlanId,
              purchaseUrl: o.purchaseUrl,
            }))}
            payoutsEnabled={practitioner.whopPayoutsEnabled}
            whopConnected={practitioner.whopCompanyId != null}
            // §12 — the "Schedule with" dropdown lists THIS practitioner's links only. D6 makes
            // that automatic: a BookingLink is always practitioner-scoped, so a shared scheduler
            // URL is a second row rather than a shared entity needing scoping logic here.
            bookingLinks={practitioner.bookingLinks.map((l) => ({
              id: l.id,
              label: l.label?.trim() || l.url,
            }))}
            createAction={createOfferingAction}
            updateAction={updateOfferingAction}
            deleteAction={deleteOfferingAction}
            publishAction={publishOfferingAction}
            unpublishAction={unpublishOfferingAction}
            reorderAction={reorderOfferingsAction}
          />

          <Card className="space-y-3 p-6 sm:p-8">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">Booking links</h2>
              <p className="text-xs text-muted-foreground">
                Your scheduling links (Cal.com, Calendly, SavvyCal, Acuity, etc.). Each appears as
                its own button on your profile. Add an optional label per link (e.g. &lsquo;Free
                15-min intro&rsquo;). Leave empty if you&apos;re not taking new bookings.
              </p>
              {/* §12: "a practitioner must be able to tell from the edit screen which link becomes
                  the primary CTA". Sarah currently explains this verbally to every person she
                  onboards. Three states, matching resolveHeroLink exactly — including the
                  suppression case, which is the one nobody expects. */}
              {heroLink ? (
                <p className="rounded-md border border-cta/30 bg-cta/5 px-3 py-2 text-xs">
                  <span className="font-medium">On your profile the big button reads</span>{' '}
                  &ldquo;{heroLabel}&rdquo;{' '}
                  <span className="text-muted-foreground">
                    and opens{' '}
                    {heroLink.label?.trim() ? `“${heroLink.label.trim()}”` : 'your only link'}.
                  </span>
                </p>
              ) : ctaLinks.length > 1 ? (
                <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">No primary button yet.</span> With
                  several links and none chosen as primary, your profile leads with your offerings
                  instead — pointing the big button at one arbitrary calendar would misrepresent
                  your practice.
                </p>
              ) : null}
            </div>
            {/* The key is load-bearing. Saving soft-redirects to ?saved=1, which keeps this
                subtree MOUNTED (same trap documented in UnsavedChangesBar) — so the field's lazy
                useState initializer never re-runs and a row added in this page session would keep
                dbId='' forever, being deleted and recreated on every later save. Keying on the
                persisted ids remounts it exactly when that set changes, and deliberately NOT when
                it hasn't: the invalid-URL redirect fires before the transaction, so a rejected
                save leaves the key identical and the practitioner's typed input survives.

                Accepted trade-off: when a save DOES change the id set, the remount reseeds from
                the server, so a second row left half-filled (a label typed, URL still blank — the
                server skips it) disappears. That is a visible row vanishing after an explicit
                save, against a silent id churn that would sever every offering's scheduler link;
                and showing exactly what was persisted is defensible on its own terms. Do not "fix"
                it by dropping the key. */}
            <BookingLinksField
              key={practitioner.bookingLinks.map((b) => b.id).join(',')}
              formId={PROFILE_FORM_ID}
              initial={practitioner.bookingLinks.map((b) => ({
                id: b.id,
                label: b.label ?? '',
                url: b.url,
                ctaLabel: b.ctaLabel ?? '',
              }))}
              offeringsByLinkId={offeringsByLinkId}
              offeringTitles={practitioner.whopProducts.map((o) => o.title)}
            />
          </Card>
        </div>

        <PaymentsSection
          slug={params.slug}
          whopCompanyId={practitioner.whopCompanyId}
          payoutStatus={practitioner.whopPayoutStatus}
          payoutsEnabled={practitioner.whopPayoutsEnabled}
          platformReady={isWhopPlatformsReady()}
          whopParam={searchParams.whop}
          startWhopOnboardingAction={startWhopOnboardingAction}
          openPayoutPortalAction={openPayoutPortalAction}
        />

        <AccountEmailSection
          // The OWNER's address, deliberately — not session.user.email, which is the VIEWER's
          // and differs whenever an admin is editing someone else's profile.
          email={practitioner.user.email}
          editingSomeoneElse={!isOwner}
          action={requestAccountEmailChangeAction}
          error={
            searchParams.error === 'email-taken' ||
            searchParams.error === 'bad-email' ||
            searchParams.error === 'email-send-failed'
              ? searchParams.error
              : null
          }
          saved={searchParams.saved === 'email'}
          pending={searchParams.saved === 'email-pending'}
          pendingEmail={practitioner.user.emailChangeRequests[0]?.newEmail ?? null}
        />

        <p className="text-center text-xs text-muted-foreground">
          Signed in as {session.user.email}
          {isViewerAdmin && ' · Admin'}
        </p>
      </div>
    </main>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}
