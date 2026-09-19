/**
 * Lead attribution — resolved at LANDING, server-side, first-touch (§16, D14).
 *
 * ⚠️ THIS IS DELIBERATELY NOT COUPLED TO THE CAPTURE FORM, even though capture is step 1 of the
 * single view again. Landing-time resolution catches every visitor, including the ones who never
 * reach the form at all — among them a free booking made through a practitioner's own scheduler,
 * which would otherwise be invisible to us. It also survives any future reordering of the flow,
 * which is exactly the fragility that made the last reorder look expensive.
 *
 * EDGE-SAFE BY CONSTRUCTION. Everything here runs in middleware, so: no Prisma, no `next/headers`,
 * no Node `crypto` — Web Crypto only. Importing anything Prisma-backed into the middleware graph
 * is what previously blew Vercel's 1 MB Edge limit (it passes locally and fails at deploy).
 */

/** The cookie name. HttpOnly, so no client script — ours or a third party's — can read or forge it. */
export const ATTRIBUTION_COOKIE = 'nhp_attr';

/**
 * The attribution window.
 *
 * ⚠️ 60 days is the SPEC'S RECOMMENDATION and is not yet operator-confirmed (§16: "Fixed window;
 * 60 days recommended, to be confirmed"). It is a single named constant precisely so confirming
 * or changing it is a one-line edit and not an archaeology exercise. Commission is calculated
 * from what this decides, so the number is a commercial parameter, not a technical default.
 */
export const ATTRIBUTION_WINDOW_DAYS = 60;

/** Who earns the commission on a booking that started with this visit. */
export type AttributionParty = 'PRACTITIONER' | 'NHP';

/** How the visitor arrived — a diagnostic that explains the party, never a second source of truth. */
export type AttributionSource =
  | 'REF_PARAM'
  | 'DIRECT_PROFILE'
  | 'EXTERNAL_REFERRAL'
  | 'ORGANIC_SEARCH'
  | 'PAID_CAMPAIGN'
  | 'DIRECTORY';

export type Attribution = {
  party: AttributionParty;
  source: AttributionSource;
  /** Bare referrer hostname, or null for a direct visit. Never the full referrer URL. */
  referrerHost: string | null;
  /** utm/click-id params, flattened. Bounded — see CAMPAIGN_KEYS. */
  campaign: Record<string, string>;
  /** The `?ref=` value as given, so a 0% attribution names who claimed it. Null when absent. */
  ref: string | null;
  landingPath: string;
  /** ms epoch of FIRST touch. The window is measured from here. */
  ts: number;
};

/**
 * Commission rate per party (§17).
 *
 * 0% on practitioner-driven traffic is deliberate and is the point of the whole mechanism:
 * practitioners must never be penalised for sending their own clients through the platform.
 */
export const COMMISSION_RATE: Record<AttributionParty, number> = {
  PRACTITIONER: 0,
  NHP: 0.2,
};

/**
 * Hosts that mean "organic search". Matched on the registrable host or any parent of it.
 *
 * ⚠️ Google is matched by PATTERN, not by enumeration. An earlier version listed only
 * `google.com` and `google.co.uk`, so organic traffic from google.de / .ca / .fr / .ie / .com.au
 * resolved to the PRACTITIONER and billed at 0%. Enumerating ~190 ccTLDs by hand is exactly how
 * that gap reappears. (That list also contained `search.marcia.com`, which is not a search engine
 * at all — it made the list look more complete than it was.)
 */
const SEARCH_HOSTS = [
  'bing.com', 'duckduckgo.com', 'yahoo.com', 'ecosia.org', 'brave.com',
  'baidu.com', 'yandex.com', 'startpage.com', 'qwant.com', 'search.marginalia.nu',
  'perplexity.ai', 'kagi.com',
];

/** `google.com`, `google.de`, `google.co.uk`, `google.com.au`, `news.google.com` … */
const GOOGLE_HOST = /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/;

/**
 * Params that mean a CAMPAIGN brought them. Bounded on purpose: this is copied into a signed
 * cookie that rides every request, so an unbounded copy of the query string would be both a size
 * problem and a place for junk to accumulate.
 */
const CAMPAIGN_KEYS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'msclkid',
];

const MAX_CAMPAIGN_VALUE = 120;
const MAX_REF_VALUE = 120;
const MAX_LANDING_PATH = 200;

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function isSearchHost(host: string): boolean {
  if (GOOGLE_HOST.test(host)) return true;
  return SEARCH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** True for `/practitioners/<slug>` and anything beneath it — a practitioner's own surface. */
function isProfilePath(pathname: string): boolean {
  return /^\/practitioners\/[^/]+/.test(pathname);
}

/**
 * Decide the attribution for a landing request.
 *
 * ORDERING IS THE DESIGN, and the first two rules are the ones worth arguing about:
 *
 *  1. An explicit `?ref=` wins over everything, including campaign params. It is a deliberate
 *     declaration by the practitioner sharing the link, and nothing else on the request is more
 *     authoritative about intent than that.
 *     ⚠️ OPEN: a practitioner running their OWN paid ad to her profile arrives with both `?ref=`
 *     and `utm_*`. This ruling gives it to the practitioner at 0%. That is a commercial call, not
 *     a technical one — flagged for the operator rather than decided here.
 *  2. Campaign params beat a bare profile landing: we paid for that click.
 */
export function resolveAttribution(input: {
  pathname: string;
  searchParams: URLSearchParams;
  referrer: string | null;
  selfHost: string;
  now: number;
}): Attribution {
  const { pathname, searchParams, referrer, selfHost, now } = input;

  let referrerHost: string | null = null;
  if (referrer) {
    try {
      referrerHost = bareHost(new URL(referrer).hostname);
    } catch {
      // A malformed Referer header is a direct visit as far as we are concerned. It must never
      // throw here — this runs on EVERY request to the site.
      referrerHost = null;
    }
  }

  const campaign: Record<string, string> = {};
  for (const key of CAMPAIGN_KEYS) {
    const value = searchParams.get(key);
    if (value) campaign[key] = value.slice(0, MAX_CAMPAIGN_VALUE);
  }

  // RECORD THE REF VALUE. Without it a waived commission is neither auditable nor attributable to
  // a named practitioner — there was no way to answer "who claimed this visit?" after the fact.
  const ref = searchParams.get('ref')?.trim().slice(0, MAX_REF_VALUE) || null;

  // CAP the path. It was the only unbounded field: a long URL produced a cookie past the ~4096-byte
  // browser limit, which the browser then silently DROPS — losing attribution entirely.
  const base = {
    referrerHost,
    campaign,
    ref,
    landingPath: pathname.slice(0, MAX_LANDING_PATH),
    ts: now,
  };
  const isSelf = referrerHost !== null && referrerHost === bareHost(selfHost);

  // 1 — ORGANIC SEARCH IS ALWAYS OURS. Beats `?ref=`, beats everything.
  if (referrerHost && isSearchHost(referrerHost)) {
    return { ...base, party: 'NHP', source: 'ORGANIC_SEARCH' };
  }
  // 2 — a campaign link is one WE shared, so it is ours. Also beats `?ref=`.
  if (Object.keys(campaign).length > 0) {
    return { ...base, party: 'NHP', source: 'PAID_CAMPAIGN' };
  }
  // 3 — anything that is not a practitioner's own profile page is the DIRECTORY, and ours. This
  // includes `/`, `/search`, and any arrival from our own pages. A `?ref=` here is ignored by
  // construction: practitioner attribution requires landing ON that practitioner's profile.
  if (isSelf || !isProfilePath(pathname)) {
    return { ...base, party: 'NHP', source: 'DIRECTORY' };
  }
  // 4 — a profile reached directly, from the practitioner's own site, or via her `?ref=` link.
  // That is her own audience: a shared link, her website, a referral, dark social.
  return {
    ...base,
    party: 'PRACTITIONER',
    source: ref ? 'REF_PARAM' : referrerHost ? 'EXTERNAL_REFERRAL' : 'DIRECT_PROFILE',
  };
}

/* ── signing ─────────────────────────────────────────────────────────────────────────────────
 *
 * HMAC-SHA256 over the JSON payload, via WEB CRYPTO so the same code runs in middleware and on
 * the server. The cookie is HttpOnly, but signing is still required: HttpOnly stops a script
 * reading it, not a client sending a forged one, and this value decides who is paid.
 */

/** Exported for `referral-cookie.ts`, which signs a different payload with the SAME primitives.
 *  One encoding and one HMAC construction across both cookies — a second hand-rolled scheme for
 *  a value that decides who gets paid is exactly the risk not worth taking twice. */
export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  // Indexed rather than `for…of`: the repo targets an es5 lib, where a typed array is not
  // iterable without --downlevelIteration.
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  // Backed by an explicit ArrayBuffer so it satisfies `BufferSource` — a bare Uint8Array is typed
  // over ArrayBufferLike, which Web Crypto will not accept.
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** `<base64url payload>.<base64url hmac>` */
export async function signAttribution(value: Attribution, secret: string): Promise<string> {
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Verify and decode. Returns null for anything untrustworthy — bad signature, malformed payload,
 * or a first touch older than the window.
 *
 * Uses `crypto.subtle.verify` rather than re-signing and comparing strings: it is constant-time,
 * and a `===` on two signatures is a timing oracle on the value that decides commission.
 */
export async function verifyAttribution(
  raw: string | undefined,
  secret: string,
  now: number,
): Promise<Attribution | null> {
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

    const parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as Attribution;
    if (parsed.party !== 'PRACTITIONER' && parsed.party !== 'NHP') return null;
    if (typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) return null;

    // Expired first touch is treated as NO first touch, so the next request starts a fresh one.
    // Note this cannot retroactively change a booking already made: BookingIntent snapshots the
    // attribution at row creation precisely so expiry here is invisible to completed bookings.
    if (now - parsed.ts > ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000) return null;

    return parsed;
  } catch {
    // Tampered, truncated, or written by an older format. Untrusted either way.
    return null;
  }
}
