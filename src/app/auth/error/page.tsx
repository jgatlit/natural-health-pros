import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AlertTriangle, Mail } from 'lucide-react';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { Card } from '@/components/ui/card';
import {
  invitationCallbackPath,
  invitationTokenOf,
  maskEmail,
  signedInDestination,
} from '@/lib/sign-in-recovery';
import { resendInvitationLink } from './actions';

const MESSAGES: Record<string, string> = {
  Configuration: 'There is a configuration problem with the sign-in service.',
  AccessDenied: 'You do not have permission to sign in.',
  Verification: 'This link is invalid or has expired. Request a new one.',
  Default: 'Could not complete sign-in. Try again.',
};

type Props = { searchParams: { error?: string; callbackUrl?: string; resend?: string } };

export const dynamic = 'force-dynamic';

export default async function AuthErrorPage({ searchParams }: Props) {
  const error = searchParams.error ?? 'Default';
  const message = MESSAGES[error] ?? MESSAGES.Default;

  // A used sign-in link is usually a second click (another tab or device, or a mail scanner that
  // opened it first). If this browser is already signed in, the link has done its job.
  let resend: { callbackUrl: string; maskedEmail: string } | null = null;
  let joinPath: string | null = null;
  if (error === 'Verification') {
    const session = await auth();
    if (session?.user?.id) redirect(signedInDestination(searchParams.callbackUrl));

    const callbackUrl = invitationCallbackPath(searchParams.callbackUrl);
    if (callbackUrl) {
      const invitation = await prisma.invitation.findUnique({
        where: { token: invitationTokenOf(callbackUrl) },
        select: { email: true, expiresAt: true, cohort: { select: { slug: true, enabled: true } } },
      });
      if (invitation && invitation.expiresAt > new Date()) {
        resend = { callbackUrl, maskedEmail: maskEmail(invitation.email) };
      } else if (invitation?.cohort?.enabled) {
        joinPath = `/join/${invitation.cohort.slug}`;
      }
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-sm">
        <Card className="space-y-5 p-6 sm:p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
          </div>
          {resend ? (
            <>
              <div className="space-y-1.5">
                <h1 className="text-xl font-semibold tracking-tight">This sign-in link no longer works</h1>
                <p className="text-sm text-muted-foreground">
                  Each link works once and expires after 24 hours. We can send a new one to{' '}
                  {resend.maskedEmail}.
                </p>
              </div>
              {searchParams.resend === 'throttled' && (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  Several links were sent in the last hour. Use the newest email, or try again later.
                </p>
              )}
              <form action={resendInvitationLink}>
                <input type="hidden" name="callbackUrl" value={resend.callbackUrl} />
                <button
                  type="submit"
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <Mail className="h-4 w-4" />
                  Send me a new link
                </button>
              </form>
              <p className="text-xs text-muted-foreground">
                Open the newest email and tap its link once.
              </p>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <h1 className="text-xl font-semibold tracking-tight">Sign-in problem</h1>
                <p className="text-sm text-muted-foreground">{message}</p>
              </div>
              <Link
                href={joinPath ?? '/auth/signin'}
                className="inline-flex h-9 w-full items-center justify-center rounded-md border bg-card text-sm font-medium transition-colors hover:bg-accent"
              >
                {joinPath ? 'Request a new sign-up link' : 'Back to sign-in'}
              </Link>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}
