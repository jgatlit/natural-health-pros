import { AlertTriangle, CheckCircle2, Clock, CreditCard, Info } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { PendingButton } from './PendingButton';

type Action = (formData: FormData) => void | Promise<void>;

type Props = {
  slug: string;
  /** Whop's connected-company id under WHOP_PARENT_COMPANY_ID; null until onboarding starts. */
  whopCompanyId: string | null;
  /** Whop's calculated payout status (see WhopPayoutStatus in lib/whop.ts). Deliberately typed
   *  as a raw string here too — the DB column is a String, not an enum, so an unrecognised
   *  status must fall through to a safe default rather than fail a type check. */
  payoutStatus: string;
  /** THE gate for public checkout — authoritative only via Whop's identity_profile webhooks. */
  payoutsEnabled: boolean;
  platformReady: boolean;
  /** `?whop=pending|error` — set by the onboarding return/refresh routes and the actions below
   *  when they redirect back here. edit/page.tsx reads it off searchParams exactly like its
   *  existing ?saved=/?error= banners and passes it straight through. */
  whopParam?: string;
  startWhopOnboardingAction: Action;
  openPayoutPortalAction: Action;
};

/**
 * Layer Y — the practitioner's connected-account surface: they get paid BY their own patients.
 * Distinct from SubscriptionSection, which is Layer X (they pay US to be listed). Never blur
 * the two — different money, different direction, different Whop object underneath.
 */
export function PaymentsSection({
  slug,
  whopCompanyId,
  payoutStatus,
  payoutsEnabled,
  platformReady,
  whopParam,
  startWhopOnboardingAction,
  openPayoutPortalAction,
}: Props) {
  let badge: React.ReactNode;
  let description: React.ReactNode;
  let cta: React.ReactNode;

  if (!platformReady) {
    badge = (
      <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
        Coming soon
      </Badge>
    );
    // Copy corrected 2026-08-12. This previously read "Whop Platforms access is pending on our
    // side… once granted", which restated the invite-only-API claim CLAUDE.md documents as a
    // context error — Connected Accounts is self-serve. Saying "pending approval" to a
    // practitioner describes a future state that does not exist, which is exactly the class of
    // inaccuracy flagged on the 2026-08-11 call.
    description =
      "Direct client payments aren't switched on yet — we're still wiring this up. Your directory listing above isn't affected.";
    cta = (
      <button
        type="button"
        disabled
        className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-md border bg-muted/40 text-sm font-medium text-muted-foreground"
      >
        <Clock className="h-3.5 w-3.5" aria-hidden />
        Set up payments · Coming soon
      </button>
    );
  } else if (!whopCompanyId) {
    badge = (
      <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
        Not connected
      </Badge>
    );
    description =
      "Accept payments directly from your clients. Whop verifies your identity and handles payouts — funds go straight to your own account, never through us.";
    // The ID requirement is surfaced BEFORE the button, not discovered inside the flow. Sarah
    // Schindler hit the identity check mid-call on 2026-08-11 and had to leave to find her
    // licence: "letting them know that you're gonna need your ID… have a driver's license or
    // passport handy. Because people —" It is the single cheapest drop-off fix in onboarding.
    cta = (
      <form action={startWhopOnboardingAction} className="space-y-2">
        <div className="flex items-start gap-2 rounded-md border border-primary/20 bg-primary/5 p-3 text-xs">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          <span>
            <span className="font-medium">Have your ID ready.</span> Whop asks for a driver&apos;s
            license or passport to verify you. It takes about five minutes.
          </span>
        </div>
        <PendingButton
          ariaLabel={`Set up payments and verify ID for ${slug}`}
          pendingLabel="Opening Whop…"
          className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          Set up payments &amp; verify ID
        </PendingButton>
      </form>
    );
  } else if (!payoutsEnabled) {
    const copy = verificationCopy(payoutStatus);
    badge = <ToneBadge tone={copy.tone} label={copy.badgeLabel} />;
    description = (
      <>
        <span className="font-medium text-foreground">{copy.lead}</span> {copy.body}
      </>
    );
    cta = (
      <form action={startWhopOnboardingAction}>
        <PendingButton
          ariaLabel={`Continue payments verification for ${slug}`}
          pendingLabel="Opening Whop…"
          className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          Continue verification
        </PendingButton>
      </form>
    );
  } else {
    badge = (
      <Badge variant="default" className="gap-1 text-[10px] uppercase tracking-wider">
        <CheckCircle2 className="h-3 w-3" aria-hidden />
        Active
      </Badge>
    );
    description =
      'Your payout account is active — you can take payments and publish offerings to patients.';
    cta = (
      <div className="space-y-2">
        <form action={openPayoutPortalAction}>
          <PendingButton
            ariaLabel={`Manage payouts for ${slug}`}
            pendingLabel="Opening payout portal…"
            className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-md border bg-card text-sm font-medium transition-colors hover:bg-accent disabled:opacity-60"
          >
            Manage payouts
          </PendingButton>
        </form>
        {/* Whop's accountLinks API only mints scoped links for `account_onboarding` and
            `payouts_portal` — there is no scoped use_case for the general account settings a
            practitioner actually needs here (tax collection, payment methods, statement
            descriptor). Confirmed live on the 2026-09-03 call: Jonathan had to navigate to
            whop.com directly to demo tax settings; Sarah's own "Manage payouts" link showed only
            withdraw/bank-account options. So this is a plain external link to Whop's own login,
            not an auto-authenticated deep link — labelled honestly rather than implying the same
            one-click handoff "Manage payouts" gives. */}
        <a
          href="https://whop.com"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-dashed bg-card text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Manage your Whop account
        </a>
        <p className="text-[11px] text-muted-foreground">
          Tax settings, payment methods, and more — opens whop.com directly, sign in with your own
          Whop login.
        </p>
      </div>
    );
  }

  return (
    <Card id="payments" className="scroll-mt-8 space-y-4 p-6 sm:p-8">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
          <CreditCard className="h-4 w-4 text-muted-foreground" aria-hidden />
        </span>
        <div className="flex-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Client payments</h2>
            {badge}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
      </div>

      {whopParam === 'pending' && (
        <div className="flex items-start gap-2 rounded-md border border-primary/20 bg-primary/5 p-3 text-xs">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          <span>Verification submitted — we&apos;ll update this as soon as Whop confirms.</span>
        </div>
      )}
      {whopParam === 'error' && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-400"
            aria-hidden
          />
          <span>That link had a hiccup — nothing was lost. Try again below.</span>
        </div>
      )}

      <Separator />

      {cta}
    </Card>
  );
}

type VerificationTone = 'neutral' | 'attention' | 'failed';

/**
 * Maps Whop's calculated payout status to copy + tone for the "connected but not yet payable"
 * state. `connected` is deliberately its own case: paired with payoutsEnabled === false (the
 * only way this function gets called) it means an ACTIVE RESTRICTION on an otherwise-verified
 * account, not incomplete setup — the state most likely to confuse someone, so it gets its own
 * sentence instead of folding into the generic "in progress" copy.
 */
function verificationCopy(payoutStatus: string): {
  badgeLabel: string;
  tone: VerificationTone;
  lead: string;
  body: string;
} {
  switch (payoutStatus) {
    case 'not_started':
    case 'pending_verification':
      return {
        badgeLabel: 'Verifying',
        tone: 'neutral',
        lead: 'Verification in progress.',
        body: "Whop is reviewing your account. This typically takes 1–2 business days — you'll get an email when it's done, and this page updates automatically.",
      };
    case 'action_required':
    case 'manual_review':
      return {
        badgeLabel: 'Action needed',
        tone: 'attention',
        lead: 'Whop needs more information from you.',
        body: 'Verification is paused until you provide a few more details. Continue below to pick up where you left off.',
      };
    case 'verification_failed':
    case 'denied':
    case 'disabled':
      return {
        badgeLabel: 'Failed',
        tone: 'failed',
        lead: "Verification didn't go through.",
        body: 'Whop was unable to verify this account. Start again below, or contact us if this keeps happening.',
      };
    case 'connected':
      return {
        badgeLabel: 'Restricted',
        tone: 'failed',
        lead: 'Your account is connected but restricted.',
        body: "Whop verified this account but has restricted payouts on it — this isn't an incomplete setup. Continue below to see what Whop needs to lift it.",
      };
    case 'blocked_by_parent':
      return {
        badgeLabel: 'Restricted',
        tone: 'failed',
        lead: 'Payouts are blocked on this account.',
        body: 'Continue below to see what Whop needs, or contact us if this keeps happening.',
      };
    default:
      // whopPayoutStatus is a raw String column so an unrecognised value from Whop can't throw
      // — fall back to the same neutral copy as "in progress" rather than a dead end.
      return {
        badgeLabel: 'Verifying',
        tone: 'neutral',
        lead: 'Verification in progress.',
        body: "Whop is setting up your account. Check back shortly, or continue below to pick up where you left off.",
      };
  }
}

function ToneBadge({ tone, label }: { tone: VerificationTone; label: string }) {
  if (tone === 'failed') {
    return (
      <Badge variant="destructive" className="text-[10px] uppercase tracking-wider">
        {label}
      </Badge>
    );
  }
  if (tone === 'attention') {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/40 text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400"
      >
        {label}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">
      {label}
    </Badge>
  );
}
