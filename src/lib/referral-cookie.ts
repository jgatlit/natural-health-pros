/**
 * THE REFERRAL FALLBACK COOKIE (spec v1.4 §5.4.5, §9 test 13) — and the server-side re-validation
 * that every carriage path goes through.
 *
 * The cookie exists for ONE scenario: a client opens a referral link, leaves, and comes back
 * directly two days later. Spec §10 is explicit that attribution must rely on events we record
 * rather than on cookies, so this is a hint, never an authority — the `ReferralTouch` row written
 * at `/r/<token>` is the authority, and the cookie only says which row to look for.
 *
 * ⚠️ HttpOnly STOPS A SCRIPT READING IT, NOT A CLIENT SENDING A FORGED ONE. The value decides who
 * receives 20% of a session, so it is HMAC-signed and verified with `crypto.subtle.verify` —
 * constant-time, rather than re-signing and `===`-comparing two strings, which is a timing oracle
 * on exactly that value. Same construction as the lead-attribution cookie, sharing its base64url
 * helpers rather than growing a second scheme.
 *
 * ⚠️ AND IT IS RE-VALIDATED SERVER-SIDE ANYWAY. Neither the URL param nor the cookie is trusted to
 * name a touch: `resolveReferralCarriage` looks the row up scoped to the practitioner being
 * booked, so a token minted for somebody else cannot be pasted onto this booking.
 */

import { b64urlDecode, b64urlEncode } from './attribution';

export { REFERRAL_COOKIE } from './referral-param';

/**
 * How long the fallback survives. Deliberately SHORTER than the attribution term: the cookie's
 * whole job is to bridge a client who wandered off mid-flow, and a months-long cookie would keep
 * silently attaching a referral to bookings the client made for unrelated reasons long afterwards.
 * The durable record is the `ReferralTouch`, which does last the term.
 */
export const REFERRAL_COOKIE_DAYS = 30;

export type ReferralCookie = {
  /** The `ReferralTouch.id`. */
  touchId: string;
  /** The practitioner the referral was FOR. Checked before the cookie is honoured. */
  referredId: string;
  /** Milliseconds since epoch, for expiry. */
  ts: number;
};

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** `<base64url payload>.<base64url hmac>` — the same envelope as the attribution cookie. */
export async function signReferralCookie(value: ReferralCookie, secret: string): Promise<string> {
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Verify and decode. Null for anything untrustworthy — bad signature, malformed, or expired. */
export async function verifyReferralCookie(
  raw: string | undefined | null,
  secret: string,
  now: number,
): Promise<ReferralCookie | null> {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;

  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);

  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(sig),
      new TextEncoder().encode(payload),
    );
    if (!ok) return null;

    const parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as ReferralCookie;
    if (typeof parsed.touchId !== 'string' || !parsed.touchId) return null;
    if (typeof parsed.referredId !== 'string' || !parsed.referredId) return null;
    if (typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) return null;
    if (now - parsed.ts > REFERRAL_COOKIE_DAYS * 86_400_000) return null;

    return parsed;
  } catch {
    // Tampered, truncated, or written by an older format. Untrusted either way.
    return null;
  }
}

export type CarriageDb = {
  referralTouch: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst(args: any): Promise<any>;
  };
};

export type Carriage = 'URL' | 'COOKIE' | 'NONE';

/**
 * Which referral, if any, this booking belongs to — and how it got here (§9 test 13).
 *
 * URL first, cookie second, and the OUTCOME IS ALWAYS RECORDED. §9 test 13 requires the fallback's
 * result to be logged either way, and an unrecorded `NONE` is indistinguishable from a referral
 * that was never made — which is the difference between "the carriage is broken" and "nobody
 * referred them", a distinction nobody can make after the fact without this field.
 */
export async function resolveReferralCarriage(
  db: CarriageDb,
  input: {
    practitionerId: string;
    paramToken: string | null | undefined;
    cookieValue: string | undefined | null;
    /** AUTH_SECRET. Absent means no cookie can be trusted, so the fallback simply does not apply. */
    secret: string | undefined;
    at: Date;
  },
): Promise<{ referralTouchId: string | null; carriage: Carriage }> {
  // Scoped by the practitioner being booked AND by the referral's own expiry, on BOTH paths. The
  // param is attacker-controllable and the cookie is client-supplied; neither is trusted to name
  // a touch that belongs to somebody else.
  const live = { gt: input.at };

  const token = input.paramToken?.trim();
  if (token) {
    const touch = await db.referralTouch.findFirst({
      where: {
        touchToken: token,
        referral: { referredId: input.practitionerId, expiresAt: live },
      },
      select: { id: true },
    });
    if (touch) return { referralTouchId: touch.id, carriage: 'URL' };
  }

  if (input.secret && input.cookieValue) {
    const parsed = await verifyReferralCookie(input.cookieValue, input.secret, input.at.getTime());
    // The cookie names the practitioner it was issued for. A visitor referred to Y who then browses
    // to Z must not pay Y's referrer out of Z's session — checked here AND again in the query.
    if (parsed && parsed.referredId === input.practitionerId) {
      const touch = await db.referralTouch.findFirst({
        where: {
          id: parsed.touchId,
          referral: { referredId: input.practitionerId, expiresAt: live },
        },
        select: { id: true },
      });
      if (touch) return { referralTouchId: touch.id, carriage: 'COOKIE' };
    }
  }

  return { referralTouchId: null, carriage: 'NONE' };
}
