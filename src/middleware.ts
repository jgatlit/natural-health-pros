import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/auth.config';

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

export default auth((req) => {
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
  return NextResponse.next();
});

export const config = {
  // Avoid running middleware on static assets + Next internals
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
