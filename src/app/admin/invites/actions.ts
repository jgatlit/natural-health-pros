'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { newToken } from '@/lib/tokens';
import { normalizeEmail } from '@/lib/email';
import { INVITATION_TTL_MS, inviteOne, sendInviteMagicLink } from '@/lib/admin-invite';
import {
  indexPractitioner,
  indexPractitionerVerified,
  RETIREMENT_SENTINEL,
} from '@/lib/practitioner-indexer';

const TRIAL_DAYS = 90;
const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

async function requireAdmin() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/invites');
  }
  return session;
}

export async function createInvitation(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const email = String(formData.get('email') ?? '');
  const outcome = await inviteOne(email, session.user.id);

  if (outcome === 'invalid') redirect('/admin/invites?error=invalid-email');
  if (outcome === 'send-failed') redirect('/admin/invites?error=send-failed');

  revalidatePath('/admin/invites');
}

/**
 * Hard cap on one bulk-invite submission. Two reasons, not one: it bounds the wall-clock of a
 * sequential loop that does a Resend call per row, and — more importantly — it bounds the
 * unrecoverable-partial-state risk if the request DOES time out. Re-pasting after a partial run
 * would re-invite everyone who already succeeded (the send is unconditional, see `inviteOne`),
 * so keeping a single run small keeps that failure mode small too. 50 comfortably covers the
 * cohort this was built for (the first 15-17 practitioners) with room to grow.
 */
const MAX_BULK = 50;

/**
 * MANY EMAILS, ONE SUBMIT. Reuses `inviteOne` per address rather than reimplementing the
 * idempotency/rollback logic — a batch is just createInvitation run N times with the outcomes
 * collected instead of redirected on.
 *
 * Sequential, not Promise.all: each row hits Resend + Postgres, and running 17 of those
 * concurrently against a magic-link sender that's already a rate-limit target elsewhere in this
 * app is the wrong place to first find that out. A CSV of this size is an admin paving a list,
 * not a hot path — a few seconds of sequential sends is the safe trade.
 *
 * Failed and invalid addresses are named back to the admin, not just counted — a bare "3 failed"
 * on a 20-row paste gives nobody anything to act on, and re-running the whole paste to retry
 * three rows would re-invite the seventeen that already worked.
 */
export async function createInvitationsBulk(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const raw = String(formData.get('emails') ?? '');

  // Accept newline, comma, or semicolon separated — whatever a practitioner list pastes in as.
  const allCandidates = raw
    .split(/[\n,;]+/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  const overflow = Math.max(0, allCandidates.length - MAX_BULK);
  const candidates = allCandidates.slice(0, MAX_BULK);

  const seen = new Set<string>();
  let created = 0;
  let reused = 0;
  const invalidEmails: string[] = [];
  const failedEmails: string[] = [];

  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    if (seen.has(normalized)) continue; // dedupe within the same paste
    seen.add(normalized);

    const outcome = await inviteOne(candidate, session.user.id);
    if (outcome === 'created') created += 1;
    else if (outcome === 'reused') reused += 1;
    else if (outcome === 'invalid') invalidEmails.push(candidate);
    else failedEmails.push(candidate);
  }

  revalidatePath('/admin/invites');

  const params = new URLSearchParams({
    bulk_created: String(created),
    bulk_reused: String(reused),
    bulk_invalid: String(invalidEmails.length),
    bulk_failed: String(failedEmails.length),
    bulk_overflow: String(overflow),
  });
  if (invalidEmails.length) params.set('bulk_invalid_list', invalidEmails.join(','));
  if (failedEmails.length) params.set('bulk_failed_list', failedEmails.join(','));
  redirect(`/admin/invites?${params.toString()}`);
}

export async function revokeInvitation(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) return;
  await prisma.invitation.update({
    where: { id },
    data: { expiresAt: new Date(0) },
  });
  revalidatePath('/admin/invites');
}

/**
 * Hard-delete an invitation row.
 *
 * Distinct from revokeInvitation, which backdates `expiresAt` and leaves the row in the list
 * forever — useful for killing a live link, useless for clearing the list. Operator asked for a
 * real delete (2026-08-12).
 *
 * ACCEPTED INVITATIONS ARE NEVER DELETED, and the guard is not cosmetic: `acceptedByUserId` is
 * the relation /admin/invites walks to reach the practitioner behind an invite, which is how
 * resetTrial finds them. Deleting an accepted row would sever that and take the record of how
 * that practitioner was admitted with it. Revoke is meaningless there too (they are already in),
 * so accepted rows simply have no destructive action — by design.
 */
export async function deleteInvitation(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) return;

  const invitation = await prisma.invitation.findUnique({
    where: { id },
    select: { acceptedAt: true },
  });
  if (!invitation) redirect('/admin/invites?error=not-found');
  if (invitation.acceptedAt) redirect('/admin/invites?error=already-accepted');

  await prisma.invitation.delete({ where: { id } });
  revalidatePath('/admin/invites');
}

export async function resendInvitation(formData: FormData): Promise<void> {
  // Guard still runs — only the (now-unused) session binding is dropped: the branded sender
  // composes the email, so this action no longer needs invitedByName.
  await requireAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) return;

  const invitation = await prisma.invitation.findUnique({ where: { id } });
  if (!invitation) redirect('/admin/invites?error=not-found');
  if (invitation.acceptedAt) redirect('/admin/invites?error=already-accepted');

  // Expired or revoked (expiresAt in the past) → reactivate with a FRESH token so
  // any previously-shared/revoked dead link stays dead. A still-valid pending invite
  // keeps its token so the link already emailed to the practitioner keeps working.
  const inactive = invitation.expiresAt <= new Date();
  const token = inactive ? newToken() : invitation.token;

  // Persist BEFORE sending (see createInvitation): the emailed magic link resolves this row,
  // so the reactivation must be committed before the recipient can click. On send failure we
  // restore the exact prior state, keeping the old guarantee that the stored row never
  // diverges from what was actually delivered.
  const prevToken = invitation.token;
  const prevExpires = invitation.expiresAt;
  await prisma.invitation.update({
    where: { id },
    data: {
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      ...(inactive ? { token } : {}),
    },
  });

  const sent = await sendInviteMagicLink(invitation.email, token);
  if (!sent) {
    // See createInvitation: a failed rollback is the one case that leaves the row diverged
    // from what was delivered, so it must be traceable rather than silently swallowed.
    await prisma.invitation
      .update({ where: { id }, data: { token: prevToken, expiresAt: prevExpires } })
      .catch((e) => console.error('[invite-rollback-failed] resend', { email: invitation.email, id }, e));
    redirect('/admin/invites?error=send-failed');
  }

  // Operator rule (2026-08-18): resending an invitation RESETS the recipient's pilot clock.
  // A trial that burned down while the person could not get in was never a trial. The twelve
  // pilots whose invitations expired 2026-06-28 are the case this exists for.
  //
  // Runs only AFTER a confirmed send, so a failed delivery cannot hand out 90 free days for an
  // email nobody received.
  await resetTrialForEmail(invitation.email);

  revalidatePath('/admin/invites');
  revalidatePath('/');
}

/**
 * Reset one practitioner's pilot clock, resolved by email. Two guards, both load-bearing:
 *
 * 1. **Never resurrect a RETIRED row.** `trialEndsAt` backdated to the epoch is this repo's
 *    retirement sentinel — `bookableWhere()` keys on it, and it is the only thing stopping a
 *    dead-mailbox duplicate (`sarah-schindler`, owner confirmed unreachable) from silently
 *    swallowing leads. Writing now+90d over it would un-retire that row and put a lead-eating
 *    profile back into circulation. Retirement is not a lapsed trial and must not be treated
 *    as one.
 *
 * 2. **Do not CREATE a clock that does not exist.** A null `trialEndsAt` means pre-trial —
 *    listed, free, no countdown — and every live practitioner is in that state because
 *    `PILOT_TRIAL_CLOCK_ENABLED` is unset. Starting a 90-day countdown for twelve pilots as a
 *    side effect of a button labelled "resend invite" would begin the paywall for the whole
 *    cohort without anyone deciding to. `scripts/backfill-trial-dates.ts` is the deliberate
 *    lever for that and should stay the only one. When the clock IS enabled, the same button
 *    resets and starts a real 90 days, exactly as specified.
 */
async function resetTrialForEmail(email: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { practitioner: { select: { id: true, trialEndsAt: true } } },
  });
  const practitioner = user?.practitioner;
  if (!practitioner) return;

  const isRetired =
    practitioner.trialEndsAt !== null && practitioner.trialEndsAt <= RETIREMENT_SENTINEL;
  if (isRetired) return;

  const clockEnabled = process.env.PILOT_TRIAL_CLOCK_ENABLED === 'true';
  if (practitioner.trialEndsAt === null && !clockEnabled) return;

  await prisma.practitioner.update({
    where: { id: practitioner.id },
    data: { trialEndsAt: new Date(Date.now() + TRIAL_MS) },
  });

  // Push-based index: a clock change that alters listing state must be sent, or /search and the
  // home page disagree. Same reasoning as resetTrial().
  await indexPractitioner(practitioner.id).catch((err) =>
    console.error('Typesense reindex failed after resend trial reset:', {
      practitionerId: practitioner.id,
      err,
    }),
  );
}

/**
 * Grants 90 more free-listing days from now. Reachable only on an ACCEPTED invitation: the
 * `acceptedByUser` relation is how this row reaches the practitioner it made — an unaccepted
 * invite has nobody to reset (see docs/superpowers/specs/2026-07-16-pilot-trial-design.md).
 */
export async function resetTrial(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) return;

  const invitation = await prisma.invitation.findUnique({
    where: { id },
    include: { acceptedByUser: { select: { practitioner: { select: { id: true } } } } },
  });
  if (!invitation) redirect('/admin/invites?error=not-found');

  const practitionerId = invitation.acceptedByUser?.practitioner?.id;
  if (!practitionerId) redirect('/admin/invites?error=not-found');

  await prisma.practitioner.update({
    where: { id: practitionerId },
    data: { trialEndsAt: new Date(Date.now() + TRIAL_MS) },
  });

  // Reindex is REQUIRED, not housekeeping. isListed() gates Typesense at write time, so
  // flipping this date in SQL alone does nothing to search — and the daily trial-sweep can't
  // clean up after us here, because it only visits practitioners whose trial has already
  // LAPSED (trialEndsAt < now). A freshly reset date is in the future, so it is invisible to
  // that sweep forever. Without this call, resetting an expired pilot brings them back on the
  // home page (which evaluates listedWhere() per query) and tells them "90 days left" on their
  // dashboard, while leaving them permanently absent from /search — the one surface the
  // subscription is actually sold on.
  await indexPractitioner(practitionerId).catch((err) =>
    console.error('Typesense reindex failed after trial reset:', { practitionerId, err }),
  );

  revalidatePath('/admin/invites');
}

/**
 * The /admin/invites directory controls.
 *
 * Both resolve the practitioner the SAME way, and it is not the obvious way. Keying off
 * `invitation.acceptedByUser` — which is how resetTrial does it — would put these controls on
 * four rows out of eighteen, because the twelve pilot practitioners were operator-seeded and
 * their invitations were never accepted (all twelve expired 2026-06-28). Those twelve are
 * precisely the profiles an operator needs to manage. So the practitioner is resolved by the
 * invitation's EMAIL, with acceptedByUser preferred when it exists.
 */
async function practitionerForInvitation(invitationId: string): Promise<string> {
  const invitation = await prisma.invitation.findUnique({
    where: { id: invitationId },
    select: {
      email: true,
      acceptedByUser: { select: { practitioner: { select: { id: true } } } },
    },
  });
  if (!invitation) redirect('/admin/invites?error=not-found');

  const accepted = invitation.acceptedByUser?.practitioner?.id;
  if (accepted) return accepted;

  const byEmail = await prisma.user.findUnique({
    where: { email: invitation.email },
    select: { practitioner: { select: { id: true } } },
  });
  const id = byEmail?.practitioner?.id;
  if (!id) redirect('/admin/invites?error=no-profile');
  return id;
}

/**
 * `redirect()` in Next.js works by THROWING. Any try/catch wrapped around a call to it swallows
 * the redirect and the navigation silently never happens — so the Typesense work is done first,
 * its outcome reduced to a plain value, and only then is redirect() reached, outside every catch.
 */
async function applyDirectoryFlag(
  formData: FormData,
  field: 'delistedAt' | 'archivedAt',
): Promise<void> {
  await requireAdmin();
  const invitationId = String(formData.get('id') ?? '');
  const on = String(formData.get('on') ?? '') === '1';
  if (!invitationId) return;

  const practitionerId = await practitionerForInvitation(invitationId);

  await prisma.practitioner.update({
    where: { id: practitionerId },
    data: { [field]: on ? new Date() : null },
  });

  // Typesense is push-based: flipping the column in SQL alone changes NOTHING about who appears
  // in /search. Nothing else will come along and fix it either — the trial sweep only visits
  // practitioners whose trial has lapsed, so a delisted pilot with a null trial clock is
  // invisible to it forever.
  const sync = await indexPractitionerVerified(practitionerId);

  revalidatePath('/admin/invites');
  revalidatePath('/');

  if (!sync.ok) {
    console.error('Directory flag reindex failed:', { practitionerId, field, on, sync });
    redirect('/admin/invites?error=index-out-of-sync');
  }
  if (!sync.verified) redirect('/admin/invites?notice=index-unverified');
}

/** Hide from DISCOVERY. The profile URL keeps working and booking keeps working. */
export async function setDelisted(formData: FormData): Promise<void> {
  await applyDirectoryFlag(formData, 'delistedAt');
}

/** Soft DELETE. Drops out of discovery AND booking; booking intents and payments are preserved. */
export async function setArchived(formData: FormData): Promise<void> {
  await applyDirectoryFlag(formData, 'archivedAt');
}

/**
 * ADMIN: correct the registered email on an invitation and its practitioner, together.
 *
 * This is the fix for the duplicate-practitioner trap. Until now the only way to correct a
 * mistyped address was to invite the right one — but the accept path resolves the practitioner
 * through `User`, and a different email is a different `User` with no practitioner, so
 * onboarding takes its create branch and the same human ends up with a SECOND profile. That is
 * exactly how the duplicate `sarah-schindler` row was created. Editing in place cannot produce
 * a duplicate because no new User is involved.
 *
 * Both rows move together, in one transaction. The onboarding gate compares the signed-in
 * email against `invitation.email`, so updating only the User would leave an invitation its own
 * recipient can no longer accept — a lockout created by the tool meant to fix one.
 */
export async function updateInvitationEmail(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get('id') ?? '');
  const next = normalizeEmail(String(formData.get('email') ?? ''));
  if (!id) return;
  if (!next) redirect('/admin/invites?error=bad-email');

  const invitation = await prisma.invitation.findUnique({
    where: { id },
    select: { email: true },
  });
  if (!invitation) redirect('/admin/invites?error=not-found');
  if (invitation.email.toLowerCase() === next) {
    revalidatePath('/admin/invites');
    return;
  }

  // Refuse rather than merge. Two people, or one person with two rows, are indistinguishable
  // from here — and silently attaching this invitation to an existing account would hand one
  // person's profile to whoever holds the other address.
  const collision = await prisma.user.findUnique({ where: { email: next }, select: { id: true } });
  if (collision) redirect('/admin/invites?error=email-taken');

  const owner = await prisma.user.findUnique({
    where: { email: invitation.email },
    select: { id: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.invitation.update({ where: { id }, data: { email: next } });
    if (owner) await tx.user.update({ where: { id: owner.id }, data: { email: next } });
  });

  revalidatePath('/admin/invites');
}
