import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PendingButton } from '@/components/practitioners/PendingButton';
import { safeHttpUrl } from '@/lib/join-request';
import { approveJoinRequest, declineJoinRequest } from './actions';

export const dynamic = 'force-dynamic';

type Props = { searchParams: { error?: string; done?: string } };

const ERRORS: Record<string, string> = {
  'not-found': 'That request no longer exists.',
  'not-pending': 'That request was already handled.',
  'has-profile': 'This email already has a practitioner profile, so no invitation was sent.',
  'invalid-email': 'The email on that request is not valid, so no invitation was sent.',
  'send-failed': 'The invitation email could not be sent. The request is still pending; try again.',
  'decline-email-failed': 'The request was declined, but the email to the requester could not be sent.',
};

const DONE: Record<string, string> = {
  approved: 'Approved. The invitation email is on its way.',
  declined: 'Declined.',
};

const STATUS_VARIANT = { PENDING: 'default', APPROVED: 'secondary', DECLINED: 'outline' } as const;

export default async function AdminJoinRequestsPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/requests');
  }

  const requests = await prisma.joinRequest.findMany({
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 200,
    include: { reviewedBy: { select: { email: true } } },
  });

  const emails = Array.from(new Set(requests.map((r) => r.email)));
  const [owners, pendingRequests, pendingInvitations] = await Promise.all([
    prisma.user.findMany({
      where: { email: { in: emails }, practitioner: { isNot: null } },
      select: { email: true, practitioner: { select: { slug: true } } },
    }),
    prisma.joinRequest.findMany({
      where: { email: { in: emails }, status: 'PENDING' },
      select: { id: true, email: true },
    }),
    prisma.invitation.findMany({
      where: { email: { in: emails }, acceptedAt: null, expiresAt: { gt: new Date() } },
      select: { email: true },
    }),
  ]);

  const profileSlug = new Map(owners.map((u) => [u.email, u.practitioner?.slug ?? null]));
  const invited = new Set(pendingInvitations.map((i) => i.email));
  const otherPending = (id: string, email: string) =>
    pendingRequests.some((p) => p.email === email && p.id !== id);

  const error = searchParams.error ? ERRORS[searchParams.error] : undefined;
  const done = searchParams.done ? DONE[searchParams.done] : undefined;
  const pendingCount = requests.filter((r) => r.status === 'PENDING').length;

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:py-14">
      <div className="mx-auto max-w-4xl space-y-4">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Admin
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Join requests</h1>
        <p className="text-sm text-muted-foreground">
          Requests from the public <code className="text-xs">/join</code> form. Approving sends the
          normal invitation email; nothing is created for a request until it is approved.
        </p>

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {done && !error && (
          <div className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm">{done}</div>
        )}

        <Card className="space-y-3 p-4 sm:p-6">
          <h2 className="text-sm font-semibold">
            Requests ({pendingCount} pending of {requests.length})
          </h2>
          {requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No one has requested to join yet.</p>
          ) : (
            <ul className="divide-y">
              {requests.map((r) => {
                const slug = profileSlug.get(r.email) ?? null;
                const website = safeHttpUrl(r.website);
                const flags = [
                  slug && 'Already has a practitioner profile',
                  otherPending(r.id, r.email) && 'Another pending request from this email',
                  invited.has(r.email) && 'Has a pending invitation',
                ].filter(Boolean) as string[];

                return (
                  <li key={r.id} className="space-y-2 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.name}</span>
                      <span className="text-muted-foreground">{r.email}</span>
                      <Badge variant={STATUS_VARIANT[r.status]}>{r.status.toLowerCase()}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {r.createdAt.toISOString().slice(0, 10)}
                      </span>
                    </div>
                    <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[10rem_1fr]">
                      <dt className="text-muted-foreground">Training or credential</dt>
                      <dd className="whitespace-pre-wrap break-words">{r.credential}</dd>
                      {r.website && (
                        <>
                          <dt className="text-muted-foreground">Website or social</dt>
                          <dd className="break-words">
                            {website ? (
                              <a
                                href={website}
                                target="_blank"
                                rel="noopener noreferrer nofollow"
                                className="underline"
                              >
                                {r.website}
                              </a>
                            ) : (
                              r.website
                            )}
                          </dd>
                        </>
                      )}
                      {r.note && (
                        <>
                          <dt className="text-muted-foreground">Note</dt>
                          <dd className="whitespace-pre-wrap break-words">{r.note}</dd>
                        </>
                      )}
                      {r.reviewedAt && (
                        <>
                          <dt className="text-muted-foreground">Reviewed</dt>
                          <dd>
                            {r.reviewedAt.toISOString().slice(0, 10)}
                            {r.reviewedBy?.email && ` by ${r.reviewedBy.email}`}
                          </dd>
                        </>
                      )}
                    </dl>

                    {flags.length > 0 && (
                      <ul className="space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
                        {flags.map((f) => (
                          <li key={f}>
                            {f}
                            {f.startsWith('Already') && slug && (
                              <>
                                {' '}
                                <Link className="underline" href={`/practitioners/${slug}`}>
                                  view profile
                                </Link>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}

                    {r.status === 'PENDING' && (
                      <div className="flex flex-wrap items-center gap-3">
                        {slug ? (
                          <span className="text-xs text-muted-foreground">
                            Approve is unavailable: this email already has a profile.
                          </span>
                        ) : (
                          <form action={approveJoinRequest}>
                            <input type="hidden" name="id" value={r.id} />
                            <PendingButton
                              pendingLabel="Approving…"
                              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                            >
                              Approve and invite
                            </PendingButton>
                          </form>
                        )}
                        <form action={declineJoinRequest} className="flex items-center gap-2">
                          <input type="hidden" name="id" value={r.id} />
                          <label className="flex items-center gap-1 text-xs text-muted-foreground">
                            <input type="checkbox" name="notify" />
                            Email them
                          </label>
                          <PendingButton
                            pendingLabel="Declining…"
                            className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-60"
                          >
                            Decline
                          </PendingButton>
                        </form>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </main>
  );
}
