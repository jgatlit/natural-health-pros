import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Mail, Send, Ban, Check, Clock, RotateCcw, Eye, EyeOff, Archive, ArchiveRestore, AlertTriangle } from 'lucide-react';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  createInvitation,
  createInvitationsBulk,
  revokeInvitation,
  resendInvitation,
  resetTrial,
  deleteInvitation,
  setDelisted,
  setArchived,
  updateInvitationEmail,
} from './actions';
import { DeleteInviteButton } from './DeleteInviteButton';
import { ConfirmActionButton } from './ConfirmActionButton';
import { EditEmailControl } from './EditEmailControl';

export const dynamic = 'force-dynamic';

export default async function AdminInvitesPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/invites');
  }

  const showArchived = searchParams?.archived === '1';
  const errorCode = typeof searchParams?.error === 'string' ? searchParams.error : null;
  const notice = typeof searchParams?.notice === 'string' ? searchParams.notice : null;
  const bulkCreated = typeof searchParams?.bulk_created === 'string' ? searchParams.bulk_created : null;
  const bulkReused = typeof searchParams?.bulk_reused === 'string' ? Number(searchParams.bulk_reused) : 0;
  const bulkInvalid = typeof searchParams?.bulk_invalid === 'string' ? Number(searchParams.bulk_invalid) : 0;
  const bulkFailed = typeof searchParams?.bulk_failed === 'string' ? Number(searchParams.bulk_failed) : 0;
  const bulkOverflow = typeof searchParams?.bulk_overflow === 'string' ? Number(searchParams.bulk_overflow) : 0;
  const bulkInvalidList =
    typeof searchParams?.bulk_invalid_list === 'string' ? searchParams.bulk_invalid_list : null;
  const bulkFailedList =
    typeof searchParams?.bulk_failed_list === 'string' ? searchParams.bulk_failed_list : null;

  const allInvitations = await prisma.invitation.findMany({
    // Cohort sign-ups have their own list (/admin/signups); they would otherwise bury admin invites.
    where: { cohortId: null },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      invitedBy: { select: { name: true, email: true } },
      acceptedByUser: {
        select: {
          // role + subscriptionStatus, not just the date: they OVERRIDE the clock in
          // isListed(), so a label read off trialEndsAt alone calls a paying subscriber
          // "trial expired" and an exempt admin "pre-trial" — and this is the screen with
          // the Reset button on it.
          role: true,
          // Same shape as the byEmail fallback below — the two are used interchangeably at the
          // call site, so a narrower select here would make the row's controls depend on which
          // branch resolved it.
          practitioner: {
            select: {
              id: true,
              slug: true,
              displayName: true,
              trialEndsAt: true,
              subscriptionStatus: true,
              delistedAt: true,
              archivedAt: true,
            },
          },
        },
      },
    },
  });

  /*
   * Resolve each row's practitioner by EMAIL, not by acceptedByUser.
   *
   * Twelve of the eighteen invitations were never accepted (they expired 2026-06-28), yet their
   * practitioners exist and were operator-seeded — so keying the directory controls off
   * `acceptedByUser` would render them on four rows and hide them from exactly the twelve
   * profiles an operator needs to manage. `acceptedByUser` is still preferred where it exists;
   * this is a fallback, not a replacement.
   */
  const byEmail = new Map(
    (
      await prisma.user.findMany({
        where: { email: { in: allInvitations.map((i) => i.email) } },
        select: {
          email: true,
          role: true,
          practitioner: {
            select: {
              id: true,
              slug: true,
              displayName: true,
              trialEndsAt: true,
              subscriptionStatus: true,
              delistedAt: true,
              archivedAt: true,
            },
          },
        },
      })
    ).map((u) => [u.email.toLowerCase(), u]),
  );

  const resolve = (email: string) => byEmail.get(email.toLowerCase()) ?? null;

  // Archived profiles drop out of the default view — that is what makes archive a soft DELETE
  // rather than another flag. They stay one click away rather than becoming unreachable.
  //
  // Counted by DISTINCT PRACTITIONER, not by row. One practitioner legitimately holds several
  // invitations (jgatlit@gmail.com has two), and archiving is per-practitioner — so counting rows
  // reported "(2)" after archiving ONE person, which reads as two people archived. Observed live
  // 2026-08-18.
  const archivedPractitionerIds = new Set(
    allInvitations
      .map((inv) => resolve(inv.email)?.practitioner)
      .filter((p) => p?.archivedAt)
      .map((p) => p!.id),
  );
  const archivedCount = archivedPractitionerIds.size;
  const invitations = showArchived
    ? allInvitations
    : allInvitations.filter((inv) => !resolve(inv.email)?.practitioner?.archivedAt);

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

        {/*
          Surfaced, not swallowed. A delist writes a column AND pushes to Typesense, and the push
          is the half that can fail — search is a separate system with its own availability. If
          the operator is told "hidden" while the practitioner is still returned by /search, the
          screen has lied about the only thing it was asked to do.
        */}
        {errorCode === 'index-out-of-sync' && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <p>
              <span className="font-medium">Saved, but search was not updated.</span> The profile
              flag changed in the database and the Typesense push did not confirm — this
              practitioner may still appear in search. Retry the toggle; if it keeps failing, run{' '}
              <code className="rounded bg-muted px-1">npm run typesense:reindex</code>.
            </p>
          </div>
        )}
        {notice === 'index-unverified' && (
          <div className="flex items-start gap-2 rounded-md border px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <p>
              Saved. Search was <span className="font-medium">not</span> checked — Typesense is not
              configured in this environment, so nothing was pushed and nothing was verified. On
              production this notice should never appear.
            </p>
          </div>
        )}
        {(errorCode === 'email-taken' || errorCode === 'bad-email') && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <p>
              {errorCode === 'email-taken' ? (
                <>
                  <span className="font-medium">That address already belongs to another
                  account.</span>{' '}
                  Nothing was changed. Merging the two would hand this profile to whoever holds
                  the other address, so it is refused rather than guessed at.
                </>
              ) : (
                <>
                  <span className="font-medium">That is not a usable email address.</span> Nothing
                  was changed.
                </>
              )}
            </p>
          </div>
        )}
        {bulkCreated !== null && (
          <div className="flex items-start gap-2 rounded-md border px-4 py-3 text-sm">
            <Send className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="space-y-1">
              <p>
                <span className="font-medium">Bulk invite: {bulkCreated} new invitation email{bulkCreated === '1' ? '' : 's'} sent</span>
                {bulkReused > 0 &&
                  // Reused means the LINK was reused, not that no email went out — sending an
                  // email is unconditional in inviteOne(). Saying otherwise here would tell an
                  // admin a re-paste is free when it isn't.
                  `, plus ${bulkReused} resent to addresses with an existing pending invitation`}
                .
              </p>
              {bulkInvalid > 0 && (
                <p className="text-muted-foreground">
                  {bulkInvalid} skipped as not a usable email address
                  {bulkInvalidList ? `: ${bulkInvalidList}` : ''}.
                </p>
              )}
              {bulkFailed > 0 && (
                <p className="text-destructive">
                  {bulkFailed} failed to send{bulkFailedList ? `: ${bulkFailedList}` : ''} — safe
                  to retry just these, resending the whole list would re-invite everyone above too.
                </p>
              )}
              {bulkOverflow > 0 && (
                <p className="text-destructive">
                  {bulkOverflow} address{bulkOverflow === 1 ? '' : 'es'} at the end of the paste{' '}
                  {bulkOverflow === 1 ? 'was' : 'were'} not sent — one submission is capped at 50.
                  Paste the rest separately.
                </p>
              )}
            </div>
          </div>
        )}
        {errorCode === 'no-profile' && (
          <div className="flex items-start gap-2 rounded-md border px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <p>That invitation has no practitioner profile attached, so there is nothing to hide.</p>
          </div>
        )}

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

        <Card className="space-y-3 p-5">
          <h2 className="text-sm font-semibold">Bulk invite</h2>
          <form action={createInvitationsBulk} className="flex flex-col gap-2">
            <textarea
              name="emails"
              required
              rows={4}
              aria-label="Email addresses to invite, one per line or comma-separated"
              placeholder={'One email per line, or paste a comma-separated list —\npractitioner1@example.com\npractitioner2@example.com'}
              className="w-full resize-y rounded-md border bg-card px-3 py-2 text-sm outline-none ring-ring/30 focus-visible:ring-2"
            />
            <button
              type="submit"
              className="inline-flex h-10 w-fit items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Send className="h-4 w-4" />
              Send all invites
            </button>
          </form>
          <p className="text-xs text-muted-foreground">
            Same behavior as a single invite, run once per address — duplicates in the list are
            only invited once, and an address with a pending invitation gets that link resent
            (not a second, separate one). Capped at 50 addresses per submission.
          </p>
        </Card>

        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-5 py-3">
            <h2 className="text-sm font-semibold">
              Invitations <span className="text-muted-foreground">({invitations.length})</span>
            </h2>
            {(archivedCount > 0 || showArchived) && (
              <Link
                href={showArchived ? '/admin/invites' : '/admin/invites?archived=1'}
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                {showArchived
                  ? 'Hide archived'
                  : `Show ${archivedCount} archived practitioner${archivedCount === 1 ? '' : 's'}`}
              </Link>
            )}
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
                const resolved = resolve(inv.email);
                const practitioner = inv.acceptedByUser?.practitioner ?? resolved?.practitioner;
                const ownerRole = inv.acceptedByUser?.role ?? resolved?.role ?? null;
                const delisted = Boolean(practitioner?.delistedAt);
                const archived = Boolean(practitioner?.archivedAt);
                const trialEndsAt = practitioner?.trialEndsAt ?? null;
                const trialDaysLeft = trialEndsAt
                  ? Math.ceil((trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
                  : null;
                // Same precedence as isListed(): admin and a live subscription both outrank
                // the clock, so say so instead of reporting a stale countdown underneath them.
                const trialLabel =
                  ownerRole === 'ADMIN'
                    ? 'admin · exempt'
                    : practitioner?.subscriptionStatus === 'ACTIVE'
                    ? 'subscribed'
                    : practitioner?.subscriptionStatus === 'PAST_DUE'
                    ? 'past due'
                    : trialEndsAt === null
                    ? 'pre-trial'
                    : trialDaysLeft !== null && trialDaysLeft > 0
                    ? `${trialDaysLeft}d left`
                    : 'trial expired';
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
                    {status === 'accepted' && practitioner && (
                      <span className="whitespace-nowrap text-[10px] text-muted-foreground">
                        {trialLabel}
                      </span>
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
                    {status === 'accepted' && practitioner && (
                      <form action={resetTrial}>
                        <input type="hidden" name="id" value={inv.id} />
                        <button
                          type="submit"
                          aria-label={`Reset trial for ${inv.email}`}
                          title="Reset trial — 90 days from today"
                          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      </form>
                    )}
                    {/* Revoke kills the live link but keeps the row; delete clears it from the
                        list. Both are offered on pending rows because they are different
                        intents — "this link should stop working" vs "this was a mistake".
                        Accepted rows get neither: revoke is meaningless once they are in, and
                        deleting would sever the acceptedByUserId relation resetTrial walks. */}
                    {status === 'pending' && (
                      <form action={revokeInvitation}>
                        <input type="hidden" name="id" value={inv.id} />
                        <button
                          type="submit"
                          aria-label={`Revoke invitation to ${inv.email}`}
                          title="Revoke — kills the link, keeps the row"
                          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Ban className="h-3.5 w-3.5" />
                        </button>
                      </form>
                    )}
                    {/*
                      Correcting the address in place is what prevents a duplicate profile:
                      re-inviting a corrected email creates a NEW User, which has no
                      practitioner, so onboarding takes its create branch and the same person
                      ends up with a second row. That is how the duplicate sarah-schindler row
                      happened.
                    */}
                    <EditEmailControl id={inv.id} email={inv.email} action={updateInvitationEmail} />
                    {/*
                      Directory controls. Rendered whenever a PROFILE exists — not only on
                      accepted rows — because the twelve seeded pilots have profiles and no
                      accepted invitation, and they are the ones most likely to need hiding.

                      Delist and archive are deliberately separate controls rather than one
                      three-state widget: delisting hides a WORKING practice from search while
                      her own booking link keeps taking clients, and archiving closes the
                      practice. Collapsing them would make the safe action and the destructive
                      one adjacent positions of the same switch.
                    */}
                    {practitioner && !archived && (
                      <>
                        <Badge
                          variant={delisted ? 'outline' : 'secondary'}
                          className="whitespace-nowrap text-[10px]"
                        >
                          {delisted ? 'Hidden' : 'Listed'}
                        </Badge>
                        <form action={setDelisted}>
                          <input type="hidden" name="id" value={inv.id} />
                          <input type="hidden" name="on" value={delisted ? '0' : '1'} />
                          <button
                            type="submit"
                            aria-label={
                              delisted
                                ? `List ${practitioner.displayName} in the directory again`
                                : `Hide ${practitioner.displayName} from the directory`
                            }
                            title={
                              delisted
                                ? 'Show in directory again'
                                : 'Hide from directory — profile URL and booking keep working'
                            }
                            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                          >
                            {delisted ? (
                              <Eye className="h-3.5 w-3.5" />
                            ) : (
                              <EyeOff className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </form>
                        <ConfirmActionButton
                          action={setArchived}
                          fields={{ id: inv.id, on: '1' }}
                          icon={<Archive className="h-3.5 w-3.5" />}
                          idleLabel={`Archive ${practitioner.displayName}'s profile`}
                          idleTitle="Archive — removes from directory and stops booking. Reversible."
                          confirmText="Archive"
                          confirmLabel={`Confirm archiving ${practitioner.displayName}'s profile`}
                        />
                      </>
                    )}
                    {practitioner && archived && (
                      <>
                        <Badge variant="outline" className="whitespace-nowrap text-[10px]">
                          Archived
                        </Badge>
                        <form action={setArchived}>
                          <input type="hidden" name="id" value={inv.id} />
                          <input type="hidden" name="on" value="0" />
                          <button
                            type="submit"
                            aria-label={`Restore ${practitioner.displayName}'s profile`}
                            title="Restore — returns to the directory and to booking"
                            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                          >
                            <ArchiveRestore className="h-3.5 w-3.5" />
                          </button>
                        </form>
                      </>
                    )}
                    {status !== 'accepted' && (
                      <DeleteInviteButton
                        id={inv.id}
                        email={inv.email}
                        action={deleteInvitation}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Separator />
        <p className="text-center text-xs text-muted-foreground">
          Admin · {session.user.email}
        </p>
      </div>
    </main>
  );
}
