import { Calendar, Globe, Layers, FileText, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

type BookingLink = { label?: string | null; url: string };
type Props = {
  bookingLinks?: BookingLink[];
  websiteUrl?: string | null;
  /** First-session price in cents — rendered inside the primary booking CTA when present. */
  firstSessionPriceCents?: number | null;
};

function hostHint(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Open link';
  }
}

/** cents → "$X" (whole) or "$X.XX" (fractional). */
function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/**
 * Rich-landing-page action block. Booking is live (Wedge 2B — practitioner-owned URLs).
 * Website is the classified col-D external link. Offerings + invoice stay "coming soon"
 * (Wedge 2C — Whop for Platforms, invite-only API pending). Booking = checkout pairing
 * (Amy 5/28) lands when Whop access does. All token-driven.
 */
export function PractitionerCTAs({ bookingLinks = [], websiteUrl, firstSessionPriceCents }: Props) {
  const primaryBooking = bookingLinks[0];
  const moreBookings = bookingLinks.slice(1);
  const hasFirstSessionPrice = firstSessionPriceCents != null && firstSessionPriceCents > 0;

  return (
    <section aria-label="Book & connect" className="space-y-3">
      {primaryBooking ? (
        <a
          href={primaryBooking.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-3 rounded-lg bg-cta p-4 text-cta-foreground transition-opacity hover:opacity-90"
        >
          <Calendar className="h-5 w-5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {primaryBooking.label?.trim() || 'Book a session'}
            </p>
            <p className="truncate text-xs opacity-80">
              {hasFirstSessionPrice
                ? `First session: ${formatPrice(firstSessionPriceCents!)}`
                : hostHint(primaryBooking.url)}
            </p>
          </div>
          <ChevronRight
            className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        </a>
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

      {moreBookings.map((b) => (
        <a
          key={b.url}
          href={b.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent/40"
        >
          <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{b.label?.trim() || 'Book a session'}</p>
            <p className="truncate text-xs text-muted-foreground">{hostHint(b.url)}</p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        </a>
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

      {[
        { icon: Layers, label: 'Browse offerings', helper: 'Programs, memberships, packages' },
        { icon: FileText, label: 'Request invoice', helper: 'For employer or HSA reimbursement' },
      ].map(({ icon: Icon, label, helper }) => (
        <div
          key={label}
          className="flex items-center gap-3 rounded-lg border bg-card p-3 opacity-60"
          aria-disabled
        >
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{label}</p>
            <p className="truncate text-xs text-muted-foreground">{helper}</p>
          </div>
          <Badge variant="outline" className="shrink-0 text-[10px] uppercase tracking-wider">
            Coming soon
          </Badge>
        </div>
      ))}
    </section>
  );
}
