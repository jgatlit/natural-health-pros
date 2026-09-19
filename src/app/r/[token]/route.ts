import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { REFERRAL_PARAM } from '@/lib/referral-param';
import { REFERRAL_COOKIE, REFERRAL_COOKIE_DAYS, signReferralCookie } from '@/lib/referral-cookie';
import { resolveReferralOpen } from '@/lib/referrals';
import { SITE_URL } from '@/lib/site';

/**
 * `/r/<token>` — where a referral link lands (spec v1.4 §5.4.3).
 *
 * PUBLIC AND UNAUTHENTICATED: the visitor is a prospective client, not a user. Three things happen
 * here and the ORDER is the design:
 *
 *   1. record a `ReferralTouch` — BEFORE redirecting anywhere, so the referral exists as a row in
 *      our own database from the first millisecond (§10: "attribution relies only on events NHP
 *      records, not on cookies");
 *   2. set a signed fallback cookie for the one case the URL cannot survive (§9 test 13);
 *   3. redirect to the practitioner's profile carrying `?nhpr=<touchToken>`.
 *
 * ⚠️ `ƒ` NOT `○`. This route reads a dynamic segment and writes on GET, so it must never be
 * prerendered — a static `/r/[token]` would serve one cached response to every visitor and every
 * referral would resolve to the same touch. `force-dynamic` states it; the build table's route
 * column is the oracle.
 *
 * ⚠️ THE TOUCH TOKEN IS NOT THE REFERRAL TOKEN. `Referral.token` belongs to the referrer and
 * addresses this route; `ReferralTouch.touchToken` is minted per visitor. If the referral token
 * travelled onward, one client could forward another client's link and both would resolve to the
 * same row — and the second client's booking would overwrite whose it was.
 *
 * ⚠️ AN EXPIRED LINK STILL WORKS AS A LINK. §5.4.7: "the link still goes to Y's page, but no
 * referral is recorded." Dead-ending the visitor would punish the client for the referrer's
 * timing, on a page the referrer told them to open.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: { token: string } },
) {
  const open = await resolveReferralOpen(prisma, { token: params.token }).catch((err) => {
    // Never fatal. A database hiccup must not turn a link a practitioner handed to a client into
    // an error page; the visit degrades to an ordinary, unattributed one.
    console.error('[referral] open failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });

  // An unknown token, or a practitioner who has gone. Send them somewhere real rather than 404ing
  // a link that is already out in the world — search is the honest destination for "this
  // practitioner is no longer here".
  if (!open?.redirectSlug) {
    return NextResponse.redirect(new URL('/search', SITE_URL), 302);
  }

  const target = new URL(`/practitioners/${encodeURIComponent(open.redirectSlug)}`, SITE_URL);
  if (open.touchToken) target.searchParams.set(REFERRAL_PARAM, open.touchToken);

  const response = NextResponse.redirect(target, 302);

  // The fallback, for §9 test 13: a client who opens the link, leaves, and returns DIRECTLY later.
  // Signed, because the value decides who receives 20% of a session and HttpOnly only stops a
  // script from READING it — it does nothing about a client sending a forged one. Set only when a
  // touch was actually recorded, so an expired link leaves no trace at all.
  if (open.touchToken && open.touchId && process.env.AUTH_SECRET) {
    const value = await signReferralCookie(
      { touchId: open.touchId, referredId: open.referredId!, ts: Date.now() },
      process.env.AUTH_SECRET,
    );
    response.cookies.set(REFERRAL_COOKIE, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: REFERRAL_COOKIE_DAYS * 24 * 60 * 60,
    });
  }

  return response;
}
