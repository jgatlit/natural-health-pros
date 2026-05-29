import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/auth.config';

// Build the middleware's auth instance from the EDGE-SAFE config only (no Prisma adapter)
// so this Edge Function stays under Vercel's 1 MB limit.
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  // Admin routes require Role.ADMIN
  // ⚠️ TEMP — LOCAL TESTING ONLY: /admin gate disabled. REVERT BEFORE PUSH.
  // if (pathname.startsWith('/admin')) {
  //   if (!session?.user) {
  //     const signinUrl = new URL('/auth/signin', req.nextUrl);
  //     signinUrl.searchParams.set('callbackUrl', pathname);
  //     return NextResponse.redirect(signinUrl);
  //   }
  //   if (session.user.role !== 'ADMIN') {
  //     return NextResponse.redirect(new URL('/auth/error?error=AccessDenied', req.nextUrl));
  //   }
  // }

  // Practitioner edit + onboarding require authenticated session (in-page ownership check)
  if (pathname.match(/^\/practitioners\/[^/]+\/edit/) || pathname.startsWith('/onboarding')) {
    if (!session?.user) {
      const signinUrl = new URL('/auth/signin', req.nextUrl);
      signinUrl.searchParams.set('callbackUrl', pathname);
      return NextResponse.redirect(signinUrl);
    }
  }

  return NextResponse.next();
});

export const config = {
  // Avoid running middleware on static assets + Next internals
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
