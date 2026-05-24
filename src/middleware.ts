export { auth as middleware } from '@/auth';

export const config = {
  // Avoid running middleware on static assets + Next internals
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
