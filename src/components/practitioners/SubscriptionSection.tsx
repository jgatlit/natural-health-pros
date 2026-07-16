import { CheckCircle2, Clock, CreditCard, ShieldCheck, Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

type Props = {
  status: 'NONE' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';
  /**
   * 90-day pilot clock (docs/superpowers/specs/2026-07-16-pilot-trial-design.md).
   * null = pre-trial (operator-seeded, never onboarded) — still listed, quiet.
   * future = trial running. past = expired. Set only by genuine onboarding.
   */
  trialEndsAt: Date | null;
  /** Admins are exempt from the trial clock and the paywall entirely — staff, not customers. */
  isAdmin: boolean;
  /**
   * isProfileComplete() — the OTHER half of the listing gate. isListed() is
   * `isProfileComplete() && (paying || trialing || admin)`, so billing state alone never
   * proves someone is visible. Without this the card claims "you appear in directory search"
   * to a practitioner whose incomplete-profile banner, on this same page, correctly tells
   * them they're hidden from it.
   */
  isComplete: boolean;
  /** Whop checkout URL for our $59/mo product; null until provisioned (Layer X wiring). */
  checkoutUrl: string | null;
  priceLabel: string;
};

/**
 * Layer X — the practitioner's platform-listing subscription (they pay us to be listed).
 * Listing state follows the 90-day trial clock, not the retired `comped` flag: `trialEndsAt`
 * null is pre-trial (still listed, kept quiet), a future date is a running trial (the $59/mo
 * anchor lives here so the trial doesn't read as "free"), a past date is expired (subscribe to
 * restore — nothing is ever deleted). ACTIVE keeps its existing copy; PAST_DUE stays listed
 * through Whop's dunning grace and must never say "delisted". Admins are exempt outright — no
 * countdown, no paywall CTA. Distinct from PaymentsSection, which is Layer Y (the practitioner
 * accepting payments from their own patients).
 *
 * Every claim about being *visible* is gated on `isComplete`, because this card only knows the
 * billing half of isListed(). Keep it that way: the profile-completeness banner on the same
 * page owns the visibility message, and two cards disagreeing on one screen destroys trust in
 * both.
 */
export function SubscriptionSection({
  status,
  trialEndsAt,
  isAdmin,
  isComplete,
  checkoutUrl,
  priceLabel,
}: Props) {
  const now = Date.now();

  let badge: React.ReactNode;
  let description: React.ReactNode;
  let showCta = false;
  let ctaLabel = `Subscribe · ${priceLabel}`;
  let disabledCtaLabel = 'Subscribe · Coming soon';

  // Billing entitles you to a listing; it doesn't produce one. When the profile is incomplete
  // the entitlement is real but unused, so this card states the entitlement and stays silent
  // about visibility — the completeness banner above it owns that message and the fix.
  const visible = isComplete;

  if (isAdmin) {
    badge = (
      <Badge variant="outline" className="gap-1 text-[10px] uppercase tracking-wider">
        <ShieldCheck className="h-3 w-3" aria-hidden />
        Admin
      </Badge>
    );
    description =
      "You're exempt from the listing subscription as an admin — no trial clock, no billing.";
  } else if (status === 'ACTIVE') {
    badge = (
      <Badge variant="default" className="gap-1 text-[10px] uppercase tracking-wider">
        <CheckCircle2 className="h-3 w-3" aria-hidden />
        Active
      </Badge>
    );
    description = visible
      ? `Your ${priceLabel} listing subscription is active — you appear in directory search.`
      : `Your ${priceLabel} listing subscription is active. Complete your profile above to appear in directory search.`;
  } else if (status === 'PAST_DUE') {
    badge = (
      <Badge variant="destructive" className="text-[10px] uppercase tracking-wider">
        Past due
      </Badge>
    );
    description = visible
      ? "Your payment is past due — you're still listed during Whop's grace period. Update your payment to keep your listing active."
      : 'Your payment is past due. Update your payment to keep your listing active.';
    showCta = true;
    ctaLabel = 'Update payment';
    disabledCtaLabel = 'Update payment · Coming soon';
  } else if (trialEndsAt === null) {
    badge = (
      <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
        {visible ? 'Listed' : 'Not listed'}
      </Badge>
    );
    description = visible
      ? 'Your profile is listed in the Natural Health Pros directory.'
      : 'Your listing is free — complete your profile above to appear in the directory.';
  } else if (trialEndsAt.getTime() > now) {
    const daysRemaining = Math.max(1, Math.ceil((trialEndsAt.getTime() - now) / 86_400_000));
    // timeZone pinned to UTC to match the warning email's date (see trial-sweep's warningCopy).
    // Both describe the same instant, so if one honours the runtime's local zone and the other
    // doesn't, a trial ending near UTC midnight gets two different dates — dashboard says the
    // 14th, the email says the 15th. Vercel's Node runtime is UTC today, which is exactly why
    // this would go unnoticed until it didn't.
    const trialEndsAtLabel = trialEndsAt.toLocaleDateString('en-US', {
      timeZone: 'UTC',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
    badge = (
      <Badge variant="secondary" className="gap-1 text-[10px] uppercase tracking-wider">
        <Sparkles className="h-3 w-3" aria-hidden />
        {daysRemaining} day{daysRemaining === 1 ? '' : 's'} left
      </Badge>
    );
    description = (
      <>
        Your 90-day pilot · <span className="font-semibold text-primary">{priceLabel} value</span> ·
        free until {trialEndsAtLabel}.
      </>
    );
    showCta = true;
  } else {
    badge = (
      <Badge variant="destructive" className="text-[10px] uppercase tracking-wider">
        Pilot ended
      </Badge>
    );
    description = visible
      ? "Your pilot ended — subscribe to return to the directory. Your profile and everything you've built are safe: nothing is ever deleted, and one click restores your listing."
      : "Your pilot ended — subscribe to rejoin the directory. Your profile and everything you've built are safe: nothing is ever deleted.";
    showCta = true;
  }

  return (
    <Card className="space-y-4 p-6 sm:p-8">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
          <CreditCard className="h-4 w-4 text-muted-foreground" aria-hidden />
        </span>
        <div className="flex-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Directory listing</h2>
            {badge}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
      </div>

      {showCta && (
        <>
          <Separator />
          {checkoutUrl ? (
            <a
              href={checkoutUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {ctaLabel}
            </a>
          ) : (
            <button
              type="button"
              disabled
              className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-md border bg-muted/40 text-sm font-medium text-muted-foreground"
            >
              <Clock className="h-3.5 w-3.5" aria-hidden />
              {disabledCtaLabel}
            </button>
          )}
        </>
      )}
    </Card>
  );
}
