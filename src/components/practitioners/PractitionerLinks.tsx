import { Calendar, FileText, Layers, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

type BookingLink = { label?: string | null; url: string };
type Props = { bookingLinks?: BookingLink[] };

// Blake's framing (5/15 meeting): Linktree-style "elements practitioners can move around"
// on their landing page. Booking is wired (Wedge 2B — practitioner-owned URLs, multiple).
// Offerings + invoice flows are gated on Wedge 2C (Whop for Platforms / Connected Accounts —
// invite-only API access pending operator outreach to sales@whop.com).
type LinkItem = {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  helper: string;
  href?: string;
};

export function PractitionerLinks({ bookingLinks = [] }: Props) {
  const bookingItems: LinkItem[] = bookingLinks.length
    ? bookingLinks.map((b) => ({
        icon: Calendar,
        label: b.label?.trim() || 'Book an intro consult',
        helper: hostHint(b.url),
        href: b.url,
      }))
    : [{ icon: Calendar, label: 'Book an intro consult', helper: '30-minute fit call' }];

  const items: LinkItem[] = [
    ...bookingItems,
    { icon: Layers, label: 'Browse offerings', helper: 'Programs, memberships, packages' },
    {
      icon: FileText,
      label: 'Request custom invoice',
      helper: 'For employer or HSA reimbursement',
    },
  ];

  return (
    <section aria-label="Links" className="space-y-2">
      {items.map(({ icon: Icon, label, helper, href }, i) => {
        const inner = (
          <>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
              <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{label}</p>
              <p className="truncate text-xs text-muted-foreground">{helper}</p>
            </div>
            {href ? (
              <ChevronRight
                className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            ) : (
              <Badge
                variant="outline"
                className="shrink-0 text-[10px] uppercase tracking-wider"
              >
                Coming soon
              </Badge>
            )}
          </>
        );

        if (href) {
          return (
            <a
              key={i}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent/40"
            >
              {inner}
            </a>
          );
        }

        return (
          <div
            key={i}
            className="group flex items-center gap-3 rounded-lg border bg-card p-3 opacity-70"
            aria-disabled
          >
            {inner}
          </div>
        );
      })}
    </section>
  );
}

function hostHint(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host;
  } catch {
    return 'Schedule a session';
  }
}
