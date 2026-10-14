import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { Mail } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { Card } from '@/components/ui/card';
import { COHORT_SLUG_RE } from '@/lib/join-cohort';
import {
  RECRUITER_COOKIE,
  RECRUITER_PARAM,
  RECRUITER_TOKEN_RE,
  verifyRecruiterCookie,
} from '@/lib/recruiter-cookie';
import { RECRUITER_DISCLOSURE } from '@/lib/recruiter';
import { requestJoin } from './actions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Join Natural Health Pros',
  robots: { index: false, follow: false },
};

type Props = {
  params: { cohort: string };
  searchParams: { sent?: string; error?: string; nhpa?: string };
};

const ERRORS: Record<string, string> = {
  invalid: 'That does not look like an email address.',
  throttled: 'Too many attempts. Please try again in a little while.',
  'send-failed': 'We could not send the link. Please try again.',
};

export default async function JoinPage({ params, searchParams }: Props) {
  if (!COHORT_SLUG_RE.test(params.cohort)) notFound();
  const cohort = await prisma.signupCohort.findUnique({ where: { slug: params.cohort } });
  if (!cohort) notFound();

  if (!cohort.enabled) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
        <Card className="w-full max-w-sm space-y-2 p-6 text-center sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight">Sign-up is closed</h1>
          <p className="text-sm text-muted-foreground">
            This sign-up link is not accepting new practitioners right now. Please check with your
            program lead.
          </p>
        </Card>
      </main>
    );
  }

  // The recruiter who will be credited: an already-held cookie wins over this URL (first-wins).
  const fromCookie = await verifyRecruiterCookie(
    cookies().get(RECRUITER_COOKIE)?.value,
    process.env.AUTH_SECRET,
    Date.now(),
  );
  const param = searchParams[RECRUITER_PARAM]?.trim();
  const effective = fromCookie ?? (param && RECRUITER_TOKEN_RE.test(param) ? param : null);
  // Disclosure only for a recruiter that will actually be credited, never for a made-up token.
  const recruiter = effective
    ? await prisma.practitioner.findFirst({
        where: { recruiterToken: effective, archivedAt: null },
        select: { id: true },
      })
    : null;

  const error = searchParams.error ? ERRORS[searchParams.error] : undefined;
  const sent = searchParams.sent === '1';

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-sm">
        <Card className="space-y-5 p-6 sm:p-8">
          <div className="space-y-1.5 text-center">
            <h1 className="text-xl font-semibold tracking-tight">Join Natural Health Pros</h1>
            <p className="text-sm text-muted-foreground">
              {cohort.label}. Enter your email and we&apos;ll send a link to set up your profile.
            </p>
          </div>

          {recruiter && (
            <div className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs">
              {RECRUITER_DISCLOSURE}
            </div>
          )}

          {sent ? (
            <div className="rounded-md border border-primary/40 bg-primary/10 px-3 py-3 text-sm">
              If that address can sign up, a link is on its way. It expires in 24 hours. Check your
              spam folder if you do not see it.
            </div>
          ) : (
            <>
              {error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              )}
              <form action={requestJoin.bind(null, cohort.slug)} className="space-y-3">
                {param && RECRUITER_TOKEN_RE.test(param) && (
                  <input type="hidden" name="nhpa" value={param} />
                )}
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Email</span>
                  <input
                    type="email"
                    name="email"
                    required
                    autoFocus
                    placeholder="you@example.com"
                    className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 transition-shadow focus-visible:ring-2"
                  />
                </label>
                <button
                  type="submit"
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <Mail className="h-4 w-4" />
                  Send my sign-up link
                </button>
              </form>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}
