import Link from 'next/link';
import { Calendar, Globe, ChevronRight } from 'lucide-react';
import {
  resolveHeroLink,
  offeringsForLink,
  ctaLabelFor,
  linkDisplayLabel,
  bookingLinkTarget,
  type CtaBookingLink,
  type CtaOffering,
} from '@/lib/profile-ctas';
import { chooserOptionTarget, linkPriceHint } from '@/lib/profile-ctas';
import { formatPrice } from '@/lib/money';
import { BookingChooser } from '@/components/practitioners/BookingChooser';

type Props = {
  slug: string;
  bookingLinks?: CtaBookingLink[];
  /** Every non-archived offering — chooser membership ignores listingVisibility (§4). */
  offerings?: CtaOffering[];
  primaryBookingLinkId?: string | null;
  websiteUrl?: string | null;
  /**
   * A `ReferralTouch.touchToken`, threaded onto every `/book` URL this renders (spec §5.4.5 hop 3).
   *
   * Passed down rather than read from a cookie here: the visitor arrived at this page with the
   * token in the URL, and the booking flow is where it has to end up. Undefined on every ordinary
   * visit, which is most of them.
   */
  referralTouchToken?: string | null;
};

/**
 * The price/duration sub-line on a Booking Link entry (08-26 call).
 *
 * Amy: the booking-links block "feels barren compared to the offerings." Falls back to the host
 * hint when the link has no Offerings pointing at it — there is genuinely no price to state, and
 * inventing one would claim something the practitioner never said.
 */
function linkSubLine(
  link: CtaBookingLink,
  linked: Parameters<typeof linkPriceHint>[0],
): string {
  const hint = linkPriceHint(linked);
  // ZERO LINKED OFFERINGS IS THE TYPICAL FREE CONSULT (operator ruling 2026-08-27): a bare Booking
  // Link with no Whop item and no price. There is genuinely no price to state, so prefer the
  // link's own label and fall back to the scheduler host only when it has none. Showing
  // "calendly.com" as the sub-line of the most common free-consult shape is the worst of the
  // three options, and it was what the secondary CTA did while the hero already did this.
  if (!hint) return link.label?.trim() || linkDisplayLabel(link, linked) || hostHint(link.url);

  const price =
    hint.minCents === hint.maxCents
      ? hint.minCents > 0
        ? formatPrice(hint.minCents)
        : 'Free'
      : `${hint.minCents > 0 ? formatPrice(hint.minCents) : 'Free'}–${formatPrice(hint.maxCents)}`;

  return hint.duration ? `${price} · ${hint.duration} min` : price;
}

function hostHint(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Open link';
  }
}

/**
 * Booking rail — the DECIDED buyer's surface (§4).
 *
 * Decided to ACT, not decided to BUY, which is why a free consult belongs here. The job of these
 * CTAs is to get out of the way; the Offering cards below do the selling.
 *
 * Every CTA now enters the on-page flow instead of opening the practitioner's scheduler in a new
 * tab. That new-tab behaviour was T3 — the last-resort tier — and it was what shipped for every
 * practitioner, so this is the first time the on-page requirement is actually met.
 */
export function PractitionerCTAs({
  slug,
  bookingLinks = [],
  offerings = [],
  primaryBookingLinkId,
  websiteUrl,
  referralTouchToken,
}: Props) {
  const hero = resolveHeroLink(bookingLinks, primaryBookingLinkId ?? null);
  const secondary = bookingLinks.filter((l) => l.id !== hero?.id);

  return (
    <section aria-labelledby="booking-links-heading" className="space-y-3">
      {/* A HEADING, asked for on the 08-26 call. Without one the rail read as a bare stack of
          buttons with no explanation of what it was for. Per-link wording stays overridable
          through `cta_label`; this labels the block, not the buttons. */}
      <h2
        id="booking-links-heading"
        className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
      >
        Book time with me now
      </h2>
      {hero ? (
        <HeroCta slug={slug} link={hero} offerings={offerings}
          referralTouchToken={referralTouchToken} />
      ) : bookingLinks.length > 0 ? (
        // §14.3 hero suppression: several links, none designated. The cards lead instead — a hero
        // pointing at one arbitrary calendar would misrepresent the practice. The links
        // themselves still render below; only the hero SLOT is suppressed.
        <p className="rounded-lg border border-dashed bg-card p-3 text-xs text-muted-foreground">
          Choose what you&apos;d like to book below.
        </p>
      ) : (
        <div
          className="flex items-center gap-3 rounded-lg border border-dashed bg-card p-4 opacity-70"
          aria-disabled
        >
          <Calendar className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Booking coming soon</p>
            <p className="text-xs text-muted-foreground">Reach out via their website below</p>
          </div>
        </div>
      )}

      {secondary.map((b) => (
        <SecondaryCta key={b.id} slug={slug} link={b} offerings={offerings}
          referralTouchToken={referralTouchToken} />
      ))}

      {websiteUrl && (
        <a
          href={websiteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent/40"
        >
          <Globe className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">Visit website</p>
            <p className="truncate text-xs text-muted-foreground">{hostHint(websiteUrl)}</p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        </a>
      )}
    </section>
  );
}

function HeroCta({
  slug,
  link,
  offerings,
  referralTouchToken,
}: {
  slug: string;
  link: CtaBookingLink;
  offerings: CtaOffering[];
  referralTouchToken?: string | null;
}) {
  const linked = offeringsForLink(offerings, link.id);
  const target = bookingLinkTarget(slug, link, linked, referralTouchToken);
  const label = ctaLabelFor(link, linked);

  if (target.kind === 'chooser') {
    return (
      <BookingChooser
        ctaLabel={label}
        subLabel={`${linked.length} options`}
        options={linked.map((o) => ({
          id: o.id,
          title: o.title,
          priceUsdCents: o.priceUsdCents,
          href: chooserOptionTarget(slug, link.id, o, referralTouchToken),
        }))}
      />
    );
  }

  return (
    <Link
      href={target.href}
      className="group flex items-center gap-3 rounded-lg bg-cta p-4 text-cta-foreground transition-opacity hover:opacity-90"
    >
      <Calendar className="h-5 w-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{label}</p>
        <p className="truncate text-xs opacity-80">
          {linkSubLine(link, linked)}
        </p>
      </div>
      <ChevronRight
        className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </Link>
  );
}

function SecondaryCta({
  slug,
  link,
  offerings,
  referralTouchToken,
}: {
  slug: string;
  link: CtaBookingLink;
  offerings: CtaOffering[];
  referralTouchToken?: string | null;
}) {
  const linked = offeringsForLink(offerings, link.id);
  const target = bookingLinkTarget(slug, link, linked, referralTouchToken);

  if (target.kind === 'chooser') {
    return (
      <BookingChooser
        ctaLabel={ctaLabelFor(link, linked)}
        subLabel={`${linked.length} options`}
        options={linked.map((o) => ({
          id: o.id,
          title: o.title,
          priceUsdCents: o.priceUsdCents,
          href: chooserOptionTarget(slug, link.id, o, referralTouchToken),
        }))}
      />
    );
  }

  return (
    <Link
      href={target.href}
      className="group flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent/40"
    >
      <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{linkDisplayLabel(link, linked)}</p>
        <p className="truncate text-xs text-muted-foreground">{linkSubLine(link, linked)}</p>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}

