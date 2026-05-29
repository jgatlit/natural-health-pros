import type { NextAuthConfig } from 'next-auth';
import Resend from 'next-auth/providers/resend';
import type { Role } from '@prisma/client';

// Edge-safe base auth config — NO Prisma adapter, NO database access.
// `middleware.ts` builds a NextAuth instance from THIS config only, so the Edge bundle
// stays well under Vercel's 1 MB limit (the Prisma client + adapter would blow it — that
// failure is why the dual-label schema growth tipped the old single-file config over).
// The full `auth.ts` composes this with the adapter + db-touching jwt callback/events.
//
// `import type { Role }` is erased at compile time — no runtime Prisma dependency here.
export const authConfig = {
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/auth/signin',
    verifyRequest: '/auth/verify-request',
    error: '/auth/error',
  },
  providers: [
    Resend({
      apiKey: process.env.RESEND_API_KEY ?? '',
      from: process.env.EMAIL_FROM ?? 'HHE Directory <onboarding@resend.dev>',
    }),
  ],
  callbacks: {
    // Pure: reads role off the already-signed JWT (baked in by auth.ts's jwt callback at
    // sign-in). Safe in the Edge runtime — no db. Lets middleware see session.user.role.
    session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
        session.user.role = (token.role ?? 'CLIENT') as Role;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
