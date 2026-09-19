import { offeringAnchorId } from '@/components/practitioners/OfferingsSummaryRail';
import { REFERRAL_PARAM } from '@/lib/referral-param';

export type CtaOffering = {
  id: string;
  title: string;
  priceUsdCents: number;
  /** Minutes. Null when the practitioner has not said. */
  duration: number | null;
  isConsult: boolean;
  bookingLinkId: string | null;
  listingVisibility: 'LISTED' | 'LINK_ONLY';
};

export type CtaBookingLink = {
  id: string;
  label: string | null;
  url: string;
  ctaLabel: string | null;
};

/**
 * Offerings attached to one Booking Link — the chooser's membership set (§14.1).
 *
 * Deliberately ignores `listingVisibility`: §4 requires the chooser to list ALL Offerings
 * pointing at the link REGARDLESS of it, and that is the single property that makes an unlisted
 * free consult reachable there and nowhere else. Two distinct layers — `listingVisibility` gates
 * the profile grid, `bookingLinkId` gates chooser membership.
 *
 * ⚠️ Never filter this on `WhopProduct.active`. It looks like the visibility flag and is not: it
 * was applied in the profile query itself, so anything it excluded never entered the loaded set
 * and would vanish from the chooser too. (It is also dead — read but never written.)
 */
export function offeringsForLink(offerings: CtaOffering[], linkId: string): CtaOffering[] {
  return offerings.filter((o) => o.bookingLinkId === linkId);
}

/**
 * Which Booking Link, if any, gets the hero slot (§14.3).
 *
 * A designated primary always wins. With none designated, a SINGLE link is unambiguous and is
 * promoted; with several, the hero is SUPPRESSED and Offering cards lead — in that topology the
 * cards are the correct entry point, and a hero pointing at one arbitrary calendar would
 * misrepresent the practice.
 *
 * Note this is not the same rule as "a link with zero Offerings is unconfigured". A booking link
 * with no linked Offerings still renders and is schedulable; suppression here is about which of
 * SEVERAL links deserves the hero, never about whether a link is usable.
 */
export function resolveHeroLink(
  links: CtaBookingLink[],
  primaryBookingLinkId: string | null,
): CtaBookingLink | null {
  if (links.length === 0) return null;
  const designated = primaryBookingLinkId
    ? links.find((l) => l.id === primaryBookingLinkId)
    : undefined;
  if (designated) return designated;
  return links.length === 1 ? links[0]! : null;
}

/**
 * Public button text for a Booking Link (§4).
 *
 * Defaults to "Book a free consultation" when a zero-price Offering is attached, "Book now"
 * otherwise; the practitioner's own `ctaLabel` always wins. The default matters most in the case
 * it was written for: when the free consult is LINK_ONLY, this button is the ONLY signal it
 * exists anywhere on the profile.
 */
export function ctaLabelFor(link: CtaBookingLink, linked: CtaOffering[]): string {
  const override = link.ctaLabel?.trim();
  if (override) return override;
  const hasFree = linked.some((o) => o.isConsult || o.priceUsdCents === 0);
  return hasFree ? 'Book a free consultation' : 'Book now';
}

/**
 * Display name for a Booking Link (§4 label defaulting).
 *
 * With exactly one Offering linked, borrow that Offering's title so the link and the card read as
 * one thing rather than two unrelated entries. With several there is no single title to borrow.
 */
export function linkDisplayLabel(link: CtaBookingLink, linked: CtaOffering[]): string {
  const own = link.label?.trim();
  if (own) return own;
  if (linked.length === 1) return linked[0]!.title;
  return 'Book a session';
}

/**
 * Thread a referral through a booking URL (spec v1.4 §5.4.5, hop 3).
 *
 * ⚠️ THE PARAM IS `nhpr`, NOT `ref`. `?ref=` is already taken by lead attribution and means the
 * OPPOSITE thing — a practitioner tagging their own audience, which resolves to 0% commission
 * (canon D18). A referral link carrying it would make every cross-referral free and pay the
 * referrer nothing.
 *
 * Omitted entirely when there is no referral, rather than set empty: these URLs get copied and
 * shared, and a dangling `?nhpr=` would travel with them.
 *
 * These three builders are the ONLY places a `/book` URL is constructed, which is what makes the
 * carriage assertable — see `tests/profile-ctas.test.ts` and `tests/referral-carriage.test.ts`.
 */
function withReferral(params: URLSearchParams, referralTouchToken?: string | null): void {
  const token = referralTouchToken?.trim();
  if (token) params.set(REFERRAL_PARAM, token);
}

/**
 * Where a Booking Link CTA sends the buyer (§4 entry-point routing).
 *
 * 0 linked → straight into the flow with no Offering. This is a SUPPORTED entry point, not an
 *            unconfigured one: capture → schedule → done, with checkout skipped because there is
 *            nothing to charge for.
 * 1 linked → straight in carrying that Offering, so the fast path for a decided buyer survives.
 * 2+       → chooser, expanded ON THE PROFILE. Intent is "book with this practitioner", not yet
 *            "book this thing" — and keeping the choice on the profile preserves the
 *            decided-buyer property rather than turning it into a step inside the flow.
 */
export function bookingLinkTarget(
  slug: string,
  link: CtaBookingLink,
  linked: CtaOffering[],
  referralTouchToken?: string | null,
): { kind: 'chooser' } | { kind: 'flow'; href: string } {
  if (linked.length > 1) return { kind: 'chooser' };
  const params = new URLSearchParams({ link: link.id });
  if (linked.length === 1) params.set('offering', linked[0]!.id);
  withReferral(params, referralTouchToken);
  return { kind: 'flow', href: `/practitioners/${encodeURIComponent(slug)}/book?${params}` };
}

/**
 * Where an Offering card's inner action sends the buyer.
 *
 * NEVER a chooser (§4): the buyer has already expressed which Offering they want, and
 * re-presenting a menu containing a free option cannibalises a decided buyer.
 */
export function offeringTarget(
  slug: string,
  offering: CtaOffering,
  referralTouchToken?: string | null,
): string {
  const params = new URLSearchParams({ offering: offering.id });
  if (offering.bookingLinkId) params.set('link', offering.bookingLinkId);
  withReferral(params, referralTouchToken);
  return `/practitioners/${encodeURIComponent(slug)}/book?${params}`;
}

/**
 * A chooser option's destination (§22).
 *
 * A LISTED offering has a full card in the right column — route there (same anchor the rail
 * uses) so a genuinely undecided buyer reads the description before committing, instead of the
 * chooser silently duplicating the rail's old direct-to-flow shortcut. A LINK_ONLY offering (the
 * unlisted free consult, §4/D3) has no card anywhere on the page — the chooser is its only route,
 * so it must still go straight into the flow; there is nothing to reveal.
 *
 * Extracted because both chooser render paths were building this by hand — the only untested URL
 * construction in the feature, and the two places most likely to drift from the helpers.
 */
export function chooserOptionTarget(
  slug: string,
  linkId: string,
  offering: Pick<CtaOffering, 'id' | 'listingVisibility'>,
  referralTouchToken?: string | null,
): string {
  if (offering.listingVisibility === 'LISTED') {
    return `#${offeringAnchorId(offering.id)}`;
  }
  const params = new URLSearchParams({ link: linkId, offering: offering.id });
  withReferral(params, referralTouchToken);
  return `/practitioners/${encodeURIComponent(slug)}/book?${params}`;
}

/**
 * Price + duration to show ON a Booking Link entry (§4, folded in from the 08-26 call).
 *
 * Amy: the booking-links block "feels barren compared to the offerings." A link has no price of
 * its own — the price lives on the Offerings pointing at it — so this derives one:
 *
 *   1 linked   → that Offering's exact price and duration.
 *   2+ linked  → a RANGE, because naming one price would misrepresent the others.
 *   0 linked   → nothing. A link with no Offering has no price, and inventing "Free" here would
 *                claim something the practitioner never said.
 *
 * Returns cents and minutes rather than formatted strings so the caller owns presentation and
 * this stays assertable without matching on currency formatting.
 */
export function linkPriceHint(linked: CtaOffering[]): {
  minCents: number;
  maxCents: number;
  duration: number | null;
} | null {
  if (linked.length === 0) return null;
  const prices = linked.map((o) => o.priceUsdCents);
  const minCents = Math.min(...prices);
  const maxCents = Math.max(...prices);
  // Only meaningful when it is unambiguous — one linked offering, or several that agree.
  const durations = Array.from(
    new Set(linked.map((o) => o.duration).filter((d): d is number => d != null && d > 0)),
  );
  return { minCents, maxCents, duration: durations.length === 1 ? durations[0]! : null };
}

/**
 * Offering ids ALREADY fully displayed by a Booking Link entry — the "single, unambiguous pair"
 * case, which now needs no second surface anywhere on the page (§22).
 *
 * A link with exactly ONE linked Offering renders that Offering's title, price and duration on its
 * own row (see `linkPriceHint`); repeating it anywhere else prints the same thing twice.
 *
 * ⚠️ THIS IS TOPOLOGY-DEPENDENT, which is why it was missed until real data was rendered (§14.1):
 *   - CATCH-ALL (1 link → N offerings): the link shows a price RANGE and names nothing, so every
 *     offering still needs its own right-column card. Nothing is suppressed.
 *   - PURPOSE-BUILT (N links → 1 offering each): every link row already IS its offering, so a
 *     second surface would duplicate all of them. Sarah Schindler's live profile is this shape —
 *     4 links, 3 of them carrying a specific `offering=`.
 *
 * A link with 0 linked Offerings (the typical free consult, §3 shape A) surfaces nothing and
 * suppresses nothing.
 *
 * CONSUMERS, both in `page.tsx` (§22 — this did NOT become dead code once the right column
 * stopped rendering a permanent full list, it became the thing that decides what's IN that
 * shorter list): the right-column card set (a suppressed id gets no card at all — its Booking
 * Link row already said everything a card would), and in turn the left-pane rail (rail items are
 * a subset of the card set — standalone Offerings only, since catch-all-linked ones now reach
 * their card via the chooser instead).
 */
/**
 * §22 edit-page nudge: does this Booking Link's own label name an Offering that exists on the
 * account but is not attached to it? Returns the matching title, or null.
 *
 * Exact match only (case-insensitive, trimmed) — this is an admin-only advisory signal, and a
 * fuzzy match risks false positives that would make it noise a practitioner learns to ignore.
 * Real case this was written for: Amy Sprouse's Offering "3 Month Health Transformation" sat
 * attached to her "1 Month of Support" Booking Link, while a link of the identical name sat empty
 * — invisible on the edit page until this existed.
 */
export function unattachedNameMatch(
  linkLabel: string,
  attachedTitles: string[],
  allOfferingTitles: string[],
): string | null {
  const label = linkLabel.trim().toLowerCase();
  if (!label) return null;
  const match = allOfferingTitles.find((t) => t.trim().toLowerCase() === label);
  if (!match) return null;
  const alreadyAttached = attachedTitles.some((t) => t.trim().toLowerCase() === label);
  return alreadyAttached ? null : match;
}

export function offeringsSurfacedByLinks(
  links: CtaBookingLink[],
  offerings: CtaOffering[],
): Set<string> {
  const surfaced = new Set<string>();
  for (const link of links) {
    const linked = offeringsForLink(offerings, link.id);
    if (linked.length === 1) surfaced.add(linked[0]!.id);
  }
  return surfaced;
}
