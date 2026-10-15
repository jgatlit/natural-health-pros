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
 * VERIFIED LIVE 2026-09-17 — the field is `account_id`, and the docs are wrong. `company_id` is
 * not rejected, it is silently IGNORED: the plan is created on OUR company instead of the
 * practitioner's. The only symptom is a confusing downstream 400 ("Application fee amount can only
 * be set for connected accounts") on a company that plainly has a parent. Without a fee present it
 * would fail silently and bill the wrong company.
 */
async function whopPost<T>(
  path: string,
  body: unknown,
  action: string,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  if (!isWhopPlatformsReady()) throw new WhopNotConfigured(action);
  const base = process.env.WHOP_API_BASE ?? 'https://api.whop.com/api/v1';
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHOP_COMPANY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
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
        // account_id, NOT company_id — see the whopPost docstring. Verified live 2026-09-17.
        account_id: params.companyId,
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

/**
 * Mint a per-booking checkout CONFIGURATION (§17.3c).
 *
 * ⚠️ READ THIS BEFORE SWITCHING BACK TO `/checkout_sessions`. An earlier revision minted a
 * `chs_…` session there and passed it to the embed's `sessionId` prop, which is exactly what the
 * library's own docstring tells you to do ("attach metadata by first creating a session through
 * the API and then passing the session id"). **It renders Whop's 404 page.** Proven live
 * 2026-08-15 by diffing the embed HTML for each id type:
 *
 *   /embedded/checkout/chs_…/  → 1.35MB, ZERO product data — no title, no plan, no price
 *   /embedded/checkout/plan_…/ → 1.41MB, title + $55.00
 *   /embedded/checkout/ch_…/   → 1.41MB, title + $55.00
 *
 * The `chs_` objects from `/v1/checkout_sessions` are a newer, Stripe-shaped resource (they carry
 * a `client_secret`) that the embedded checkout iframe does not support. What the embed calls a
 * "session" is a checkout CONFIGURATION — note its placeholder is `ch_XXXXXXXX`, and that Whop's
 * own hosted URL is `…/checkout/plan_…/?session=ch_…` where that id is the configuration.
 *
 * The lesson worth keeping: the session probe verified CREATION (201, metadata merged correctly)
 * and concluded the design was validated. Creation success is not renderability.
 *
 * So: one configuration per booking, bound to the offering's EXISTING plan via `plan_id`, so
 * pricing stays defined in exactly one place and no product or plan is duplicated per buyer.
 * `metadata` is set in full here — a fresh configuration inherits nothing, unlike a session.
 *
 * Two properties that a session could not give us:
 *   - Configurations do NOT expire (no `expires_at` in the response), so a stored id survives
 *     §10's resume email however late the buyer returns. No re-mint machinery needed.
 *   - Each one returns its OWN `purchase_url` carrying `?session=<this config>`, so the §8
 *     embed-failure fallback is finally ATTRIBUTABLE — it carries `booking_intent_id` like the
 *     embed does. The offering-level `purchaseUrl` never could.
 */
export async function createBookingCheckoutConfig(params: {
  planId: string;
  practitionerId: string;
  offeringId: string;
  bookingIntentId: string;
  slug: string;
  /** The intent's public token — this configuration returns the buyer to their own booking page. */
  publicToken: string;
  /**
   * Platform fee for THIS booking, derived from the practitioner's plan and whether the ledger
   * says this is a first session. 0 (or omitted) keeps the original shared-plan path.
   */
  applicationFeeCents?: number;
  /** The practitioner's connected company — required only when a fee is charged. See below. */
  companyId?: string | null;
  title?: string;
  priceUsdCents?: number;
}): Promise<{ checkoutConfigId: string; purchaseUrl: string | null }> {
  const fee = params.applicationFeeCents ?? 0;

  // A fee cannot be attached to an EXISTING plan — Whop fixes `application_fee_amount` when the
  // plan is created, and the offering's shared plan was created without one. So a fee-bearing
  // booking mints its own dynamic plan (same shape as publishOffering) instead of referencing
  // `plan_id`. That is unavoidable rather than wasteful: the fee is per-booking by design, because
  // Plan B charges only the FIRST session with a given client and the same offering must therefore
  // produce different fees for different buyers.
  //
  // Without `companyId` we cannot mint on the practitioner's account, and minting on ours would
  // silently bill the wrong company (see the whopPost docstring). In that case we fall back to the
  // no-fee path rather than take money to the wrong place.
  const dynamic = fee > 0 && !!params.companyId && !!params.priceUsdCents;

  const cfg = await whopPost<{ id: string; purchase_url?: string | null }>(
    '/checkout_configurations',
    {
      mode: 'payment',
      ...(dynamic && {
        plan: {
          account_id: params.companyId,
          currency: 'usd',
          plan_type: 'one_time',
          initial_price: params.priceUsdCents! / 100,
          application_fee_amount: fee / 100,
          product: {
            title: params.title ?? 'Session',
            external_identifier: `${params.offeringId}-${params.bookingIntentId}`,
          },
        },
      }),
      // Reference the existing plan. `plan: "plan_…"` and `items: [{plan}]` are both rejected
      // with parameter_invalid — `plan_id` is the accepted spelling (verified live). Omitted when
      // a fee-bearing dynamic plan is minted above; sending both would be ambiguous.
      ...(dynamic ? {} : { plan_id: params.planId }),
      // All three ids, explicitly. A per-booking configuration is a NEW object and inherits no
      // metadata from the offering's; only a session merged. Dropping the first two here would
      // make Layer Y payments unattributable to a practitioner, which is how Layer X went wrong.
      metadata: {
        practitioner_id: params.practitionerId,
        offering_id: params.offeringId,
        booking_intent_id: params.bookingIntentId,
      },
      // BACK TO THE INTENT, not to the profile. A per-booking configuration can express a
      // per-booking return, which an offering-level one cannot — so the hosted §8 fallback now
      // lands on the SAME settled page as the embed and the external-wallet return, instead of
      // dropping the buyer on a public profile with no acknowledgement that they just paid.
      // Collapsing the three exits into one is the point; `?purchase=success` had no handler
      // anywhere and had been a dead parameter since Layer Y shipped.
      redirect_url: `${baseUrl()}/practitioners/${params.slug}/book/${params.publicToken}`,
    },
    'create booking checkout configuration',
  );
  return { checkoutConfigId: cfg.id, purchaseUrl: absoluteCheckoutUrl(cfg.purchase_url) };
}

/**
 * The itemised fee lines on one payment — what makes our ledger CHECKABLE (spec §7).
 *
 * Validated live on `pay_JOaWdCx7xc37VJ`: a $10.00 payment returned `application_fee` $5.00
 * alongside `payment_processing_fixed_fee`, `payment_processing_percentage_fee`,
 * `orchestration_percentage_fee` and `stripe_radar_fee`. An earlier claim that only
 * `amount_after_fees` was exposed was wrong and is retracted.
 *
 * ⚠️ `amount` IS IN DOLLARS, like `/transfers` and unlike `application_fee_amount`. The conversion
 * lives in `reconcileFeeLines`, which is where it is tested.
 *
 * Returns an EMPTY ARRAY on a read failure rather than throwing: this feeds a reconciliation
 * sweep, and one unreadable payment must not abort the pass over the others. The caller reports
 * an empty result as an observed zero, which is a mismatch it will surface.
 */
export async function getPaymentFees(
  paymentId: string,
): Promise<Array<{ origin: string; amount: number }>> {
  if (!isWhopPlatformsReady()) throw new WhopNotConfigured('read payment fees');
  const base = process.env.WHOP_API_BASE ?? 'https://api.whop.com/api/v1';
  const res = await fetch(`${base}/payments/${encodeURIComponent(paymentId)}/fees`, {
    headers: { Authorization: `Bearer ${process.env.WHOP_COMPANY_API_KEY}` },
  });
  if (!res.ok) return [];
  const body = (await res.json().catch(() => null)) as
    | { data?: Array<{ origin?: string; amount?: number }> }
    | Array<{ origin?: string; amount?: number }>
    | null;
  const rows = Array.isArray(body) ? body : (body?.data ?? []);
  return rows
    .filter((r): r is { origin: string; amount: number } =>
      typeof r?.origin === 'string' && typeof r?.amount === 'number',
    )
    .map((r) => ({ origin: r.origin, amount: r.amount }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Transfers — moving a referral or recruiting share to the payee's Whop balance
// ──────────────────────────────────────────────────────────────────────────────

/** A transfer request that has not answered by now is treated as an ambiguous outcome. */
export const TRANSFER_TIMEOUT_MS = 25_000;

/**
 * Move money from the parent company to a connected account.
 *
 * ⚠️ UNITS. Whop takes DOLLARS on every money field — `amount` here, `application_fee_amount` and
 * `initial_price` above. What differs is where the conversion happens, and that is the actual
 * trap: `createBookingCheckoutConfig` takes CENTS and divides at the boundary, while this
 * function takes DOLLARS and divides nowhere. A caller who reads one signature and assumes the
 * other is off by 100x with no type error, because both are `number`.
 *
 * Hence `toTransferDollars()` on the caller's side: it is a named, validated boundary rather than
 * an inline `/ 100` that reviews as obviously correct in either direction. `amount: 24999`
 * produced "-$24,999.00" in a live rejection probe, which is the evidence this is dollars.
 *
 * DUPLICATE PROTECTION. The request carries `idempotence_key` (the SDK's documented "unique key to
 * prevent duplicate transfers") in the body and `metadata` so the transfer can be found again with
 * `findTransferForLedgerEntry`. Whether Whop honours the key on a parent -> sibling transfer, and
 * whether the list returns the metadata, is what the canary measures
 * (scripts/whop-canary-transfer.ts); until the operator records that result
 * (`WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED`) an attempt with an unknown outcome is never re-sent.
 *
 * 🚧 The parent company is not business-verified, so every call currently fails with "Please
 * verify your business before transferring funds". `payoutsGuard()` is what stops us reaching here
 * at all; this function is what runs the moment that clears.
 */
export async function createTransfer(params: {
  originId: string;
  destinationId: string;
  /** DOLLARS. See the warning above. */
  amountUsdDollars: number;
  /** Attached so the transfer can be found again by `GET /transfers`. */
  metadata?: Record<string, string>;
  /** Whop's documented duplicate-transfer key for ledger transfers (SDK `TransferCreateParams`). */
  idempotenceKey?: string;
}): Promise<{ transferId: string }> {
  const res = await whopPost<{ id: string }>(
    '/transfers',
    {
      origin_id: params.originId,
      destination_id: params.destinationId,
      amount: params.amountUsdDollars,
      currency: 'usd',
      ...(params.metadata ? { metadata: params.metadata } : {}),
      ...(params.idempotenceKey ? { idempotence_key: params.idempotenceKey } : {}),
    },
    'transfer a share',
    { timeoutMs: TRANSFER_TIMEOUT_MS },
  );
  return { transferId: res.id };
}

const TRANSFER_LOOKUP_PAGE = 100;
const TRANSFER_LOOKUP_MAX_PAGES = 10;

export type WhopTransferRecord = {
  id: string;
  /** DOLLARS. */
  amount: number;
  feeAmount: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
};

/**
 * The outcome of looking for a transfer.
 *
 *   found      a transfer matched.
 *   not-found  POSITIVE evidence of absence: the list answered with the expected envelope, its rows
 *              expose a `metadata` field (or it is empty), and the scan reached the end. Even this is
 *              only as good as the lookup mechanism; the caller trusts it only after the operator has
 *              recorded the canary result (`WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED`).
 *   unknown    the list cannot answer the question: an unexpected envelope, rows that carry no
 *              `metadata` field at all (metadata is not returned), or a list too long to scan.
 *
 * A request that fails outright THROWS; that is also "unknown" to every caller.
 */
export type TransferLookup =
  | { kind: 'found'; transfer: WhopTransferRecord }
  | { kind: 'not-found' }
  | { kind: 'unknown'; reason: string };

/**
 * Look for the first transfer from `originId` to `destinationId` that satisfies `match`:
 * `GET /transfers` (the list endpoint has no metadata filter, so the match runs here), newest first,
 * following the cursor up to `TRANSFER_LOOKUP_MAX_PAGES` pages. `createdAfter` bounds the scan.
 *
 * "No row matched" is NOT "no transfer exists" unless the list could have shown it, hence the
 * three-way result (`TransferLookup`).
 */
export async function findTransfer(params: {
  originId: string;
  destinationId: string;
  createdAfter?: Date;
  match: (t: WhopTransferRecord) => boolean;
}): Promise<TransferLookup> {
  if (!isWhopPlatformsReady()) throw new WhopNotConfigured('look up a transfer');
  const base = process.env.WHOP_API_BASE ?? 'https://api.whop.com/api/v1';
  let after: string | undefined;
  for (let page = 0; page < TRANSFER_LOOKUP_MAX_PAGES; page += 1) {
    const qs = new URLSearchParams({
      origin_id: params.originId,
      destination_id: params.destinationId,
      first: String(TRANSFER_LOOKUP_PAGE),
      direction: 'desc',
    });
    if (params.createdAfter) qs.set('created_after', params.createdAfter.toISOString());
    if (after) qs.set('after', after);
    const res = await fetch(`${base}/transfers?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${process.env.WHOP_COMPANY_API_KEY}` },
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Whop /transfers lookup failed (${res.status}): ${await res.text().catch(() => '')}`);
    }
    const body = (await res.json().catch(() => null)) as {
      data?: unknown;
      page_info?: { end_cursor?: string | null };
    } | null;
    if (!body || !Array.isArray(body.data)) {
      return { kind: 'unknown', reason: 'the transfer list did not have the expected { data: [...] } envelope' };
    }
    const rows = body.data as Array<{
      id?: string;
      amount?: number;
      fee_amount?: number | null;
      created_at?: string;
      metadata?: Record<string, unknown> | null;
    }>;
    if (rows.length > 0 && rows.every((t) => !t || typeof t !== 'object' || !('metadata' in t))) {
      return {
        kind: 'unknown',
        reason: 'the transfer list rows carry no metadata field, so a transfer cannot be matched by metadata',
      };
    }
    for (const t of rows) {
      if (!t?.id) continue;
      const record: WhopTransferRecord = {
        id: t.id,
        amount: typeof t.amount === 'number' ? t.amount : NaN,
        feeAmount: typeof t.fee_amount === 'number' ? t.fee_amount : null,
        metadata: t.metadata ?? null,
        createdAt: t.created_at ?? null,
      };
      if (params.match(record)) return { kind: 'found', transfer: record };
    }
    after = body.page_info?.end_cursor ?? undefined;
    if (rows.length < TRANSFER_LOOKUP_PAGE || !after) return { kind: 'not-found' };
  }
  return { kind: 'unknown', reason: 'the transfer list did not end within the page budget' };
}

/** The result of looking for the transfer made for one ledger row. See `TransferLookup`. */
export type LedgerTransferLookup =
  | { kind: 'found'; transferId: string; amountUsdDollars: number }
  | { kind: 'not-found' }
  | { kind: 'unknown'; reason: string };

/** Find the transfer made for one ledger row (`metadata.ledger_entry_id`). See `findTransfer`. */
export async function findTransferForLedgerEntry(params: {
  originId: string;
  destinationId: string;
  ledgerEntryId: string;
  createdAfter?: Date;
}): Promise<LedgerTransferLookup> {
  const hit = await findTransfer({
    originId: params.originId,
    destinationId: params.destinationId,
    createdAfter: params.createdAfter,
    match: (t) => t.metadata?.ledger_entry_id === params.ledgerEntryId,
  });
  if (hit.kind === 'found') return { kind: 'found', transferId: hit.transfer.id, amountUsdDollars: hit.transfer.amount };
  return hit;
}

/**
 * Is `companyId` a connected account (sibling) of the configured parent company? Read-only.
 * `GET /companies/{id}` is read first and its `parent_company_id` compared when present; when the
 * company object does not expose it, membership in the parent's connected-account list
 * (`GET /companies?parent_company_id=<parent>`) decides. THROWS when neither can be read.
 */
export async function isConnectedAccountOfParent(companyId: string): Promise<boolean> {
  if (!isWhopPlatformsReady()) throw new WhopNotConfigured('read a company');
  const base = process.env.WHOP_API_BASE ?? 'https://api.whop.com/api/v1';
  const parent = process.env.WHOP_PARENT_COMPANY_ID!;
  const headers = { Authorization: `Bearer ${process.env.WHOP_COMPANY_API_KEY}` };

  const one = await fetch(`${base}/companies/${encodeURIComponent(companyId)}`, {
    headers,
    signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
  });
  if (!one.ok) {
    throw new Error(`Whop /companies/${companyId} failed (${one.status}): ${await one.text().catch(() => '')}`);
  }
  const company = (await one.json().catch(() => null)) as { parent_company_id?: string | null } | null;
  if (company && typeof company.parent_company_id === 'string') return company.parent_company_id === parent;

  let after: string | undefined;
  for (let page = 0; page < TRANSFER_LOOKUP_MAX_PAGES; page += 1) {
    const qs = new URLSearchParams({ parent_company_id: parent, first: String(TRANSFER_LOOKUP_PAGE) });
    if (after) qs.set('after', after);
    const res = await fetch(`${base}/companies?${qs.toString()}`, {
      headers,
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Whop /companies list failed (${res.status}): ${await res.text().catch(() => '')}`);
    const body = (await res.json().catch(() => null)) as {
      data?: unknown;
      page_info?: { end_cursor?: string | null };
    } | null;
    if (!body || !Array.isArray(body.data)) {
      throw new Error('Whop /companies list did not have the expected { data: [...] } envelope');
    }
    const rows = body.data as Array<{ id?: string }>;
    if (rows.some((c) => c?.id === companyId)) return true;
    after = body.page_info?.end_cursor ?? undefined;
    if (rows.length < TRANSFER_LOOKUP_PAGE || !after) return false;
  }
  throw new Error('Whop /companies list did not end within the page budget');
}

/**
 * The USD balance of an account (`GET /ledger_accounts/{id}`): `balance` and `pending_balance`, in
 * DOLLARS. Used by the canary transfer script. THROWS when the read fails, including when Whop does
 * not accept a company id (`biz_...`) here and wants the ledger account id (`ldgr_...`) instead.
 */
export async function getAccountBalanceUsd(accountId: string): Promise<{ balanceUsd: number; pendingUsd: number }> {
  if (!isWhopPlatformsReady()) throw new WhopNotConfigured('read an account balance');
  const base = process.env.WHOP_API_BASE ?? 'https://api.whop.com/api/v1';
  const res = await fetch(`${base}/ledger_accounts/${encodeURIComponent(accountId)}`, {
    headers: { Authorization: `Bearer ${process.env.WHOP_COMPANY_API_KEY}` },
    signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Whop /ledger_accounts/${accountId} failed (${res.status}): ${await res.text().catch(() => '')}`);
  }
  const body = (await res.json()) as {
    balances?: Array<{ currency?: string; balance?: number; pending_balance?: number }>;
  };
  const usd = (body.balances ?? []).find((b) => String(b.currency).toLowerCase() === 'usd');
  return { balanceUsd: usd?.balance ?? 0, pendingUsd: usd?.pending_balance ?? 0 };
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
