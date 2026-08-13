/**
 * Whop v1 client — Connected Accounts (Layer Y) + per-practitioner subscription checkout (Layer X).
 *
 * Architecture + validated API shapes: docs/PHASE-2C-WHOP-CONNECTED-ACCOUNTS.md
 *
 * Two independent money paths share this one client:
 *   Layer X  practitioner → us    billed on OUR company    (they're a member)
 *   Layer Y  patient → practitioner  billed on THEIR company (they're a connected account)
 */

import Whop from '@whop/sdk';
import { SITE_URL } from '@/lib/site';

export class WhopNotConfigured extends Error {
  constructor(action: string) {
    super(
      `Whop is not configured — cannot ${action}. ` +
        'Requires WHOP_COMPANY_API_KEY (a COMPANY API key on the parent company, not an app key) ' +
        'and WHOP_PARENT_COMPANY_ID. See docs/PHASE-2C-WHOP-CONNECTED-ACCOUNTS.md §6.',
    );
    this.name = 'WhopNotConfigured';
  }
}

/** Whop's calculated payout-readiness statuses. Stored as a String column, never a DB enum —
 *  an unmapped value from Whop must not throw inside a webhook handler and poison the retry. */
export type WhopPayoutStatus =
  | 'not_started'
  | 'pending_verification'
  | 'action_required'
  | 'manual_review'
  | 'connected'
  | 'disabled'
  | 'verification_failed'
  | 'denied'
  | 'blocked_by_parent';

const WHOP_CHECKOUT_ORIGIN = 'https://whop.com';

export function isWhopPlatformsReady(): boolean {
  return !!process.env.WHOP_COMPANY_API_KEY && !!process.env.WHOP_PARENT_COMPANY_ID;
}

let cached: Whop | null = null;

function client(action: string): Whop {
  if (!isWhopPlatformsReady()) throw new WhopNotConfigured(action);
  if (!cached) {
    cached = new Whop({
      apiKey: process.env.WHOP_COMPANY_API_KEY,
      // Standard Webhooks expects the secret base64-encoded.
      webhookKey: process.env.WHOP_V1_WEBHOOK_SECRET
        ? Buffer.from(process.env.WHOP_V1_WEBHOOK_SECRET).toString('base64')
        : undefined,
      ...(process.env.WHOP_API_BASE ? { baseURL: process.env.WHOP_API_BASE } : {}),
    });
  }
  return cached;
}

/**
 * Raw v1 POST, used ONLY for checkout-configuration creation.
 *
 * `@whop/sdk@0.0.42` is generated from an older OpenAPI snapshot than the published docs: its
 * checkout-config params have no `application_fee_amount` and no inline `product`, and name the
 * company field `account_id` where the docs (and Whop's own support guidance, 2026-07-28) say
 * `company_id`. Since a future platform fee is a stated requirement, this one call is issued
 * against the documented contract instead of the stale generated type.
 *
 * ⚠️ VERIFY ON FIRST LIVE CALL. If Whop 400s on `company_id`, retry with `account_id` — that is
 * the single most likely failure in this integration, and it cannot be checked without a
 * scoped Company API key.
 */
async function whopPost<T>(path: string, body: unknown, action: string): Promise<T> {
  if (!isWhopPlatformsReady()) throw new WhopNotConfigured(action);
  const base = process.env.WHOP_API_BASE ?? 'https://api.whop.com/api/v1';
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHOP_COMPANY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Whop ${path} failed (${res.status}): ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as T;
}

/**
 * Live API returns `purchase_url` absolute (`https://whop.com/checkout/plan_x/?session=ch_…`,
 * verified 2026-07-29) even though the published docs show it relative. Normalise both.
 */
function absoluteCheckoutUrl(purchaseUrl: string | null | undefined): string | null {
  if (!purchaseUrl) return null;
  return purchaseUrl.startsWith('http') ? purchaseUrl : `${WHOP_CHECKOUT_ORIGIN}${purchaseUrl}`;
}

// SITE_URL, not an env read: NEXT_PUBLIC_BASE_URL is deliberately UNSET on Vercel, so
// `process.env.X ?? fallback` would not be a fallback — it would silently BE the value.
// Every URL here is handed to Whop and comes back as a user-facing redirect, so it has to be
// the apex domain rather than a deployment alias. See src/lib/site.ts.
function baseUrl(): string {
  return SITE_URL;
}

// ──────────────────────────────────────────────────────────────────────────────
// Layer X — practitioner pays us to be listed
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Per-practitioner checkout for the existing monthly listing plan.
 *
 * Reuses WHOP_SUBSCRIPTION_PLAN_ID rather than creating pricing, so the price lives in exactly
 * one place (the Whop dashboard) and can never drift. The point of this over the generic hosted
 * product page is `metadata.practitioner_id`: it lets the webhook attribute the payment directly
 * instead of matching on email, which silently fails when someone pays from a different address.
 */
export async function createSubscriptionCheckout(params: {
  practitionerId: string;
  slug: string;
}): Promise<{ checkoutConfigId: string; purchaseUrl: string }> {
  const planId = process.env.WHOP_SUBSCRIPTION_PLAN_ID;
  if (!planId) throw new WhopNotConfigured('create subscription checkout (WHOP_SUBSCRIPTION_PLAN_ID unset)');

  const cfg = await client('create subscription checkout').checkoutConfigurations.create({
    mode: 'payment',
    plan_id: planId,
    metadata: { practitioner_id: params.practitionerId },
    redirect_url: `${baseUrl()}/practitioners/${params.slug}/edit?subscription=success`,
  });

  const purchaseUrl = absoluteCheckoutUrl(cfg.purchase_url);
  if (!purchaseUrl) throw new Error('Whop returned a checkout configuration with no purchase_url');
  return { checkoutConfigId: cfg.id, purchaseUrl };
}

// ──────────────────────────────────────────────────────────────────────────────
// Layer Y — connected account lifecycle
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Create the practitioner's connected account under our platform company.
 *
 * NOT idempotent — Whop will happily mint a second company. Callers must guard on
 * Practitioner.whopCompanyId inside the same transaction that persists the result.
 */
export async function createConnectedAccount(params: {
  practitionerId: string;
  slug: string;
  displayName: string;
  email: string;
}): Promise<{ companyId: string }> {
  const company = await client('create connected account').companies.create({
    title: params.displayName,
    email: params.email,
    parent_company_id: process.env.WHOP_PARENT_COMPANY_ID!,
    country: 'us',
    // Whop sends patient receipts on the practitioner's behalf, so we build no transactional email.
    send_customer_emails: true,
    metadata: { practitioner_id: params.practitionerId, slug: params.slug },
  });
  return { companyId: company.id };
}

/**
 * Mint a hosted Whop link — KYC onboarding, or the ongoing payouts portal.
 * Links are short-lived; mint on demand and never persist one.
 */
export async function createAccountLink(params: {
  companyId: string;
  slug: string;
  useCase: 'account_onboarding' | 'payouts_portal';
}): Promise<{ url: string }> {
  const link = await client('create account link').accountLinks.create({
    company_id: params.companyId,
    use_case: params.useCase,
    return_url: `${baseUrl()}/api/whop/onboarding/return?slug=${encodeURIComponent(params.slug)}`,
    refresh_url: `${baseUrl()}/api/whop/onboarding/refresh?slug=${encodeURIComponent(params.slug)}`,
  });
  return { url: link.url };
}

/**
 * Reconciliation read for payout readiness.
 *
 * ⚠️ Takes the `poact_…` PAYOUT ACCOUNT id, not the company id.
 *
 * This previously took a companyId, and the 404 branch below explained it away as "a company
 * with no payout account yet — the normal pre-KYC state, verified against the platform company
 * 2026-07-29". That verification was run against a company that genuinely had no payout account,
 * so it could not distinguish "none exists" from "wrong id type". Confirmed live 2026-08-13:
 * `GET /payout_accounts/biz_8RDm3wyLlTRUPy` 404s while `GET /payout_accounts/poact_RdNctOwjkAMu`
 * returns 200 `connected` — for the SAME account. Every call this function ever made 404'd, so
 * the dropped-webhook reconciliation silently reported "nothing to see" for every practitioner.
 */
export async function getPayoutStatus(
  payoutAccountId: string,
): Promise<{ status: WhopPayoutStatus | null }> {
  try {
    const account = await client('read payout status').payoutAccounts.retrieve(payoutAccountId);
    return { status: (account.status as WhopPayoutStatus | null) ?? null };
  } catch (e) {
    // Now an honest 404: with a correct poact_ id, not-found really does mean no such account.
    if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 404) {
      return { status: null };
    }
    throw e;
  }
}

/** What GET /identity_profiles/{id} actually returns for the fields that gate payouts. */
export type WhopIdentityProfile = {
  /** Identity-verification outcome. `approved` is THE signal that KYC is complete. */
  status: string | null;
  payoutStatus: WhopPayoutStatus | null;
  payoutsEnabled: boolean | null;
};

/**
 * Read the identity profile — the only endpoint that exposes all three payout-gating fields at
 * once (`status`, `payout_status`, `payouts_enabled`).
 *
 * Rebased onto `status: 'approved'` deliberately. There is no usable "verified" signal to key
 * off: the company object's `verified` boolean reads false for every company we own, including
 * the platform company that has been live since June — it is the Whop marketplace badge, not a
 * payout gate. `status: 'approved'` is the field that actually reflects a completed ID check.
 *
 * ⚠️ `payouts_enabled` read here may under-report. `linked_companies` demonstrably reads back
 * empty for parent-company API keys while arriving populated on the webhook for the same
 * profile, so parent-key reads are known to omit fields. Treat a `false` from this endpoint as
 * "unconfirmed", never as authority to REVOKE a gate the webhook has opened.
 */
export async function getIdentityProfile(profileId: string): Promise<WhopIdentityProfile | null> {
  const base = process.env.WHOP_API_BASE ?? 'https://api.whop.com/api/v1';
  if (!isWhopPlatformsReady()) throw new WhopNotConfigured('read identity profile');

  const res = await fetch(`${base}/identity_profiles/${encodeURIComponent(profileId)}`, {
    headers: { Authorization: `Bearer ${process.env.WHOP_COMPANY_API_KEY}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Whop identity_profiles/${profileId} failed (${res.status})`);
  }
  const body = (await res.json()) as {
    status?: unknown;
    payout_status?: unknown;
    payouts_enabled?: unknown;
  };
  return {
    status: typeof body.status === 'string' ? body.status : null,
    payoutStatus:
      typeof body.payout_status === 'string' ? (body.payout_status as WhopPayoutStatus) : null,
    payoutsEnabled: typeof body.payouts_enabled === 'boolean' ? body.payouts_enabled : null,
  };
}

/** List our connected accounts — the roster behind /admin/connected-accounts. */
export async function listConnectedAccounts(): Promise<
  Array<{ id: string; title: string; metadata: Record<string, unknown> | null }>
> {
  const page = await client('list connected accounts').companies.list({
    parent_company_id: process.env.WHOP_PARENT_COMPANY_ID!,
  });
  return (page.data ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    metadata: (c.metadata as Record<string, unknown> | null) ?? null,
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Layer Y — offerings
// ──────────────────────────────────────────────────────────────────────────────

export type OfferingInterval = 'ONE_TIME' | 'MONTHLY' | 'ANNUAL';

/**
 * Whop's product title cap — verified live 2026-07-29 (a 84-char title 422'd with exactly this
 * message). publishOffering() checks this BEFORE calling Whop so a long title fails with a
 * specific, actionable redirect instead of the generic Whop-error catch-all.
 */
export const WHOP_OFFERING_TITLE_MAX = 80;

/**
 * Publish an offering as a Whop checkout on the practitioner's connected account.
 *
 * One call creates product + plan + checkout configuration. Treat the result as derived and
 * disposable: on any price/title edit, create a fresh configuration and swap the URL rather than
 * mutating the plan — that stays correct if a platform fee is ever switched on, since the fee is
 * a flat amount that has to be recomputed against the new price anyway.
 *
 * applicationFeeCents is plumbed but 0 today (operator decision 2026-07-29: revenue is the monthly
 * subscription). 0 must OMIT the field — Whop rejects the fee unless positive when present.
 *
 * plan.title is DELIBERATELY OMITTED — Whop caps it at 30 chars (verified live 2026-07-29; a
 * 34-char title 400'd the ENTIRE checkout-configuration create, so the whole publish failed
 * silently for any offering with a title over 30 characters — plausible for real practitioner
 * copy, e.g. "Business Process Automation Audit"). plan.title is not customer-facing: the real
 * Layer X plan (plan_5YdWsNzoCg3Z3) ships with title:null and relies on product.title for
 * display, and omitting it here was confirmed live to succeed with the exact title that
 * previously failed. product.title carries the real name to the buyer and caps at 80 chars
 * (also verified live) — see WHOP_OFFERING_TITLE_MAX above.
 */
export async function createOfferingCheckout(params: {
  companyId: string;
  offeringId: string;
  practitionerId: string;
  slug: string;
  title: string;
  priceUsdCents: number;
  interval: OfferingInterval;
  applicationFeeCents?: number;
}): Promise<{ checkoutConfigId: string; planId: string | null; purchaseUrl: string }> {
  const recurring = params.interval !== 'ONE_TIME';
  const price = params.priceUsdCents / 100;
  const fee = params.applicationFeeCents ?? 0;

  const cfg = await whopPost<{
    id: string;
    plan?: { id?: string | null } | null;
    purchase_url?: string | null;
  }>(
    '/checkout_configurations',
    {
      mode: 'payment',
      plan: {
        company_id: params.companyId,
        currency: 'usd',
        plan_type: recurring ? 'renewal' : 'one_time',
        initial_price: price,
        ...(recurring && {
          renewal_price: price,
          billing_period: params.interval === 'MONTHLY' ? 30 : 365,
        }),
        // 0 must OMIT the field — Whop rejects a non-positive fee rather than treating it as free.
        ...(fee > 0 && { application_fee_amount: fee / 100 }),
        product: { title: params.title, external_identifier: params.offeringId },
      },
      metadata: { practitioner_id: params.practitionerId, offering_id: params.offeringId },
      redirect_url: `${baseUrl()}/practitioners/${params.slug}?purchase=success`,
    },
    'publish offering',
  );

  const purchaseUrl = absoluteCheckoutUrl(cfg.purchase_url);
  if (!purchaseUrl) throw new Error('Whop returned a checkout configuration with no purchase_url');
  return { checkoutConfigId: cfg.id, planId: cfg.plan?.id ?? null, purchaseUrl };
}

// ──────────────────────────────────────────────────────────────────────────────
// Webhooks
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Two webhook registrations are required, not one: `child_resource_events` is EXCLUSIVE, not
 * additive — per Whop, enabling it sends *only* sub-merchant events. So the platform company
 * needs one webhook with it off (Layer X: our own memberships/payments) and one with it on
 * (Layer Y: connected-account identity/payout/payment events). Each registration gets its own
 * signing secret, so verification has to accept either.
 */
const webhookVerifiers = new Map<string, Whop>();

function verifierFor(secret: string): Whop {
  let v = webhookVerifiers.get(secret);
  if (!v) {
    v = new Whop({
      apiKey: process.env.WHOP_COMPANY_API_KEY,
      webhookKey: Buffer.from(secret).toString('base64'),
      ...(process.env.WHOP_API_BASE ? { baseURL: process.env.WHOP_API_BASE } : {}),
    });
    webhookVerifiers.set(secret, v);
  }
  return v;
}

/**
 * Verify + unwrap a v1 webhook (Standard Webhooks spec). Throws if no configured secret
 * validates the signature. Both registrations post to the same route.
 */
export function unwrapWebhook(rawBody: string, headers: Record<string, string>): unknown {
  const secrets = [
    process.env.WHOP_V1_WEBHOOK_SECRET,
    process.env.WHOP_V1_WEBHOOK_SECRET_CHILD,
  ].filter((s): s is string => !!s);

  if (secrets.length === 0) throw new WhopNotConfigured('verify webhook (no v1 webhook secret set)');

  let lastError: unknown;
  for (const secret of secrets) {
    try {
      return verifierFor(secret).webhooks.unwrap(rawBody, { headers });
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
