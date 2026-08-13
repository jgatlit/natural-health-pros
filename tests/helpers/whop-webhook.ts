import crypto from 'node:crypto';

/**
 * Standard Webhooks signer — lets the suite forge genuinely-valid Whop deliveries offline.
 *
 * Signed content is `{id}.{timestamp}.{body}`, HMAC-SHA256, base64, prefixed `v1,`.
 * The HMAC key is the RAW `ws_…` secret's bytes: src/lib/whop.ts hands the SDK
 * `base64(secret)` and the Standard Webhooks verifier base64-DECODES that back to the same
 * bytes. Getting this wrong is silent — every signature simply fails — so the round-trip is
 * asserted in tests/whop-webhook-signature.test.ts against the real verifier.
 */
export const TEST_SECRET = 'ws_test_secret_for_offline_signature_verification_0123456789';

export function signWebhook(
  body: string,
  opts: { secret?: string; id?: string; timestamp?: number } = {},
): Record<string, string> {
  const secret = opts.secret ?? TEST_SECRET;
  const id = opts.id ?? 'msg_test_00000000';
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', Buffer.from(secret))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${signature}`,
    'content-type': 'application/json',
  };
}

/** Build a signed POST Request for the v1 webhook route. */
export function signedRequest(
  // Envelope-level fields (company_id, id, timestamp, api_version) are part of the real Whop
  // delivery and are load-bearing for practitioner resolution — the helper must not model the
  // event as { type, data } only, or fixtures silently can't express the shape production sends.
  event: { type: string; data: Record<string, unknown>; [key: string]: unknown },
  opts: { secret?: string; id?: string; timestamp?: number } = {},
): Request {
  const body = JSON.stringify(event);
  return new Request('https://naturalhealthpros.com/api/whop/webhook/v1', {
    method: 'POST',
    headers: signWebhook(body, opts),
    body,
  });
}
