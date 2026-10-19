'use client';

import { useEffect, useRef, useState } from 'react';
import { CalendarClock, Link2 } from 'lucide-react';
import { exceedsWhopPaymentLimit, WHOP_OVER_LIMIT_MESSAGE } from '@/lib/whop-limits';

export type OfferingFormValues = {
  title: string;
  description: string | null;
  priceUsdCents: number;
  interval: 'ONE_TIME' | 'MONTHLY' | 'ANNUAL';
  category: string | null;
  duration: number | null;
  isConsult: boolean;
  acceptsPayments: boolean;
  bookingLinkId: string | null;
  listingVisibility: 'LISTED' | 'LINK_ONLY';
  whopPlanId: string | null;
};

export type BookingLinkOption = { id: string; label: string };

const CATEGORY_SUGGESTIONS = [
  'Consultation',
  'Session',
  'Package',
  'Program',
  'Product',
  'Treatment',
  'Subscription',
];

const dollars = (cents: number) => (cents > 0 ? (cents / 100).toString() : '');

/** Same parse as the server's parsePriceToCents, for the live limit check only. */
const priceToCents = (raw: string) => {
  const n = parseFloat(raw.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};

/**
 * A DISABLED input is excluded from form submission entirely — not sent as false, not sent at
 * all. So a checkbox that is disabled *while checked* silently posts nothing, and the server
 * reads the absence as false. For `listingVisibility` that would flip a LISTED Offering to
 * LINK_ONLY with no booking link, violating the DB CHECK on a save the practitioner never made.
 *
 * Mirroring the intended value into a hidden input keeps the submitted payload equal to what the
 * UI displays, which is the property the whole disabled-state design depends on.
 */
function DisabledMirror({ name, checked }: { name: string; checked: boolean }) {
  return checked ? <input type="hidden" name={name} value="on" /> : null;
}

/**
 * Offering editor fields (spec §12). A client component because the controls are
 * INTERDEPENDENT — free-consult disables price and payments, and profile visibility is only
 * meaningful once a Booking Link is chosen. Those rules have to hold as the practitioner types,
 * not only after a round trip.
 */
export function OfferingFields({
  offering,
  idPrefix,
  bookingLinks,
  whopConnected,
}: {
  offering: OfferingFormValues | null;
  idPrefix: string;
  bookingLinks: BookingLinkOption[];
  /**
   * §22-B — the checkbox is gated on the offering ALREADY having a live Whop plan (published at
   * least once), not on being connected. Before that, ticking it did nothing purchasable —
   * Publish is the step that actually calls Whop — which is exactly the trap Sarah and Jonathan
   * hit live on the 2026-09-03 call. Publish now sets `acceptsPayments: true` itself, so there is
   * nothing left to pre-tick.
   *
   * Once an offering HAS been published, the checkbox stays interactive regardless of the
   * practitioner's current payout status — that is what preserves the one case pre-ticking still
   * matters for: a temporarily restricted Whop account (`whopPayoutsEnabled` flips false without
   * `whopPlanId` being cleared) resumes automatically when the restriction lifts, no re-editing.
   */
  whopConnected: boolean;
}) {
  const [isConsult, setIsConsult] = useState(offering?.isConsult ?? false);
  // Whop's $2,500 ceiling, said while typing and enforced on Save; the server refuses it too. Only
  // the flag is state: the input stays uncontrolled, like every other field in this row.
  const [typedCents, setTypedCents] = useState(offering?.priceUsdCents ?? 0);
  const priceRef = useRef<HTMLInputElement>(null);
  const overLimit = !isConsult && exceedsWhopPaymentLimit(typedCents);
  useEffect(() => {
    priceRef.current?.setCustomValidity(overLimit ? WHOP_OVER_LIMIT_MESSAGE : '');
  }, [overLimit]);
  const [acceptsPayments, setAcceptsPayments] = useState(offering?.acceptsPayments ?? false);
  const [bookingLinkId, setBookingLinkId] = useState(offering?.bookingLinkId ?? '');
  const [showOnProfile, setShowOnProfile] = useState(
    (offering?.listingVisibility ?? 'LISTED') === 'LISTED',
  );

  // D2 — a free consultation is an Offering with price 0 and no Whop plan. Payment is not
  // "unavailable" for it, it is meaningless. That is the ONLY case that forces the value false.
  // §22-B — everything else stays locked until the offering has actually been published: before
  // that there is no Whop plan for the flag to gate, so a tick is a promise with nothing behind
  // it. `unpublishOffering` nulls `whopPlanId`, which correctly re-locks this along with the rest
  // of "not published" state — Unpublish and "never published" read identically here on purpose.
  const notYetPublished = !offering?.whopPlanId;
  const paymentsLocked = isConsult || !whopConnected || notYetPublished;
  // Show the STORED bit. Masking it with capability made the row lie about its own state, and —
  // because the disabled mirror was then fed the masked value — every save silently rewrote a
  // stored `true` to false. The bit is intent; only isConsult may overwrite intent.
  const shownAcceptsPayments = isConsult ? false : acceptsPayments;

  // LINK_ONLY REQUIRES a booking link (§2 constraint, backed by a DB CHECK). Enforced here by
  // construction: with no link chosen the Offering must stay LISTED, so the control is disabled
  // rather than allowed to produce an unrepresentable state.
  const visibilityLocked = !bookingLinkId;
  const effectiveShowOnProfile = visibilityLocked ? true : showOnProfile;

  function onConsultChange(next: boolean) {
    setIsConsult(next);
    // §4 — a free consult is typically reachable only through the Booking Link chooser. Only
    // possible once a link exists; otherwise it would be reachable from nowhere at all.
    if (next && bookingLinkId) setShowOnProfile(false);
  }

  function onBookingLinkChange(next: string) {
    setBookingLinkId(next);
    // Clearing the link reverts to LISTED (§2) — the alternative is an Offering hidden from the
    // grid and attached to no chooser, i.e. invisible everywhere.
    if (!next) setShowOnProfile(true);
  }

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1fr_9rem]">
        <input
          type="text"
          name="title"
          required
          maxLength={80}
          defaultValue={offering?.title ?? ''}
          placeholder="e.g. 60-min initial consultation"
          className="h-9 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
        />
        <div
          className={`flex items-center gap-1.5 rounded-md border bg-card px-2 ${isConsult ? 'opacity-50' : ''}`}
        >
          <span className="text-sm text-muted-foreground">$</span>
          <input
            type="text"
            inputMode="decimal"
            name="price"
            ref={priceRef}
            disabled={isConsult}
            defaultValue={offering ? dollars(offering.priceUsdCents) : ''}
            onInput={(e) => setTypedCents(priceToCents(e.currentTarget.value))}
            aria-invalid={overLimit || undefined}
            aria-describedby={overLimit ? `offering-price-limit-${idPrefix}` : undefined}
            placeholder={isConsult ? 'Free' : '150'}
            className="h-9 w-full bg-transparent text-sm outline-none disabled:cursor-not-allowed"
          />
        </div>
      </div>
      {overLimit && (
        <p id={`offering-price-limit-${idPrefix}`} role="alert" className="text-xs text-destructive">
          {WHOP_OVER_LIMIT_MESSAGE}
        </p>
      )}

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <select
          name="interval"
          defaultValue={offering?.interval === 'MONTHLY' ? 'MONTHLY' : 'ONE_TIME'}
          disabled={isConsult}
          className="h-9 w-full rounded-md border bg-card px-2 text-sm outline-none ring-ring/30 focus-visible:ring-2 disabled:opacity-50"
        >
          <option value="ONE_TIME">One-time (flat fee)</option>
          <option value="MONTHLY">Monthly (subscription)</option>
        </select>
        <input
          type="text"
          name="category"
          list={`offering-cats-${idPrefix}`}
          defaultValue={offering?.category ?? ''}
          placeholder="Type (e.g. Consultation)"
          className="h-9 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
        />
        <div className="flex items-center gap-1.5 rounded-md border bg-card px-2">
          <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            type="number"
            name="duration"
            min={0}
            defaultValue={offering?.duration ?? ''}
            placeholder="Minutes"
            aria-label="Duration in minutes"
            className="h-9 w-full bg-transparent text-sm outline-none"
          />
        </div>
        <datalist id={`offering-cats-${idPrefix}`}>
          {CATEGORY_SUGGESTIONS.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>

      <textarea
        name="description"
        rows={2}
        defaultValue={offering?.description ?? ''}
        placeholder="Optional — what's included. For someone who has never heard of you, this is doing the work you'd do on a call."
        className="w-full rounded-md border bg-card px-3 py-2 text-sm outline-none ring-ring/30 focus-visible:ring-2"
      />

      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            name="isConsult"
            checked={isConsult}
            onChange={(e) => onConsultChange(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Free consultation</span>
            <span className="block text-muted-foreground">
              No price and no payment step — just a time in your calendar.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            name="acceptsPayments"
            checked={shownAcceptsPayments}
            disabled={paymentsLocked}
            onChange={(e) => setAcceptsPayments(e.target.checked)}
            className="mt-0.5 disabled:opacity-50"
          />
          <span className={paymentsLocked ? 'opacity-60' : undefined}>
            <span className="font-medium">Accept payments</span>
            <span className="block text-muted-foreground">
              {!isConsult && !whopConnected ? (
                <>
                  {/* A greyed checkbox with no path out is a dead end for the least technical
                      cohort — the tooltip must LINK to the connection flow, not merely explain
                      the disablement (§12). A BARE FRAGMENT, not an absolute path: this page IS
                      that URL, so a full href hard-navigates and discards every unsaved edit. */}
                  Connect Whop before this means anything.{' '}
                  <a
                    href="#payments"
                    className="font-medium underline underline-offset-2 hover:text-foreground"
                  >
                    Set up payments first →
                  </a>
                </>
              ) : notYetPublished ? (
                'Turns on by itself once you set up payments below — nothing to do here yet.'
              ) : (
                'On: checkout is live for this offering. Turn off to pause it without unpublishing.'
              )}
            </span>
          </span>
        </label>
        {paymentsLocked && <DisabledMirror name="acceptsPayments" checked={shownAcceptsPayments} />}

        <div className="space-y-1 pt-1">
          <label className="flex items-center gap-2 text-xs font-medium" htmlFor={`bl-${idPrefix}`}>
            <Link2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            Schedule with
          </label>
          <select
            id={`bl-${idPrefix}`}
            name="bookingLinkId"
            value={bookingLinkId}
            onChange={(e) => onBookingLinkChange(e.target.value)}
            className="h-9 w-full rounded-md border bg-card px-2 text-sm outline-none ring-ring/30 focus-visible:ring-2"
          >
            <option value="">None — no calendar step</option>
            {bookingLinks.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            name="showOnProfile"
            checked={effectiveShowOnProfile}
            disabled={visibilityLocked}
            onChange={(e) => setShowOnProfile(e.target.checked)}
            className="mt-0.5 disabled:opacity-50"
          />
          <span className={visibilityLocked ? 'opacity-60' : undefined}>
            <span className="font-medium">Show on profile</span>
            {/* §12's sentence is "Hidden offerings are still available to anyone who clicks the
                linked booking link." That is LOAD-BEARING — without it "hidden" reads as
                "switched off" — but it is not TRUE until the Booking Link chooser ships (§17.4b),
                so stating it now would tell the practitioner their offering is reachable
                somewhere it is not. Restore the spec wording verbatim with the chooser. */}
            <span className="block text-muted-foreground">
              Hidden offerings stay off your public profile. They become reachable through the
              linked booking link when the booking flow ships.
              {visibilityLocked && ' Choose a booking link above to be able to hide this.'}
            </span>
          </span>
        </label>
        {visibilityLocked && <DisabledMirror name="showOnProfile" checked={effectiveShowOnProfile} />}
      </div>
    </div>
  );
}
