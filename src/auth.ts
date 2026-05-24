import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@/lib/prisma';
import type { Role } from '@prisma/client';

// Phase 0 stub: NextAuth v5 wired to Prisma adapter, no providers yet.
// Add providers (email magic link, OAuth) in Phase 0.5 commit per Decisions-JSON.
// Invite-only model means email/magic-link is the primary path.

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'jwt' },
  providers: [],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const dbUser = await prisma.user.findUnique({ where: { id: user.id! }, select: { role: true } });
        token.role = (dbUser?.role ?? 'CLIENT') as Role;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
        session.user.role = (token.role ?? 'CLIENT') as Role;
      }
      return session;
    },
  },
});
