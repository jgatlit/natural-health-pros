/**
 * The "Sign me in" interstitial between a magic-link email and Auth.js's callback.
 *
 * Mail scanners (Outlook Safe Links and others) fetch every link in a message before the person
 * sees it. Pointed straight at `/api/auth/callback/resend`, that fetch redeems the single-use
 * token and creates a user, so the real click then fails. The email therefore links to
 * `/auth/confirm`, which only renders a button; the token is redeemed when a person presses it
 * (a same-origin POST to the callback, which Auth.js handles exactly like the GET).
 *
 * Pure and dependency-free so the page that uses it cannot touch the database or Auth.js.
 */

export const CONFIRM_PATH = '/auth/confirm';
export const CALLBACK_PATH = '/api/auth/callback/resend';

const PARAMS = ['callbackUrl', 'token', 'email'] as const;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;
const EMAIL_RE = /^[^\s@<>"'\\]+@[^\s@<>"'\\.]+(\.[^\s@<>"'\\.]+)+$/;
const CALLBACK_MAX = 2048;

export type ConfirmTarget = {
  email: string;
  /** Relative form action, rebuilt from the validated parts. Never the raw input. */
  action: string;
};

/**
 * The Auth.js magic-link url, re-pointed at the confirm page on the same origin. Auth.js writes an
 * absolute callbackUrl; it is shortened to a path so the confirm page never has to work out which
 * host it was reached on to accept it.
 */
export function toConfirmUrl(authUrl: string): string {
  const url = new URL(authUrl);
  if (url.pathname !== CALLBACK_PATH) {
    throw new Error(`toConfirmUrl: unexpected magic-link path ${url.pathname}`);
  }
  const params = new URLSearchParams(url.search);
  const callback = params.get('callbackUrl');
  if (callback) {
    const path = sameOriginPath(callback, url.origin);
    if (path) params.set('callbackUrl', path);
  }
  return `${url.origin}${CONFIRM_PATH}?${params.toString()}`;
}

/**
 * A same-origin relative path (`/x?y`), from either a relative path or an absolute url on
 * `origin`. Null for anything that could leave the site.
 */
function sameOriginPath(raw: string, origin: string): string | null {
  if (raw.length > CALLBACK_MAX) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return null;
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  if (raw.startsWith('/')) {
    if (raw.startsWith('//')) return null;
  } else if (!raw.toLowerCase().startsWith(`${base.origin.toLowerCase()}/`) && raw !== base.origin) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw, base.origin);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  const path = `${url.pathname}${url.search}`;
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  return path;
}

/**
 * Validate the confirm page's query. Exactly `callbackUrl`, `token` and `email`, each once; the
 * callback must stay on `origin`. Returns the email to show and the form action to post to.
 */
export function parseConfirmTarget(
  searchParams: URLSearchParams | Record<string, string | string[] | undefined>,
  origin: string,
): ConfirmTarget | null {
  const params =
    searchParams instanceof URLSearchParams ? searchParams : recordToParams(searchParams);
  if (!params) return null;

  const keys = Array.from(params.keys());
  if (keys.length !== PARAMS.length) return null;
  if (!PARAMS.every((k) => params.getAll(k).length === 1)) return null;

  const token = params.get('token')!;
  const email = params.get('email')!;
  const callbackUrl = params.get('callbackUrl')!;

  if (!TOKEN_RE.test(token)) return null;
  if (email.length > 320 || !EMAIL_RE.test(email)) return null;
  const callbackPath = sameOriginPath(callbackUrl, origin);
  if (!callbackPath) return null;

  const query = new URLSearchParams({ callbackUrl: callbackPath, token, email });
  return { email, action: `${CALLBACK_PATH}?${query.toString()}` };
}

function recordToParams(
  record: Record<string, string | string[] | undefined>,
): URLSearchParams | null {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v !== 'string') return null;
      params.append(key, v);
    }
  }
  return params;
}
