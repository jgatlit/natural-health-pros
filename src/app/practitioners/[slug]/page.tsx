import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, CheckCircle2, LogOut, Pencil } from 'lucide-react';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { QUALIFICATIONS_HEADING } from '@/lib/profile-sections';
import { OFFERING_ORDER, SPECIALTY_ORDER } from '@/lib/practitioner-ordering';
import { paymentsLive } from '@/lib/booking-flow';
import { offeringTarget, offeringsSurfacedByLinks } from '@/lib/profile-ctas';
import { OfferingCard } from '@/components/practitioners/OfferingCard';
import {
  OfferingsSummaryRail,
  offeringAnchorId,
} from '@/components/practitioners/OfferingsSummaryRail';
import { OfferingDetailOpener } from '@/components/practitioners/OfferingDetailOpener';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { PractitionerHero } from '@/components/practitioners/PractitionerHero';
import { PractitionerCTAs } from '@/components/practitioners/PractitionerCTAs';
import { signOutAction } from '@/components/site/actions';

type PageProps = {
  params: { slug: string };
  searchParams: {
    onboarded?: string;
    /**
     * A `ReferralTouch.touchToken`, put here by `/r/<token>` (spec §5.4.5 hop 3).
     *
     * Read and threaded onto every booking CTA so it survives the next navigation. Deliberately
     * NOT `ref` — that param already marks a practitioner's OWN audience and resolves to 0%
     * commission (canon D18), so reusing it would make every cross-referral free.
     *
     * Untrusted here. It is re-validated server-side against the practitioner being booked when
     * the intent is created; this page only passes it along.
     */
    nhpr?: string;
  };
};

async function loadPractitioner(slug: string) {
  return prisma.practitioner.findUnique({
    where: { slug },
    include: {
      city: true,
      specialties: { include: { specialty: true }, orderBy: SPECIALTY_ORDER },
      bookingLinks: { orderBy: { sortOrder: 'asc' } },
      caseStudies: { orderBy: { createdAt: 'desc' } },
      // No `active` filter: that column is dead and was a trap — it reads like a hidden/visible
      // toggle and is not one, and because it filtered HERE it would have removed an Offering
      // from every public surface at once, chooser included, with no UI to explain why.
      //
      // `archived` IS kept. It stays the natural home for soft-delete (hard-deleting an Offering
      // with BookingIntent rows pointing at it is its own problem), and the dashboard and admin
      // both already filter on it — dropping it here alone would let an archived Offering show
      // publicly while hidden from its own owner.
      //
      // NOT filtered on listingVisibility. The grid and the chooser need different subsets, and
      // filtering here would strip LINK_ONLY offerings before the chooser could see them —
      // destroying the one property that makes an unlisted free consult reachable (§4).
      // Partitioned below: listingVisibility gates the grid, bookingLinkId gates the chooser.
      whopProducts: { where: { archived: false }, orderBy: OFFERING_ORDER },
    },
  });
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const p = await loadPractitioner(params.slug);
  if (!p) return { title: 'Practitioner not found' };
  const descr = p.whoIHelp || p.headline || p.bio || undefined;
  return {
    title: `${p.displayName}${p.headline ? ` — ${p.headline}` : ''} · Natural Health Pros`,
    description: descr?.slice(0, 200),
  };
}

export default async function PractitionerPage({ params, searchParams }: PageProps) {
  const p = await loadPractitioner(params.slug);
  if (!p) notFound();

  // Carried onto every `/book` link below. Not validated here: this page renders for anyone, and
  // a bad token simply fails re-validation at capture and records `referralCarriage = NONE`.
  const referralTouchToken = searchParams.nhpr?.trim() || null;

  // The owner needs a way back to their dashboard from their own public page. Before this, the
  // dashboard link rendered ONLY behind ?onboarded — so once that first redirect was gone, the
  // practitioner had to hand-type "/edit" onto the URL. Sarah Schindler had to be walked through
  // exactly that on the 2026-08-11 call ("that's how you can get to it right now… that's another
  // item for my list"). Viewer-only: this never renders for the public.
  const session = await auth();
  const canEdit =
    !!session?.user &&
    (session.user.id === p.userId || session.user.role === 'ADMIN');

  // Dual-label: canonical names = curated rail chips. Parent rollups excluded from the chip set
  // to keep it tight.
  //
  // The `rawLabel` side no longer has a public surface — the right-pane list that rendered it was
  // removed as redundant (see the Qualifications section below). The data is untouched and still
  // feeds search; only the rendering went.
  const canonicalChips = Array.from(new Set(p.specialties.map((ps) => ps.specialty.name)));

  // Two layers, deliberately (§4, D3):
  //   listingVisibility → what the public GRID shows
  //   bookingLinkId     → what a Booking Link's CHOOSER offers, visibility ignored
  // One boolean could never express both, which is why `active` was the wrong tool for this.
  const ctaOfferings = p.whopProducts.map((o) => ({
    id: o.id,
    title: o.title,
    priceUsdCents: o.priceUsdCents,
    duration: o.duration,
    isConsult: o.isConsult,
    bookingLinkId: o.bookingLinkId,
    listingVisibility: o.listingVisibility,
  }));
  // Precomputed once per offering: paymentsLive was being evaluated twice with identical
  // arguments and the CtaOffering literal rebuilt inline, so the mapping existed in two places
  // that could drift.
  const gridOfferings = p.whopProducts
    .filter((o) => o.listingVisibility === 'LISTED')
    .map((o) => {
      const canTransact =
        paymentsLive({
          acceptsPayments: o.acceptsPayments,
          practitionerPayoutsEnabled: p.whopPayoutsEnabled,
          whopPlanId: o.whopPlanId,
        }) && o.purchaseUrl != null;
      // purchaseUrl is required, not incidental: the flow's checkout step reads it, so an
      // offering with a plan id but no checkout URL would render a confident action that lands
      // the buyer on "will be in touch" with no payment path. The old code deliberately left
      // such an offering unbuttoned rather than broken-looking.
      const actionable = o.bookingLinkId != null || canTransact;
      return {
        ...o,
        canTransact,
        href: actionable ? offeringTarget(p.slug, { ...o }, referralTouchToken) : null,
      };
    });

  // Computed once, not per offering inside the filter below.
  const surfacedByLink = offeringsSurfacedByLinks(p.bookingLinks, ctaOfferings);

  // §22: offerings a single Booking Link row already fully represents (title, price, duration)
  // get no card here — nothing left to add, and their fast-path link never routes here anyway.
  // What remains is exactly what the rail/chooser can still anchor into: standalone offerings and
  // catch-all-link members.
  const offeringsNeedingDetail = gridOfferings.filter((o) => !surfacedByLink.has(o.id));

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-4xl space-y-4">
        {searchParams.onboarded && (
          <Card className="flex flex-col items-start gap-3 border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span>
                <strong>Your page is live.</strong> Edit anything — bio, offerings, booking links —
                anytime in your dashboard.
              </span>
            </p>
            <Link
              href={`/practitioners/${params.slug}/edit`}
              className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Go to dashboard
            </Link>
          </Card>
        )}
        {/* TOP BAR — a subtle back link, NOT a site header.
            
            Operator ruling 2026-08-27, after the finding that a visitor landing here had no
            navigation at all: "the profile page NEEDS a subtle top-left nav link, 'back to
            Directory'… Keep it subtle: a small link/breadcrumb in the top-left, not a full site
            header." That is deliberate and worth preserving — this page doubles as a
            practitioner's shareable business card, and NHP chrome across the top of it competes
            with the thing they are sharing. So `/search` and the homepage get `SiteHeader`; this
            page gets one link, styled to match the identical "Back to profile" affordance already
            on /edit.

            Not cosmetic. Per D18 we attribute organic search landings to NHP rather than to the
            practitioner, on the grounds that the traffic is ours — and until now those visitors
            arrived on a page with no route into the directory at all. We were claiming the lead
            and then dead-ending it.

            SIGN-OUT sits on the right and is OWNER-ONLY, which is why it does not conflict with
            the ruling above: a visitor never sees it. It is here because the sign-out shipped in
            PR #72 lives inside SiteHeader, which rendered on the homepage alone — so a
            practitioner who signed in and navigated to their own profile had no way to sign out
            without first finding their way back to `/`. */}
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/search"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Directory
          </Link>

          {canEdit && (
            <div className="flex items-center gap-2">
              {/* The onboarded banner below already carries a dashboard link, so the pencil would
                  be the second copy of it on that one render. Sign-out is not duplicated there. */}
              {!searchParams.onboarded && (
                <Link
                  href={`/practitioners/${params.slug}/edit`}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border bg-card px-4 text-xs font-medium transition-colors hover:bg-accent/40"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  Edit my profile
                </Link>
              )}
              <form action={signOutAction}>
                <button
                  type="submit"
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                >
                  <LogOut className="h-3.5 w-3.5" aria-hidden />
                  Sign out
                </button>
              </form>
            </div>
          )}
        </div>
        <Card className="p-6 sm:p-12">
          {/* Additive only — the rail's anchors already scroll without it (see the component). */}
          <OfferingDetailOpener />
          <div className="grid gap-12 sm:grid-cols-[22rem_1fr]">
            {/* Sticky identity + booking rail (Variation B) */}
            <aside className="min-w-0 space-y-6 sm:sticky sm:top-8 sm:self-start">
              <PractitionerHero
                displayName={p.displayName}
                headline={p.headline}
                photoUrl={p.photoUrl}
                city={p.city ? { name: p.city.name, state: p.city.state } : null}
                telehealth={p.telehealth}
                inPerson={p.inPerson}
                yearsInPractice={p.yearsInPractice}
                chips={canonicalChips}
                hheCertified={p.hheCertified}
                framing={{
                  photoFocalX: p.photoFocalX,
                  photoFocalY: p.photoFocalY,
                  photoZoom: p.photoZoom,
                }}
              />
              <PractitionerCTAs
                slug={p.slug}
                bookingLinks={p.bookingLinks.map((b) => ({
                  id: b.id,
                  label: b.label,
                  url: b.url,
                  ctaLabel: b.ctaLabel,
                }))}
                // EVERY non-archived offering, listingVisibility included: chooser membership is
                // gated by bookingLinkId, never by visibility (§4).
                offerings={ctaOfferings}
                referralTouchToken={referralTouchToken}
                primaryBookingLinkId={p.primaryBookingLinkId}
                websiteUrl={p.websiteUrl}
              />
              {/* UNDER the primary CTA, in the LEFT pane — the shape Amy reacted to on the 08-26
                  call ("See, that looks great!"). Only LISTED offerings: a LINK_ONLY free consult
                  stays reachable through the booking-link chooser and nowhere else (§4, D3). */}
              <OfferingsSummaryRail
                // §22: standalone offerings ONLY. A single-linked offering is already shown in
                // full by its Booking Link row above; a catch-all-linked offering (2+ per link)
                // now has its OWN left-pane entry point via the chooser, which anchors straight
                // into the same right-column card — a rail row here would be a second path to
                // the exact same card the chooser already opens.
                offerings={offeringsNeedingDetail
                  .filter((o) => o.bookingLinkId === null)
                  .map((o) => ({
                  id: o.id,
                  title: o.title,
                  priceUsdCents: o.priceUsdCents,
                  interval: o.interval,
                  duration: o.duration,
                }))}
              />
            </aside>

            {/* Scrollable narrative */}
            <div className="min-w-0 space-y-6">
              {/* Hook sits at the top of the narrative column, directly above whoIHelp. The
                  credential line (headline) stays with the identity rail on the left, so the two
                  read as distinct registers rather than two titles stacked together. */}
              {p.tagline && (
                <p className="font-serif text-2xl leading-snug tracking-tight text-primary">
                  {p.tagline}
                </p>
              )}

              {p.whoIHelp && (
                <p className="text-lg leading-relaxed text-foreground">{p.whoIHelp}</p>
              )}

              {p.bio && (
                <section
                  aria-label="About"
                  className="space-y-2 rounded-xl bg-secondary/40 p-6"
                >
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    About {p.displayName.split(/\s+/)[0]}
                  </h2>
                  <div className="space-y-3 text-sm leading-relaxed text-foreground">
                    {p.bio.split(/\n{2,}/).map((para, i) => (
                      <p key={i}>{para.trim()}</p>
                    ))}
                  </div>
                </section>
              )}

              {/* QUALIFICATIONS — replaces the right-pane specialties list, which repeated the
                  chips already shown in the identity rail on the left. Amy originated the ask
                  from her own 08-17 interface review and confirmed it on the 08-26 call.

                  ⚠️ CONSEQUENCE WORTH KNOWING: the removed list rendered the practitioner's OWN
                  specialty phrasing (`rawLabel`), while the left-pane chips render the CANONICAL
                  names. They are not the same strings, so the raw phrasing now renders nowhere on
                  the public profile. It is still stored, and still feeds search. Sarah Schindler
                  valued that section enough on 2026-08-11 to ask for its heading to be corrected,
                  so if anyone asks where her wording went, this is the answer.

                  The heading is an env-backed constant because Amy floated three variants and
                  picked none — see profile-sections.ts. */}
              {p.qualifications.length > 0 && (
                <section
                  aria-label={QUALIFICATIONS_HEADING}
                  className="space-y-2 rounded-xl bg-secondary/40 p-6"
                >
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {QUALIFICATIONS_HEADING}
                  </h2>
                  <ul className="divide-y rounded-lg border bg-card">
                    {p.qualifications.map((q) => (
                      <li key={q} className="px-3 py-2.5 text-sm">
                        {q}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* §22: no longer the full Offerings grid. An offering fully represented by a
                  single Booking Link row on the left (surfacedByLink) has nothing left to add
                  here — that pair now renders ONCE, not twice — so this list is reveal-only
                  targets for offerings that still need a detail read: standalone offerings
                  (rail) and multi-offering chooser members (chooser now anchors here instead of
                  routing straight into the flow, see PractitionerCTAs/BookingChooser). Closed by
                  default (`<details>`); nothing here duplicates the left pane. */}
              {offeringsNeedingDetail.length > 0 && (
                <section
                  aria-label="Offerings"
                  className="space-y-3 rounded-xl bg-secondary/40 p-6"
                >
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Offerings
                  </h2>
                  <ul className="space-y-2.5">
                    {offeringsNeedingDetail.map((o) => (
                      <OfferingCard
                        key={o.id}
                        anchorId={offeringAnchorId(o.id)}
                        // The rail still renders this same set (standalone + catch-all-linked
                        // offerings), so the card drops its duplicate price line — the expanded
                        // detail below still states it.
                        railed
                        title={o.title}
                        description={o.description}
                        priceUsdCents={o.priceUsdCents}
                        interval={o.interval}
                        category={o.category}
                        duration={o.duration}
                        // Straight into the flow — never a chooser (§4). Null only when there is
                        // genuinely nothing to act on: no calendar and no live checkout.
                        href={o.href}
                        canTransact={o.canTransact}
                      />
                    ))}
                  </ul>
                </section>
              )}

              {p.caseStudies.length > 0 && (
                <section
                  aria-label="Outcomes"
                  className="space-y-3 rounded-xl bg-secondary/40 p-6"
                >
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Outcomes
                  </h2>
                  <ul className="space-y-3">
                    {p.caseStudies.map((cs) => (
                      <li key={cs.id} className="rounded-lg border bg-card p-4">
                        <p className="text-sm font-medium">{cs.title}</p>
                        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                          {cs.summary}
                        </p>
                        {cs.outcome && (
                          <p className="mt-1 text-sm leading-relaxed text-foreground">{cs.outcome}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Queue item 8 (2026-08-25) — coming-soon placeholder ONLY. Reviews aren't built:
                  Jonathan deferred them on the 08-18 call until there's "a critical mass of
                  practitioners using Google reviews" to plug into instead of building a bespoke
                  system now. Case studies/manual testimonials are a separate, buildable-now piece
                  still blocked on Amy's authenticity policy — this section is about neither of
                  those, just the plain fact that reviews are coming.
                  Deliberately informational, not a button or a greyed-out tile: the 08-11 call's
                  A4 ruling removed a similar-looking disabled-tile CTA pattern for reading as
                  broken on a live profile. No click target, no disabled state — just a quiet,
                  permanent note next to whatever else this section of the page is showing. */}
              <section
                aria-label="Reviews"
                className="space-y-2 rounded-xl bg-secondary/40 p-6 text-center"
              >
                <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Reviews
                </h2>
                <p className="text-xs text-muted-foreground">
                  Client reviews are coming to Natural Health Pros soon.
                </p>
              </section>
            </div>
          </div>

          <Separator className="my-8" />
          <p className="text-center text-xs text-muted-foreground">
            HHE-curated practitioner · invite-only directory
          </p>
        </Card>
      </div>
    </main>
  );
}
