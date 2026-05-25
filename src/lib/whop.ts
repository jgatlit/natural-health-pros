/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * Whop Platforms client wrapper — Wedge 2C scaffold.
 *
 * STATUS (2026-05-25): All functions are stubs that throw
 * WhopPlatformsAccessNotConfigured until HHE secures Whop for Platforms API access
 * (operator-side action via sales@whop.com — see docs/demo-prep/2026-05-25-whop-platforms-request.md).
 *
 * Type signatures + return shapes mirror Whop's actual API so swap-in is a
 * one-file change once the Platforms-scoped API key + parent company ID arrive
 * in env. See docs/PHASE-2C-WHOP-DESIGN.md for the full lifecycle spec.
 */

import { ProductInterval } from '@prisma/client';

export class WhopPlatformsAccessNotConfigured extends Error {
  constructor(action: string) {
    super(
      `Whop Platforms access not configured — cannot ${action}. ` +
        'Status: API key on file is standard creator-account scope, returns 401 on /connected_accounts. ' +
        'Operator-side action: email sales@whop.com to request Whop for Platforms access. ' +
        'See docs/demo-prep/2026-05-25-whop-platforms-request.md for the application template.',
    );
    this.name = 'WhopPlatformsAccessNotConfigured';
  }
}

const WHOP_API_BASE = process.env.WHOP_API_BASE ?? 'https://api.whop.com/api/v1';

function platformsReady(): boolean {
  // When access lands, also verify WHOP_PARENT_COMPANY_ID is set.
  // Today, the existing WHOP_API_KEY is creator-scope only; treat platforms as not-ready.
  return !!process.env.WHOP_PLATFORMS_ENABLED && !!process.env.WHOP_PARENT_COMPANY_ID;
}

// ──────────────────────────────────────────────────────────────────────────────
// Type definitions matching Whop Platforms API responses
// ──────────────────────────────────────────────────────────────────────────────

export type WhopSubMerchant = {
  id: string; // e.g., "biz_xxxxxxxxxxxxx"
  parent_company_id: string;
  email: string;
  title: string;
  metadata?: Record<string, string>;
  created_at: number;
};

export type WhopAccountLink = {
  url: string; // hosted KYC onboarding URL
  expires_at: number;
};

export type WhopProductResponse = {
  id: string;
  company_id: string;
  title: string;
  description?: string;
};

export type WhopPlanResponse = {
  id: string;
  product_id: string;
  price_cents: number;
  currency: string;
  interval: 'one_time' | 'monthly' | 'annual';
};

export type WhopCheckoutConfigResponse = {
  id: string;
  company_id: string;
  plan_id: string;
  purchase_url: string;
  application_fee_amount: number;
};

// ──────────────────────────────────────────────────────────────────────────────
// Sub-merchant lifecycle (Connected Account)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Create a sub-merchant company for a practitioner.
 *
 * Real call (once Platforms access granted):
 *   POST /v1/companies
 *   { email, parent_company_id: WHOP_PARENT_COMPANY_ID, title, metadata }
 *
 * Reference: https://docs.whop.com/developer/platforms/enroll-connected-accounts
 */
export async function createSubMerchant(_params: {
  email: string;
  title: string;
  metadata?: Record<string, string>;
}): Promise<WhopSubMerchant> {
  if (!platformsReady()) {
    throw new WhopPlatformsAccessNotConfigured('create sub-merchant');
  }
  // TODO: wire when access lands
  // const res = await whopFetch('POST', '/companies', {
  //   email, parent_company_id: process.env.WHOP_PARENT_COMPANY_ID, title, metadata
  // });
  // return res as WhopSubMerchant;
  throw new WhopPlatformsAccessNotConfigured('create sub-merchant');
}

/**
 * Generate a KYC verification link that the practitioner completes at Whop's hosted UI.
 *
 * Real call:
 *   POST /v1/account_links
 *   { company_id, refresh_url, return_url, use_case: 'account_onboarding' }
 */
export async function createAccountLink(_params: {
  companyId: string;
  refreshUrl: string;
  returnUrl: string;
}): Promise<WhopAccountLink> {
  if (!platformsReady()) {
    throw new WhopPlatformsAccessNotConfigured('create KYC account link');
  }
  throw new WhopPlatformsAccessNotConfigured('create KYC account link');
}

/**
 * Fetch the current KYC + payout-readiness status of a sub-merchant.
 * Used by the onboarding return route + admin dashboard.
 *
 * Real call: GET /v1/companies/{company_id}
 */
export async function getSubMerchantStatus(_companyId: string): Promise<{
  id: string;
  kyc_status: 'pending' | 'verified' | 'rejected';
  payouts_enabled: boolean;
}> {
  if (!platformsReady()) {
    throw new WhopPlatformsAccessNotConfigured('check sub-merchant status');
  }
  throw new WhopPlatformsAccessNotConfigured('check sub-merchant status');
}

// ──────────────────────────────────────────────────────────────────────────────
// Product lifecycle
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Create a product on a sub-merchant company. Three-step API call:
 *   1. POST /v1/products → product.id
 *   2. POST /v1/plans → plan.id (pricing tier)
 *   3. POST /v1/checkout_configurations → checkout_config.id + purchase_url
 *
 * Returns the composite IDs + purchase_url for storage in WhopProduct.
 */
export async function createProductForSubMerchant(_params: {
  companyId: string;
  title: string;
  description?: string;
  priceUsdCents: number;
  applicationFeeCents: number;
  interval: ProductInterval;
}): Promise<{
  whopProductId: string;
  whopPlanId: string;
  whopCheckoutConfigId: string;
  purchaseUrl: string;
}> {
  if (!platformsReady()) {
    throw new WhopPlatformsAccessNotConfigured('create product');
  }
  throw new WhopPlatformsAccessNotConfigured('create product');
}

/**
 * Archive (soft-delete) a product. Real call: PATCH /v1/products/{id} with visible=false.
 * Existing subscriptions continue per Whop's terms.
 */
export async function archiveProduct(_whopProductId: string): Promise<void> {
  if (!platformsReady()) {
    throw new WhopPlatformsAccessNotConfigured('archive product');
  }
  throw new WhopPlatformsAccessNotConfigured('archive product');
}

// ──────────────────────────────────────────────────────────────────────────────
// Webhook verification (HMAC)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Verify a webhook signature using the WHOP_WEBHOOK_SECRET.
 * Real impl: HMAC-SHA256 over the raw body, compare against x-whop-signature header.
 */
export function verifyWebhookSignature(
  _rawBody: string,
  _signatureHeader: string | null,
): boolean {
  if (!process.env.WHOP_WEBHOOK_SECRET) return false;
  // TODO: actual HMAC verification once Platforms access lands and we know
  // Whop's exact signature scheme. For now, return false to refuse all
  // unverified webhooks.
  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Status export (used by UI to render "Coming soon" vs real CTAs)
// ──────────────────────────────────────────────────────────────────────────────

export function isWhopPlatformsReady(): boolean {
  return platformsReady();
}
