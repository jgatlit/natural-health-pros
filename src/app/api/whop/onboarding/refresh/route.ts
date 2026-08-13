import { NextRequest } from 'next/server';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { createAccountLink } from '@/lib/whop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Auth + ownership gate for this redirect target (not a webhook — a real browser hit).
 * Merges "no such practitioner" and "not your practitioner" into the same `/` outcome so a
 * hit can't distinguish an unknown slug from someone else's — mirrors the shape of
 * authorizeForSlug in practitioners/[slug]/edit/actions.ts (IDOR discipline), scoped to this
 * route's own redirect targets.
 */
async function authorizeForSlug(slug: string) {
  const session = await auth();
  if (!session?.user?.id) {
    // UNLIKE the return route, this one STAYS gated: it mints an account link carrying payout
    // scopes (create/update/delete_destination, withdraw_funds), so an open version would let
    // anyone request a privileged link for any practitioner's connected account.
    //
    // The callback used to point back at this API route, which re-mints a link the moment
    // sign-in completes — a confusing bounce straight back out to Whop. Sending them to their
    // own payments section instead lands them somewhere they can see their status and choose
    // to continue, which is also the right destination if their link expired because they
    // walked away mid-flow.
    const callbackUrl = `/practitioners/${slug}/edit#payments`;
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }
  const practitioner = await prisma.practitioner.findUnique({
    where: { slug },
    select: { id: true, userId: true, whopCompanyId: true },
  });
  const isOwner = practitioner?.userId === session.user.id;
  const isAdmin = session.user.role === 'ADMIN';
  if (!practitioner || (!isOwner && !isAdmin)) {
    redirect('/');
  }
  return practitioner;
}

/**
 * Whop's account links are short-lived; when one expires mid-KYC-flow, Whop redirects here
 * so we can mint a fresh link and bounce the practitioner straight back into the hosted form
 * — no in-between page, since a stale link left to sit is just a dead end.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const slug = request.nextUrl.searchParams.get('slug');
  if (!slug) redirect('/');

  const practitioner = await authorizeForSlug(slug);

  if (!practitioner.whopCompanyId) {
    redirect(`/practitioners/${slug}/edit?whop=error#payments`);
  }

  let link: { url: string };
  try {
    link = await createAccountLink({
      companyId: practitioner.whopCompanyId,
      slug,
      useCase: 'account_onboarding',
    });
  } catch {
    redirect(`/practitioners/${slug}/edit?whop=error#payments`);
  }

  redirect(link.url);
}
