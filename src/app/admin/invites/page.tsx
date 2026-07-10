import { Mail, Send, Trash2, Check, Clock } from 'lucide-react';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { createInvitation, revokeInvitation, resendInvitation } from './actions';

export const dynamic = 'force-dynamic';

export default async function AdminInvitesPage() {
  const session = await auth();
  // ⚠️ TEMP — LOCAL TESTING ONLY: admin gate disabled. REVERT BEFORE PUSH.
  // if (!session?.user || session.user.role !== 'ADMIN') {
  //   redirect('/auth/signin?callbackUrl=/admin/invites');
  // }

  const invitations = await prisma.invitation.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { invitedBy: { select: { name: true, email: true } } },
  });

  const now = new Date();

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:py-14">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Practitioner invitations</h1>
          <p className="text-sm text-muted-foreground">
            Invite HHE-graduate practitioners to claim a profile. Magic-link delivered via email.
          </p>
        </header>

        <Card className="space-y-3 p-5">
          <h2 className="text-sm font-semibold">Send a new invitation</h2>
          <form action={createInvitation} className="flex flex-col gap-2 sm:flex-row">
            <input
              type="email"
              name="email"
              required
              placeholder="practitioner@example.com"
              className="h-10 flex-1 rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
            />
            <button
              type="submit"
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Send className="h-4 w-4" />
              Send invite
            </button>
          </form>
          <p className="text-xs text-muted-foreground">
            Resending to an email with a pending invitation reuses the existing link.
          </p>
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b bg-muted/40 px-5 py-3">
            <h2 className="text-sm font-semibold">
              Invitations <span className="text-muted-foreground">({invitations.length})</span>
            </h2>
          </div>
          {invitations.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              No invitations yet. Send your first one above.
            </p>
          ) : (
            <ul className="divide-y">
              {invitations.map((inv) => {
                const expired = inv.expiresAt < now;
                const status: 'accepted' | 'expired' | 'pending' = inv.acceptedAt
                  ? 'accepted'
                  : expired
                  ? 'expired'
                  : 'pending';
                return (
                  <li key={inv.id} className="flex items-center gap-3 px-5 py-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Mail className="h-4 w-4 text-muted-foreground" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{inv.email}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        Sent {inv.createdAt.toLocaleDateString()} ·{' '}
                        {inv.invitedBy?.name ?? inv.invitedBy?.email ?? 'system'}
                      </p>
                    </div>
                    {status === 'accepted' && (
                      <Badge variant="secondary" className="gap-1 text-[10px]">
                        <Check className="h-3 w-3" />
                        Accepted
                      </Badge>
                    )}
                    {status === 'pending' && (
                      <Badge variant="default" className="gap-1 text-[10px]">
                        <Clock className="h-3 w-3" />
                        Pending
                      </Badge>
                    )}
                    {status === 'expired' && (
                      <Badge variant="outline" className="text-[10px]">
                        Expired
                      </Badge>
                    )}
                    {(status === 'pending' || status === 'expired') && (
                      <form action={resendInvitation}>
                        <input type="hidden" name="id" value={inv.id} />
                        <button
                          type="submit"
                          aria-label={
                            expired
                              ? `Resend and reactivate invitation to ${inv.email}`
                              : `Resend invitation to ${inv.email}`
                          }
                          title={
                            expired ? 'Resend — reactivates this expired invite' : 'Resend invite'
                          }
                          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                        >
                          <Send className="h-3.5 w-3.5" />
                        </button>
                      </form>
                    )}
                    {status === 'pending' && (
                      <form action={revokeInvitation}>
                        <input type="hidden" name="id" value={inv.id} />
                        <button
                          type="submit"
                          aria-label={`Revoke invitation to ${inv.email}`}
                          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Separator />
        <p className="text-center text-xs text-muted-foreground">
          Admin · {session?.user?.email ?? 'TEST BYPASS'}
        </p>
      </div>
    </main>
  );
}
