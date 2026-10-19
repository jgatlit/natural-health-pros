/* Client-safe: no server imports. The classifier that produces these codes is whop-errors.ts. */

/**
 * Whop's per-checkout ceiling: one payment may not exceed $2,500 on these accounts. Whop answers
 * a larger plan with a 400 ("Purchases over $2500 USD are not enabled for this account unless
 * paid by bank wire on a one-time USD plan"), so the offering editor and Publish refuse it first.
 * See docs/2026-09-08-whop-payments-config-findings.md §6. A recurring plan is capped per charge,
 * the same way.
 */
export const WHOP_MAX_PAYMENT_CENTS = 250_000;

export const WHOP_OVER_LIMIT_MESSAGE =
  "Whop doesn't allow a single payment over $2,500. Split this into sessions or a payment plan, or contact us.";

export function exceedsWhopPaymentLimit(priceUsdCents: number): boolean {
  return priceUsdCents > WHOP_MAX_PAYMENT_CENTS;
}

/**
 * The short codes a failed Publish puts in the URL (`?error=whop-<code>`). Never the raw Whop
 * body: that stays in the server log.
 */
export const WHOP_PUBLISH_ERROR_CODES = [
  'over-limit',
  'account',
  'not-configured',
  'busy',
  'unavailable',
  'unknown',
] as const;
export type WhopPublishErrorCode = (typeof WHOP_PUBLISH_ERROR_CODES)[number];

export function isWhopPublishErrorCode(v: unknown): v is WhopPublishErrorCode {
  return typeof v === 'string' && (WHOP_PUBLISH_ERROR_CODES as readonly string[]).includes(v);
}

/** What the practitioner reads, on the page and in the email. */
export const WHOP_PUBLISH_ERRORS: Record<WhopPublishErrorCode, { summary: string; nextStep: string }> = {
  'over-limit': {
    summary: "Whop doesn't allow a single payment over $2,500.",
    nextStep: 'Split this into sessions or a payment plan, or contact us.',
  },
  account: {
    summary: 'Whop could not set up checkout because your payments account is not ready yet.',
    nextStep:
      'Open "Client payments" on your dashboard and finish any steps Whop is asking for, then try again. If everything there looks done, contact us.',
  },
  'not-configured': {
    summary: 'Online payments are not switched on for the directory right now.',
    nextStep: 'This is on our side, not yours. Contact us and we will sort it out.',
  },
  busy: {
    summary: 'Whop is getting too many requests right now.',
    nextStep: 'Wait a few minutes, then try again.',
  },
  unavailable: {
    summary: 'Whop did not respond.',
    nextStep: 'Nothing was charged and nothing was lost. Try again in a few minutes.',
  },
  unknown: {
    summary: 'Whop could not set up checkout for this offering.',
    nextStep:
      'Nothing was charged and nothing was lost. Try again in a few minutes; if it keeps failing, contact us and we will look at it.',
  },
};
