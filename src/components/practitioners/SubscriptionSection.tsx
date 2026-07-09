import { CheckCircle2, Clock, CreditCard, Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

type Props = {
  status: 'NONE' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';
  comped: boolean;
  /** Whop checkout URL for our $59/mo product; null until provisioned (Layer X wiring). */
  checkoutUrl: string | null;
  priceLabel: string;
};

/**
 * Layer X — the practitioner's platform-listing subscription (they pay us to be listed).
 * Comped pilots are listed for free. When not active/comped, this shows the Subscribe CTA
 * (or "coming soon" until the Whop checkout URL is set). Distinct from PaymentsSection,
 * which is Layer Y (the practitioner accepting payments from their own patients).
 */
export function SubscriptionSection({ status, comped, checkoutUrl, priceLabel }: Props) {
  const listed = comped || status === 'ACTIVE';

  return (
    <Card className="space-y-4 p-6 sm:p-8">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
          <CreditCard className="h-4 w-4 text-muted-foreground" aria-hidden />
        </span>
        <div className="flex-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Directory listing</h2>
            {comped ? (
              <Badge variant="secondary" className="gap-1 text-[10px] uppercase tracking-wider">
                <Sparkles className="h-3 w-3" aria-hidden />
                Complimentary
              </Badge>
            ) : status === 'ACTIVE' ? (
              <Badge variant="default" className="gap-1 text-[10px] uppercase tracking-wider">
                <CheckCircle2 className="h-3 w-3" aria-hidden />
                Active
              </Badge>
            ) : status === 'PAST_DUE' ? (
              <Badge variant="destructive" className="text-[10px] uppercase tracking-wider">
                Past due
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                Not listed
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {comped
              ? 'Your listing is complimentary during the pilot — you appear in the directory at no charge.'
              : listed
                ? `Your ${priceLabel} listing subscription is active — you appear in directory search.`
                : `List your practice in the Natural Health Pros directory for ${priceLabel}. You appear in search once your profile is complete and subscribed.`}
          </p>
        </div>
      </div>

      {!comped && status !== 'ACTIVE' && (
        <>
          <Separator />
          {checkoutUrl ? (
            <a
              href={checkoutUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {status === 'PAST_DUE' ? 'Update payment' : `Subscribe · ${priceLabel}`}
            </a>
          ) : (
            <button
              type="button"
              disabled
              className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-md border bg-muted/40 text-sm font-medium text-muted-foreground"
            >
              <Clock className="h-3.5 w-3.5" aria-hidden />
              Subscribe · Coming soon
            </button>
          )}
        </>
      )}
    </Card>
  );
}
