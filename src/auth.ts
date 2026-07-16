import NextAuth from 'next-auth';
import Resend from 'next-auth/providers/resend';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@/lib/prisma';
import type { Role } from '@prisma/client';
import { authConfig } from '@/auth.config';

// One email, not two. An invitation's magic link carries `callbackUrl=/onboarding?invitation=…`,
// so a single click both signs the practitioner in AND lands them on onboarding. We brand the
// mail by overriding the provider's sendVerificationRequest and branching off that callbackUrl.
//
// This override lives HERE (Node) rather than in auth.config.ts on purpose: auth.config.ts is
// imported by middleware, so anything added there lands in the Edge bundle (1 MB limit — see
// gotcha_edge_middleware_1mb_auth_split). Auth.js mints + stores the token itself; we never
// touch its hashing, so an Auth.js upgrade can't silently break invites.
function inviteIsTarget(url: string): boolean {
  try {
    const cb = new URL(url).searchParams.get('callbackUrl') ?? '';
    return /\/onboarding\?invitation=/.test(decodeURIComponent(cb));
  } catch {
    return false;
  }
}

async function sendBrandedVerificationRequest(params: {
  identifier: string;
  url: string;
  provider: { apiKey?: string; from?: string };
}): Promise<void> {
  const { identifier: to, url, provider } = params;
  const isInvite = inviteIsTarget(url);

  const subject = isInvite
    ? "You're invited to join Natural Health Pros"
    : 'Sign in to Natural Health Pros';
  const heading = isInvite
    ? 'You&rsquo;re invited to claim your practitioner profile.'
    : 'Sign in to Natural Health Pros';
  const blurb = isInvite
    ? 'Natural Health Pros is a curated directory for graduates of Holistic Health Educators programs. One click signs you in and takes you straight to building your page.'
    : 'Click below to sign in. This link expires in 24 hours.';
  const cta = isInvite ? 'Accept your invitation' : 'Sign in';

  const text = [heading.replace(/&rsquo;/g, "'"), '', blurb, '', cta + ':', url, '', 'This link expires in 24 hours.', '', "If you weren't expecting this email, you can ignore it."].join('\n');
  const html = `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
      <h2 style="font-size: 18px; margin: 0 0 16px 0;">${heading}</h2>
      <p style="font-size: 14px; line-height: 1.6; color: #555;">${blurb}</p>
      <p style="margin: 24px 0;">
        <a href="${url}" style="background:#2C4A6E;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-size:14px;display:inline-block;">${cta}</a>
      </p>
      <p style="font-size:12px;color:#888;">This link expires in 24 hours. If you weren't expecting this email, you can ignore it.</p>
    </div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: provider.from, to, subject, html, text }),
  });
  if (!res.ok) throw new Error('Resend error: ' + JSON.stringify(await res.json()));
}

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
  // Override authConfig's plain Resend provider with the branded sender (Node-only).
  providers: [
    Resend({
      apiKey: process.env.RESEND_API_KEY ?? '',
      from: process.env.EMAIL_FROM ?? 'Natural Health Pros <onboarding@resend.dev>',
      sendVerificationRequest: sendBrandedVerificationRequest,
    }),
  ],
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
