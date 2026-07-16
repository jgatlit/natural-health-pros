import { Mail, Sparkles } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { signIn } from '@/auth';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

type Props = { params: { token: string } };

// ORPHANED BY DESIGN (PR #28). Nothing in the app links here any more: invitations now carry
// the magic link directly, so one click signs in and lands on /onboarding. This route is kept
// ONLY as a grace period for invitation emails sent BEFORE that deploy, which still point at
// it — deleting it would turn those into dead links for anyone who hasn't clicked yet. It
// still works (it calls signIn with the same redirectTo shape, so those users get the new
// one-click flow from here on).
// TODO(remove): safe to delete once no pending, unexpired Invitation predates PR #28 — i.e.
// 7 days (INVITATION_TTL_MS) after that deploy, or when this returns nothing:
//   SELECT 1 FROM "Invitation" WHERE "acceptedAt" IS NULL AND "expiresAt" > now() AND "createdAt" < '<deploy-date>';
export const dynamic = 'force-dynamic';

export default async function InviteAcceptPage({ params }: Props) {
  const invitation = await prisma.invitation.findUnique({
    where: { token: params.token },
    include: { invitedBy: { select: { name: true, email: true } } },
  });

  const expired = !invitation || invitation.expiresAt < new Date();
  const alreadyAccepted = !!invitation?.acceptedAt;

  if (!invitation || expired) {
    return (
      <ErrorCard
        title="Invitation expired"
        message="This invitation link is no longer valid. Ask your HHE program lead to send a new one."
      />
    );
  }

  if (alreadyAccepted) {
    return (
      <ErrorCard
        title="Already accepted"
        message="This invitation has already been claimed. If that's you, sign in from the home page."
      />
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-sm">
        <Card className="space-y-5 p-6 sm:p-8">
          <div className="space-y-2 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Sparkles className="h-5 w-5 text-muted-foreground" aria-hidden />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">You&apos;re invited.</h1>
            <p className="text-sm text-muted-foreground">
              {invitation.invitedBy?.name ?? 'An HHE admin'} invited{' '}
              <strong>{invitation.email}</strong> to claim a practitioner profile on Natural Health Pros.
            </p>
          </div>

          <Separator />

          <form
            action={async () => {
              'use server';
              await signIn('resend', {
                email: invitation.email,
                redirectTo: `/onboarding?invitation=${invitation.token}`,
              });
            }}
            className="space-y-3"
          >
            <button
              type="submit"
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Mail className="h-4 w-4" />
              Send sign-in link
            </button>
            <p className="text-center text-xs text-muted-foreground">
              We&apos;ll email <strong>{invitation.email}</strong> a one-click link to claim your
              profile.
            </p>
          </form>
        </Card>
      </div>
    </main>
  );
}

function ErrorCard({ title, message }: { title: string; message: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-sm">
        <Card className="space-y-3 p-6 sm:p-8 text-center">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{message}</p>
        </Card>
      </div>
    </main>
  );
}
