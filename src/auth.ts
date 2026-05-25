import NextAuth from 'next-auth';
import Resend from 'next-auth/providers/resend';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@/lib/prisma';
import type { Role } from '@prisma/client';

// Wedge 2A: NextAuth v5 + Prisma adapter + Resend Email provider (magic link).
// Invite-only model — sign-in is by magic link, role assignment is post-accept.

function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(prisma),
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
    session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
        session.user.role = (token.role ?? 'CLIENT') as Role;
      }
      return session;
    },
  },
});
