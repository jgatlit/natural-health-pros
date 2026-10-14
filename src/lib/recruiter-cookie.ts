/**
 * The recruiter cookie: a signed, HttpOnly carrier for `?nhpa=<recruiter token>` from the first
 * arrival at /join/<cohort> until a practitioner row exists to write it onto.
 *
 * EDGE-SAFE ON PURPOSE: no Prisma, no node:crypto. Middleware stamps it, so this imports only the
 * Web Crypto helpers `attribution.ts` already exports to the edge bundle.
 *
 * Three names that must never be confused:
 *   - `nhpa`  (this file)  the RECRUITER of a new practitioner; feeds the recruiting affiliate.
 *   - `nhpr`  (referral-param.ts) a client referral between practitioners.
 *   - `ref`   a practitioner tagging their OWN audience, 0% (canon D18). Untouched here.
 *
 * The cookie is a hint, not an authority: the token is re-resolved against the database, and a
 * non-matching or archived recruiter is ignored, at the moment a practitioner is created.
 */

import { b64urlDecode, b64urlEncode } from './attribution';

export const RECRUITER_PARAM = 'nhpa';
export const RECRUITER_COOKIE = 'nhp_rec';
export const RECRUITER_COOKIE_DAYS = 30;

/** 16+ chars of URL-safe alphabet. Our own tokens are 32 hex chars; the cap bounds cookie size. */
export const RECRUITER_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

type Payload = { t: string; ts: number };

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signRecruiterCookie(token: string, ts: number, secret: string): Promise<string> {
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({ t: token, ts } satisfies Payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(payload));
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** The token inside a cookie, or null for anything untrustworthy (bad signature, malformed, expired). */
export async function verifyRecruiterCookie(
  raw: string | undefined | null,
  secret: string | undefined,
  now: number,
): Promise<string | null> {
  if (!raw || !secret) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      b64urlDecode(raw.slice(dot + 1)),
      new TextEncoder().encode(payload),
    );
    if (!ok) return null;
    const parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as Payload;
    if (typeof parsed.t !== 'string' || !RECRUITER_TOKEN_RE.test(parsed.t)) return null;
    if (typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) return null;
    if (now - parsed.ts > RECRUITER_COOKIE_DAYS * 86_400_000) return null;
    return parsed.t;
  } catch {
    return null;
  }
}

/**
 * FIRST WINS. Returns the cookie value to set, or null when nothing should be written: no/invalid
 * param, or an existing VALID cookie already holds a recruiter (even a different one).
 */
export async function nextRecruiterCookie(input: {
  param: string | null | undefined;
  existingCookie: string | undefined | null;
  secret: string | undefined;
  now: number;
}): Promise<string | null> {
  const token = input.param?.trim();
  if (!token || !RECRUITER_TOKEN_RE.test(token) || !input.secret) return null;
  if (await verifyRecruiterCookie(input.existingCookie, input.secret, input.now)) return null;
  return signRecruiterCookie(token, input.now, input.secret);
}
