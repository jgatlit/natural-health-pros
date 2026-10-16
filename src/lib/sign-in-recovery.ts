/**
 * Recovery from a failed magic-link click (Auth.js `Verification`): a link opened twice, an older
 * link after a newer one was sent, or a mail scanner that fetched it first. Token security is
 * untouched (links stay single-use); this only decides where the person goes next.
 *
 * The one destination we carry through the error page is an onboarding invitation path, and only
 * in exactly that shape. Anything else is dropped, so the error page can never be used to bounce a
 * signed-in visitor to an arbitrary URL.
 */

const INVITATION_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** `/onboarding?invitation=<token>` from an absolute or relative callback URL, else null. */
export function invitationCallbackPath(raw: string | null | undefined, origin?: string): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw, origin ?? 'http://local.invalid');
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin ?? 'http://local.invalid').origin) return null;
  if (url.pathname !== '/onboarding') return null;
  const token = url.searchParams.get('invitation');
  if (!token || !INVITATION_TOKEN_RE.test(token)) return null;
  return `/onboarding?invitation=${token}`;
}

export function invitationTokenOf(path: string): string {
  return new URL(path, 'http://local.invalid').searchParams.get('invitation') ?? '';
}

/**
 * Where an already-signed-in visitor goes from a Verification error: the invitation they were
 * redeeming, or bare /onboarding, which sends them to their profile or the sign-up-link page.
 */
export function signedInDestination(callbackUrl: string | null | undefined): string {
  return invitationCallbackPath(callbackUrl) ?? '/onboarding';
}

/**
 * Auth.js redirects a failed email callback to `/auth/error?error=Verification` and drops the
 * callbackUrl. Put the invitation path back so the error page can offer a fresh link to the same
 * invitation. Returns the response unchanged in every other case.
 */
export function withVerificationContext(req: Request, res: Response): Response {
  const location = res.headers.get('location');
  if (!location) return res;
  const reqUrl = new URL(req.url);
  if (!reqUrl.pathname.endsWith('/callback/resend')) return res;

  let target: URL;
  try {
    target = new URL(location, reqUrl.origin);
  } catch {
    return res;
  }
  if (target.pathname !== '/auth/error' || target.searchParams.get('error') !== 'Verification') {
    return res;
  }
  const callback = invitationCallbackPath(reqUrl.searchParams.get('callbackUrl'), reqUrl.origin);
  if (!callback) return res;

  target.searchParams.set('callbackUrl', callback);
  const headers = new Headers(res.headers);
  headers.set('location', target.toString());
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** "j•••@example.com": enough to recognise your own address, not enough to read someone else's. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}
