'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { signIn } from '@/auth';
import { prisma } from '@/lib/prisma';
import { normalizeEmail } from '@/lib/email';
import { rateLimit } from '@/lib/rate-limit';
import { ensureCohortInvitation, COHORT_SLUG_RE } from '@/lib/join-cohort';
import { RECRUITER_COOKIE, RECRUITER_TOKEN_RE, verifyRecruiterCookie } from '@/lib/recruiter-cookie';

/**
 * Public, unauthenticated: anyone may request a sign-up link for an ENABLED cohort. What that buys
 * them is only a magic link mailed to the address they typed, redeemable by whoever holds that
 * inbox. The response never reveals whether the address is already known.
 */
export async function requestJoin(cohortSlug: string, formData: FormData): Promise<void> {
  const base = `/join/${encodeURIComponent(cohortSlug)}`;
  if (!COHORT_SLUG_RE.test(cohortSlug)) redirect('/');

  const email = normalizeEmail(String(formData.get('email') ?? ''));
  if (!email) redirect(`${base}?error=invalid`);

  const fwd = headers().get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const [byIp, byEmail] = await Promise.all([
    rateLimit('join-ip', fwd, { limit: 10, windowSeconds: 3600 }),
    rateLimit('join-email', email, { limit: 3, windowSeconds: 3600 }),
  ]);
  if (!byIp.success || !byEmail.success) redirect(`${base}?error=throttled`);

  const cohort = await prisma.signupCohort.findUnique({ where: { slug: cohortSlug } });
  // Unknown or disabled: no invitation, no email. The page itself renders the 404 / closed state.
  if (!cohort || !cohort.enabled) redirect(base);

  // First-wins: the signed cookie outranks the form's hidden copy of the URL param.
  const secret = process.env.AUTH_SECRET;
  const fromCookie = await verifyRecruiterCookie(cookies().get(RECRUITER_COOKIE)?.value, secret, Date.now());
  const hidden = String(formData.get('nhpa') ?? '').trim();
  const recruiterToken = fromCookie ?? (RECRUITER_TOKEN_RE.test(hidden) ? hidden : null);

  const invite = await ensureCohortInvitation(prisma, {
    cohortId: cohort.id,
    email,
    recruiterToken,
  });

  let sent = false;
  try {
    const res = await signIn('resend', {
      email,
      redirectTo: `/onboarding?invitation=${invite.token}`,
      redirect: false,
    });
    sent = typeof res === 'string' ? !/[?&]error=/.test(res) : true;
  } catch (e) {
    console.error('[join-send-failed]', e);
  }

  if (!sent) {
    if (invite.created) {
      await prisma.invitation
        .delete({ where: { id: invite.id } })
        .catch((e) => console.error('[join-rollback-failed]', { id: invite.id }, e));
    }
    redirect(`${base}?error=send-failed`);
  }
  redirect(`${base}?sent=1`);
}
