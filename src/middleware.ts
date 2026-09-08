import NextAuth from 'next-auth';
import { NextResponse, type NextRequest } from 'next/server';
import { authConfig } from '@/auth.config';
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_WINDOW_DAYS,
  resolveAttribution,
  signAttribution,
  verifyAttribution,
} from '@/lib/attribution';

// Build the middleware's auth instance from the EDGE-SAFE config only (no Prisma adapter)
// so this Edge Function stays under Vercel's 1 MB limit.
//
// `providers: []` is LOAD-BEARING, not tidying. `authConfig` carries the Resend provider,
// which Auth.js types as `email`, and assertConfig rejects an email provider without an
// adapter: "MissingAdapter: Email login requires an adapter". The edge instance has no
// adapter by design, so passing the provider through made Auth.js THROW on every single
// middleware invocation — `req.auth` was always null, so every gated route bounced to
// /auth/signin even with a perfectly valid session cookie (an infinite sign-in loop).
// Middleware only DECODES the session JWT; it never initiates a sign-in, so it needs no
// providers. Keep this empty. See docs/runbooks/auth-middleware-missing-adapter.md.
const { auth } = NextAuth({ ...authConfig, providers: [] });

/**
 * FIRST-TOUCH ATTRIBUTION (§16, D14) — stamped on the first request to ANY page.
 *
 * FIRST TOUCH WINS: an existing, still-valid cookie is never overwritten. That is the whole
 * mechanism, not a nicety — re-resolving on a later pageview would hand every practitioner-shared
 * visit to NHP the moment the visitor clicked through to /search.
 *
 * No JavaScript, no iframe, no client cooperation: this runs before a byte of the page is sent,
 * so it works with scripting disabled and with the scheduler frame blocked outright.
 *
 * Never throws. An attribution failure must not take the site down, so a missing secret or a
 * crypto error degrades to "no cookie this request" — the next request tries again.
 */
async function stampAttribution(req: NextRequest, res: NextResponse): Promise<NextResponse> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    // Loud, because silence here looks identical to working attribution while every commission
    // calculation quietly loses its basis.
    console.warn('[attribution] AUTH_SECRET unset — first-touch attribution is NOT being recorded');
    return res;
  }

  // NEVER stamp on a booking-token path. `/practitioners/[slug]/book/[token]` carries an
  // unauthenticated bearer credential that §10 emails to buyers. If a buyer's FIRST touch were a
  // resume link from their inbox, that token would be baked into the cookie for 60 days and then
  // copied into the `attribution` JSON of every BookingIntent they later create — including
  // intents for OTHER practitioners. Skipping costs nothing: reaching this URL means they already
  // have an intent, so attribution was resolved at their real first touch.
  if (/^\/practitioners\/[^/]+\/book\//.test(req.nextUrl.pathname)) return res;

  try {
    const now = Date.now();
    const existing = await verifyAttribution(
      req.cookies.get(ATTRIBUTION_COOKIE)?.value,
      secret,
      now,
    );
    if (existing) return res; // First touch already held. Do not overwrite.

    // A PRESENT cookie that failed to verify is the one case that silently rewrites commission
    // basis: bad signature, tampering, an older payload format, or an AUTH_SECRET rotation (which
    // also invalidates sessions, so the symptom reads as a session problem). Everyone mid-window
    // gets re-resolved on their next visit. The unset-secret case below is already loud; this was
    // not, which is precisely the blind spot this file's own comment warns about.
    if (req.cookies.get(ATTRIBUTION_COOKIE)) {
      console.warn('[attribution] present cookie failed to verify — first touch is being RESET');
    }

    const attribution = resolveAttribution({
      pathname: req.nextUrl.pathname,
      searchParams: req.nextUrl.searchParams,
      referrer: req.headers.get('referer'),
      selfHost: req.nextUrl.hostname,
      now,
    });

    res.cookies.set(ATTRIBUTION_COOKIE, await signAttribution(attribution, secret), {
      // HttpOnly so no script can read or forge it; signed as well, because HttpOnly stops a
      // script READING the cookie, not a client SENDING one — and this value decides who is paid.
      httpOnly: true,
      sameSite: 'lax',
      secure: req.nextUrl.protocol === 'https:',
      path: '/',
      maxAge: ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60,
    });
  } catch (err) {
    console.error('[attribution] failed to stamp first touch', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return res;
}

export default auth(async (req) => {
  const { pathname, search } = req.nextUrl;
  const session = req.auth;
  // Round-trip the full path INCLUDING the query string: /onboarding carries
  // ?invitation=<token>, and sending only `pathname` silently dropped it, so a bounced
  // invitee lost their invitation and failed the onboarding gate after signing in.
  const callbackTarget = `${pathname}${search}`;
  // Admin routes require Role.ADMIN
  if (pathname.startsWith('/admin')) {
    if (!session?.user) {
      const signinUrl = new URL('/auth/signin', req.nextUrl);
      signinUrl.searchParams.set('callbackUrl', callbackTarget);
      return NextResponse.redirect(signinUrl);
    }
    if (session.user.role !== 'ADMIN') {
      return NextResponse.redirect(new URL('/auth/error?error=AccessDenied', req.nextUrl));
    }
  }
  // Practitioner edit + onboarding require an authenticated session
  if (pathname.match(/^\/practitioners\/[^/]+\/edit/) || pathname.startsWith('/onboarding')) {
    if (!session?.user) {
      const signinUrl = new URL('/auth/signin', req.nextUrl);
      signinUrl.searchParams.set('callbackUrl', callbackTarget);
      return NextResponse.redirect(signinUrl);
    }
  }
  // Stamped on the PASS-THROUGH path only. The redirects above go to /auth/signin and
  // /auth/error, which are themselves matched by this middleware and get stamped on arrival —
  // so nothing is missed, and a gated-route bounce does not record the gate as the landing page.
  return stampAttribution(req, NextResponse.next());
});

export const config = {
  // Avoid running middleware on static assets + Next internals.
  //
  // `.well-known` is excluded deliberately, not for tidiness. It serves Whop's Apple Pay
  // domain-association file, which Apple requires be "served with the correct content (no
  // modifications)". The pass-through branch runs stampAttribution(), so leaving the path
  // matched would put a cookie-writing wrapper in front of a file Apple fetches and compares.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|\\.well-known).*)'],
};
