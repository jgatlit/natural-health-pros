import { CheckCircle2, Clock, CreditCard, ShieldCheck, Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { PendingButton } from './PendingButton';

type Props = {
  status: 'NONE' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';
  /**
   * Is this Plan A practitioner asked to pay now? `planABillingOpen()`: always for someone who joined
   * through a cohort link, otherwise once the pilot clock has run out. The pilot clock itself is
   * managed on the BACKEND and deliberately never named on this screen (operator ruling 2026-09-28).
   */
  billingOpen: boolean;
  /** Joined through a cohort link: the two prices are labelled as the founding rate. */
  foundingRate: boolean;
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
  /** Which interval the active subscription was bought at, when the webhook could tell. */
  interval: 'monthly' | 'annual' | null;
  /**
   * PRIMARY path, one per interval. Each mints a per-practitioner checkout carrying
   * `metadata.practitioner_id`, so the webhook attributes the payment directly. Prefer these over
   * `fallbackCheckoutUrl` always.
   */
  monthlyAction: ((formData: FormData) => void | Promise<void>) | null;
  annualAction: ((formData: FormData) => void | Promise<void>) | null;
  /**
   * The generic hosted product page. LAST RESORT — it carries no practitioner metadata, so a
   * payment through it can only be matched back by EMAIL, which fails silently when someone pays
   * from a different address than their profile.
   */
  fallbackCheckoutUrl: string | null;
  /** "$29/mo", from the practitioner's rate schedule. */
  priceLabel: string;
  /** "$299/yr", derived from the same schedule. */
  annualPriceLabel: string;
  /** "Save $49 vs monthly", or null when the yearly price saves nothing. */
  annualSavingsLabel: string | null;
};

/**
 * Plan billing status — Layer X: what the practitioner pays US to be listed. Distinct from
 * PaymentsSection, which is Layer Y (the practitioner accepting payments from their own clients).
 *
 * PLAN-AWARE. Plan A is a monthly or annual subscription; Plan B has none. A card that always says
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
  billingOpen,
  foundingRate,
  isAdmin,
  isComplete,
  plan,
  interval,
  monthlyAction,
  annualAction,
  fallbackCheckoutUrl,
  priceLabel,
  annualPriceLabel,
  annualSavingsLabel,
}: Props) {
  let title = plan === 'PLAN_A' ? 'Plan A · Listing' : 'Plan B · No monthly fee';
  let badge: React.ReactNode;
  let description: React.ReactNode;
  let cta: 'none' | 'choose' | 'update' = 'none';
  const activeLabel = interval === 'annual' ? annualPriceLabel : priceLabel;
  const activeTitle = interval === 'annual' ? 'Annual listing' : 'Monthly listing';

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
    title = activeTitle;
    badge = (
      <Badge variant="default" className="gap-1 text-[10px] uppercase tracking-wider">
        <CheckCircle2 className="h-3 w-3" aria-hidden />
        Active
      </Badge>
    );
    description = visible
      ? `Your ${activeLabel} listing subscription is active — you appear in directory search.`
      : `Your ${activeLabel} listing subscription is active. Complete your profile above to appear in directory search.`;
  } else if (status === 'PAST_DUE') {
    title = activeTitle;
    badge = (
      <Badge variant="destructive" className="text-[10px] uppercase tracking-wider">
        Past due
      </Badge>
    );
    description = visible
      ? "Your payment is past due — you're still listed during Whop's grace period. Update your payment to keep your listing active."
      : 'Your payment is past due. Update your payment to keep your listing active.';
    cta = 'update';
  } else if (plan === 'PLAN_B') {
    // No subscription on Plan B, so nothing to start, renew or restore — and no CTA.
    badge = (
      <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">
        No monthly fee
      </Badge>
    );
    description =
      "You pay no monthly fee on Plan B. Natural Health Pros' share applies only to clients we send you.";
  } else if (!billingOpen) {
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
    badge = foundingRate ? (
      <Badge variant="secondary" className="gap-1 text-[10px] uppercase tracking-wider">
        <Sparkles className="h-3 w-3" aria-hidden />
        Founding rate
      </Badge>
    ) : (
      <Badge variant="destructive" className="text-[10px] uppercase tracking-wider">
        Subscribe
      </Badge>
    );
    description = foundingRate
      ? 'Choose monthly or annual billing for your Plan A listing. Your founding rate is below.'
      : "Your Plan A subscription isn't active. Subscribe to be listed in directory search. Your profile and everything you've built are safe: nothing is ever deleted.";
    cta = 'choose';
  }

  const buttonClass =
    'inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60';

  const checkoutButton = (
    action: Props['monthlyAction'],
    label: string,
    key: string,
  ): React.ReactNode =>
    action ? (
      <form key={key} action={action}>
        <PendingButton pendingLabel="Opening checkout…" className={buttonClass}>
          {label}
        </PendingButton>
      </form>
    ) : fallbackCheckoutUrl ? (
      <a key={key} href={fallbackCheckoutUrl} target="_blank" rel="noopener noreferrer" className={buttonClass}>
        {label}
      </a>
    ) : (
      <button
        key={key}
        type="button"
        disabled
        className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-md border bg-muted/40 text-sm font-medium text-muted-foreground"
      >
        <Clock className="h-3.5 w-3.5" aria-hidden />
        {label} · Coming soon
      </button>
    );

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

      {cta === 'choose' && (
        <>
          <Separator />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2 rounded-md border p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Monthly</p>
              <p className="text-lg font-semibold">{priceLabel}</p>
              {checkoutButton(monthlyAction, `Pay monthly · ${priceLabel}`, 'monthly')}
            </div>
            <div className="space-y-2 rounded-md border p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Annual</p>
              <p className="text-lg font-semibold">
                {annualPriceLabel}
                {annualSavingsLabel && (
                  <span className="ml-2 text-xs font-medium text-muted-foreground">{annualSavingsLabel}</span>
                )}
              </p>
              {checkoutButton(annualAction, `Pay annually · ${annualPriceLabel}`, 'annual')}
            </div>
          </div>
        </>
      )}

      {cta === 'update' && (
        <>
          <Separator />
          {checkoutButton(interval === 'annual' ? annualAction : monthlyAction, 'Update payment', 'update')}
        </>
      )}
    </Card>
  );
}
