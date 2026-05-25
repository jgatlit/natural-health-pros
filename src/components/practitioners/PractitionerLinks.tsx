import { Calendar, FileText, Layers, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

type Props = { bookingUrl?: string | null; paymentUrl?: string | null };

// Blake's framing (5/15 meeting): Linktree-style "elements practitioners can move around"
// on their landing page. Booking + payment are wired (Wedges 2B + 2C — practitioner-owned
// URLs). Custom-invoice flow stays placeholder (Phase 2.5 server-action that emails admin).
export function PractitionerLinks({ bookingUrl, paymentUrl }: Props) {
  const items: Array<{
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    helper: string;
    href?: string;
  }> = [
    {
      icon: Calendar,
      label: 'Book an intro consult',
      helper: bookingUrl ? hostHint(bookingUrl) : '30-minute fit call',
      href: bookingUrl ?? undefined,
    },
    {
      icon: Layers,
      label: 'Browse offerings',
      helper: paymentUrl ? hostHint(paymentUrl) : 'Programs, memberships, packages',
      href: paymentUrl ?? undefined,
    },
    {
      icon: FileText,
      label: 'Request custom invoice',
      helper: 'For employer or HSA reimbursement',
    },
  ];

  return (
    <section aria-label="Links" className="space-y-2">
      {items.map(({ icon: Icon, label, helper, href }) => {
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
              key={label}
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
            key={label}
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
