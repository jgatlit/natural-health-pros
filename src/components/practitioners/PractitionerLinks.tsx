import { Calendar, FileText, Layers, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

type LinkItem = {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  helper: string;
  disabled?: boolean;
};

// Blake's framing (5/15 meeting): Linktree-style "elements practitioners can move around"
// on their landing page. Phase 1 ships the layout; CTAs are placeholders until
// booking + payments wedges (Block C+/Phase 2) land.
const LINKS: LinkItem[] = [
  {
    icon: Calendar,
    label: 'Book an intro consult',
    helper: '30-minute fit call',
    disabled: true,
  },
  {
    icon: Layers,
    label: 'Browse offerings',
    helper: 'Programs, memberships, packages',
    disabled: true,
  },
  {
    icon: FileText,
    label: 'Request custom invoice',
    helper: 'For employer or HSA reimbursement',
    disabled: true,
  },
];

export function PractitionerLinks() {
  return (
    <section aria-label="Links" className="space-y-2">
      {LINKS.map(({ icon: Icon, label, helper, disabled }) => (
        <div
          key={label}
          className="group flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent/40 aria-disabled:cursor-not-allowed aria-disabled:opacity-70"
          aria-disabled={disabled}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{label}</p>
            <p className="truncate text-xs text-muted-foreground">{helper}</p>
          </div>
          {disabled ? (
            <Badge variant="outline" className="shrink-0 text-[10px] uppercase tracking-wider">
              Coming soon
            </Badge>
          ) : (
            <ChevronRight
              className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
              aria-hidden
            />
          )}
        </div>
      ))}
    </section>
  );
}
