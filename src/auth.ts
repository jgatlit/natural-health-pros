import NextAuth from 'next-auth';
import Resend from 'next-auth/providers/resend';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@/lib/prisma';
import { authConfig } from '@/auth.config';
import { sessionStateFor } from '@/lib/session-role';

// One email, not two. An invitation's magic link carries `callbackUrl=/onboarding?invitation=…`,
// so a single click both signs the practitioner in AND lands them on onboarding. We brand the
// mail by overriding the provider's sendVerificationRequest and branching off that callbackUrl.
//
// This override lives HERE (Node) rather than in auth.config.ts on purpose: auth.config.ts is
// imported by middleware, so anything added there lands in the Edge bundle (1 MB limit — see
// gotcha_edge_middleware_1mb_auth_split). Auth.js mints + stores the token itself; we never
// touch its hashing, so an Auth.js upgrade can't silently break invites.
/**
 * Resolve the REAL invitation backing this magic link, or null.
 *
 * Deliberately does NOT trust the callbackUrl alone. `/auth/signin?callbackUrl=…` is a public,
 * unauthenticated form and Auth.js only validates that callbackUrl is same-origin — not its
 * shape. So `?callbackUrl=/onboarding?invitation=anything` is attacker-controllable, and
 * branding off it alone would let anyone make our verified sending domain deliver a curated
 * "You're invited" email to any inbox (phishing-adjacent; no compromise, but not ours to hand
 * out). Requiring a pending, unexpired, email-matched Invitation row makes the branding
 * unforgeable — an attacker can't conjure one without admin access.
 */
async function resolveInvitation(email: string, url: string) {
  try {
    const cb = new URL(url).searchParams.get('callbackUrl') ?? '';
    const match = decodeURIComponent(cb).match(/\/onboarding\?invitation=([^&#]+)/);
    if (!match) return null;
    const invitation = await prisma.invitation.findUnique({
      where: { token: match[1] },
      include: { invitedBy: { select: { name: true } } },
    });
    if (!invitation) return null;
    if (invitation.acceptedAt) return null;
    if (invitation.expiresAt <= new Date()) return null;
    if (invitation.email.toLowerCase() !== email.toLowerCase()) return null;
    return invitation;
  } catch {
    return null;
  }
}

async function sendBrandedVerificationRequest(params: {
  identifier: string;
  url: string;
  provider: { apiKey?: string; from?: string };
}): Promise<void> {
  const { identifier: to, url, provider } = params;
  const invitation = await resolveInvitation(to, url);
  const isInvite = invitation !== null;
  const invitedBy = invitation?.invitedBy?.name ?? null;
  const isCohort = Boolean(invitation?.cohortId);

  // TRANSACTIONAL SHAPE, deliberately plain. An earlier, prettier version of this mail —
  // promo subject ("You're invited to join…"), a product pitch, and a big styled CTA button —
  // landed in Gmail's PROMOTIONS tab, while the minimal Auth.js default it replaced reached the
  // primary inbox from the same domain. Gmail classified it correctly: it looked like marketing.
  // An invite nobody opens is worse than an ugly one, so: action-first subject, no pitch, a
  // plain link with the URL visible, no button, no card. Do not "improve" the styling here
  // without re-testing which tab it lands in.
  const subject = isInvite
    ? 'Sign in to claim your Natural Health Pros profile'
    : 'Sign in to Natural Health Pros';
  const line = isCohort
    ? 'Use this link to set up your practitioner profile on Natural Health Pros.'
    : isInvite
    ? `${invitedBy ?? 'An HHE admin'} invited you to claim your practitioner profile on Natural Health Pros.`
    : 'Here is your sign-in link for Natural Health Pros.';

  const text = [
    line,
    '',
    'Sign in:',
    url,
    '',
    'This link expires in 24 hours and can only be used once.',
    "If you weren't expecting this email, you can ignore it.",
  ].join('\n');

  const html = `<div style="font-family: -apple-system, system-ui, sans-serif; font-size: 15px; line-height: 1.6; color: #1a1a1a;">
<p>${line}</p>
<p>Sign in: <a href="${url}">${url}</a></p>
<p>This link expires in 24 hours and can only be used once.</p>
<p style="color:#666;">If you weren't expecting this email, you can ignore it.</p>
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
    // Re-reads the role on EVERY invocation, not just at sign-in.
    //
    // The `if (user)` guard that used to wrap this meant the role was cached for the life of the
    // token — so a demoted admin kept `/admin` until it expired, and the only way to bound that
    // was to expire everyone's session. Since magic-link is the sole authentication here, every
    // expiry is an email round trip for a non-technical practitioner.
    //
    // Decoupling the two lets `maxAge` be effectively infinite (see auth.config.ts) while a role
    // change lands on the very next request. `user` is present only at sign-in; `token.sub`
    // carries the id on every request after that.
    //
    // ⚠️ Middleware does NOT run this callback — it builds its instance from auth.config alone
    // (no adapter, edge runtime), so it still decodes whatever role the token holds. It is a
    // cheap first-pass redirect, NOT the guard. The pages and server actions re-read through
    // here and are authoritative.
    async jwt({ token, user }) {
      const state = await sessionStateFor(user?.id ?? token.sub, token.sv, Boolean(user));

      // Returning null INVALIDATES the session — this is how a deleted or revoked account is
      // actually signed out rather than merely downgraded. It is the only lever available: the
      // JWT strategy writes no `Session` rows, so there is nothing to delete server-side.
      if (!state.valid) return null;

      token.role = state.role;
      token.sv = state.version;
      return token;
    },
  },
});
