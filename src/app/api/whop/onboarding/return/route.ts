import { NextRequest } from 'next/server';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public, non-disclosing landing. Deliberately NOT under /onboarding — see the note below. */
const PUBLIC_LANDING = '/verification-submitted';

/**
 * Where Whop drops the practitioner after the hosted KYC form.
 *
 * DELIBERATELY UNAUTHENTICATED, and it must stay that way.
 *
 * This used to require a session and bounce to /auth/signin when there wasn't one. That is a
 * dead end for two reasons, one of them structural:
 *
 *   1. Whop's callback is a Next.js CLIENT-SIDE navigation, so it appends `_rsc=` and fetches
 *      this URL instead of navigating to it. A cross-origin fetch sends no cookies unless
 *      `credentials:'include'`, and SameSite=Lax blocks them cross-site even then — so that
 *      path can NEVER be authenticated. (Today it is CORS-blocked first and Next falls back to
 *      a hard navigation, which is the only reason the flow works at all.)
 *   2. Whop's KYC is Sumsub, whose standard flow offers "continue on your phone" for ID
 *      capture. A practitioner who finishes on their phone has no session cookie there, ever.
 *
 * So the cookie is a coin flip on which device someone finished on — not a security boundary.
 * The real boundary is elsewhere: payout state is owned by the identity_profile.* webhook
 * (server-to-server, signed, no browser involved) with a reconciliation cron behind it. This
 * route carries ZERO state responsibility; a practitioner who never comes back at all still
 * ends up correct.
 *
 * Three properties make it safe to open up:
 *   - NO WRITES. The previous opportunistic getPayoutStatus() refresh is gone. It was also dead
 *     code — it queried by company id, which always 404s (see lib/whop.ts). Reconciliation now
 *     lives in /api/cron/whop-reconcile where it can be authorized and rate-limited.
 *   - NO DISCLOSURE. Every non-owner outcome — unknown slug, someone else's slug, no session —
 *     returns the identical redirect, preserving the merged not-found/unauthorized discipline
 *     used by authorizeForSlug in practitioners/[slug]/edit/actions.ts.
 *   - REPLAY-HARMLESS. This URL is embedded in Whop's account-link JWT and sits in the address
 *     bar, so it must be low-privilege. A pure redirect is.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const slug = request.nextUrl.searchParams.get('slug');

  // The session is CONSULTED to offer a nicer landing, never REQUIRED to proceed.
  let ownerTarget: string | null = null;
  if (slug) {
    const session = await auth().catch(() => null);
    if (session?.user?.id) {
      const practitioner = await prisma.practitioner
        .findUnique({ where: { slug }, select: { userId: true } })
        .catch(() => null);
      const isOwner = practitioner?.userId === session.user.id;
      const isAdmin = session.user.role === 'ADMIN';
      if (practitioner && (isOwner || isAdmin)) {
        ownerTarget = `/practitioners/${slug}/edit?whop=pending#payments`;
      }
    }
  }

  redirect(ownerTarget ?? PUBLIC_LANDING);
}
