import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@/lib/prisma';
import type { Role } from '@prisma/client';
import { authConfig } from '@/auth.config';

// Wedge 2A: NextAuth v5 + Prisma adapter + Resend Email provider (magic link).
// Full (Node-runtime) instance — composes the edge-safe base (auth.config.ts) with the
// Prisma adapter + db-touching jwt callback/events. Middleware uses auth.config directly
// so Prisma never lands in the Edge bundle (1 MB limit).

function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  events: {
    // Auto-promote configured admin emails on first sign-in.
    async createUser({ user }) {
      if (user.email && adminEmails().has(user.email.toLowerCase())) {
        await prisma.user.update({
          where: { id: user.id! },
          data: { role: 'ADMIN' },
        });
      }
    },
    async signIn({ user }) {
      // Idempotent re-check on every sign-in in case ADMIN_EMAILS changes.
      if (user.email && user.id && adminEmails().has(user.email.toLowerCase())) {
        const existing = await prisma.user.findUnique({
          where: { id: user.id },
          select: { role: true },
        });
        if (existing && existing.role !== 'ADMIN') {
          await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
        }
      }
    },
  },
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user }) {
      if (user) {
        const dbUser = await prisma.user.findUnique({
          where: { id: user.id! },
          select: { role: true },
        });
        token.role = (dbUser?.role ?? 'CLIENT') as Role;
      }
      return token;
    },
  },
});
