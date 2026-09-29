import { CheckCircle2, Clock, CreditCard, ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { PendingButton } from './PendingButton';

type Props = {
  status: 'NONE' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';
  /**
   * The pilot clock. Managed on the BACKEND and deliberately never named on this screen (operator
   * ruling 2026-09-28: "we will manage the 90-day pilot on the backend; no need to author/publish").
   * Only its state is read: null or a future date means billing has not started; a past date means
   * a Plan A practitioner now needs to subscribe.
   */
  trialEndsAt: Date | null;
  /** Admins are exempt from billing entirely — staff, not customers. */
  isAdmin: boolean;
  /**
   * isProfileComplete() — the other half of the listing gate. Billing state alone never proves
   * someone is visible, so any claim about directory search is gated on this.
   */
  isComplete: boolean;
  /**
   * The plan this practitioner is on, AFTER the default is applied (`effectivePlan`). Plan B has no
   * subscription, so it must never be shown a "subscribe" prompt — that was the contradiction this
   * card had while it still spoke only in terms of the pilot.
   */
  plan: 'PLAN_A' | 'PLAN_B';
  /**
   * PRIMARY path. Mints a per-practitioner checkout carrying `metadata.practitioner_id`, so the
   * webhook attributes the payment directly. Prefer this over `fallbackCheckoutUrl` always.
   */
  subscribeAction: ((formData: FormData) => void | Promise<void>) | null;
  /**
   * The generic hosted product page. LAST RESORT — it carries no practitioner metadata, so a
   * payment through it can only be matched back by EMAIL, which fails silently when someone pays
   * from a different address than their profile.
   */
  fallbackCheckoutUrl: string | null;
  priceLabel: string;
};

/**
 * Plan billing status — Layer X: what the practitioner pays US to be listed. Distinct from
 * PaymentsSection, which is Layer Y (the practitioner accepting payments from their own clients).
 *
 * PLAN-AWARE. Plan A is a monthly subscription; Plan B has none. A card that always says
 * "Premium Accounts & Directory Listing … subscribe to return" tells a Plan B practitioner they owe
 * something they do not. An ACTIVE or PAST_DUE subscription is shown whatever the plan, because
 * money is moving and hiding that would be worse than a plan label that disagrees.
 *
 * Every claim about being *visible* is gated on `isComplete`; the profile-completeness banner on
 * the same page owns the visibility message, and two cards disagreeing on one screen destroys
 * trust in both. PAST_DUE stays listed through Whop's dunning grace and must never say "delisted".
 */
export function SubscriptionSection({
  status,
  trialEndsAt,
  isAdmin,
  isComplete,
  plan,
  subscribeAction,
  fallbackCheckoutUrl,
  priceLabel,
}: Props) {
  const now = Date.now();

  let title = plan === 'PLAN_A' ? 'Plan A · Monthly listing' : 'Plan B · No monthly fee';
  let badge: React.ReactNode;
  let description: React.ReactNode;
  let showCta = false;
  let ctaLabel = `Subscribe · ${priceLabel}`;
  let disabledCtaLabel = 'Subscribe · Coming soon';

  // Billing entitles you to a listing; it doesn't produce one. When the profile is incomplete the
  // entitlement is real but unused, so this card states it and stays silent about visibility.
  const visible = isComplete;

  if (isAdmin) {
    title = 'Listing';
    badge = (
      <Badge variant="outline" className="gap-1 text-[10px] uppercase tracking-wider">
        <ShieldCheck className="h-3 w-3" aria-hidden />
        Admin
      </Badge>
    );
    description = "You're exempt from the listing subscription as an admin — no billing.";
  } else if (status === 'ACTIVE') {
    title = 'Monthly listing';
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
    title = 'Monthly listing';
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
  } else if (plan === 'PLAN_B') {
    // No subscription on Plan B, so nothing to start, renew or restore — and no CTA.
    badge = (
      <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">
        No monthly fee
      </Badge>
    );
    description =
      "You pay no monthly fee on Plan B. Natural Health Pros' share applies only to clients we send you.";
  } else if (trialEndsAt === null || trialEndsAt.getTime() > now) {
    badge = (
      <Badge variant="outline" className="gap-1 text-[10px] uppercase tracking-wider">
        <Clock className="h-3 w-3" aria-hidden />
        Not billing yet
      </Badge>
    );
    // "Billing hasn't started" is the one question every practitioner asks first, and Sarah
    // Schindler flagged having to explain it aloud each time. It states the fact and the promise;
    // how the start date is arrived at is managed on the backend and is not authored here.
    description = `Billing hasn't started for Plan A (${priceLabel}). You'll be told before it does.`;
  } else {
    badge = (
      <Badge variant="destructive" className="text-[10px] uppercase tracking-wider">
        Subscribe
      </Badge>
    );
    description =
      "Your Plan A subscription isn't active. Subscribe to be listed in directory search. Your profile and everything you've built are safe: nothing is ever deleted.";
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
            <h2 className="text-sm font-semibold">{title}</h2>
            {badge}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
      </div>

      {showCta && (
        <>
          <Separator />
          {subscribeAction ? (
            <form action={subscribeAction}>
              <PendingButton
                pendingLabel="Opening checkout…"
                className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
              >
                {ctaLabel}
              </PendingButton>
            </form>
          ) : fallbackCheckoutUrl ? (
            <a
              href={fallbackCheckoutUrl}
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
