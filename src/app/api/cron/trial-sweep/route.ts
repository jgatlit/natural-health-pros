import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { indexPractitioner } from '@/lib/practitioner-indexer';
import { SITE_URL } from '@/lib/site';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 90-day pilot-trial sweep (see docs/superpowers/specs/2026-07-16-pilot-trial-design.md).
 * Wired as a Vercel Cron in vercel.json, once daily. Two jobs, in order:
 *
 *   1. WARN  — email at T-14 / T-3 / T-0 before `Practitioner.trialEndsAt`, so expiry is
 *              never a surprise.
 *   2. ENFORCE — delist trials that have actually lapsed (see the block at the bottom).
 *
 * The second half is the one that makes the paywall real; without it an expired pilot stays
 * in /search indefinitely. Warning without enforcing would be theatre.
 *
 * Auth: same shape as /api/health/search — when CRON_SECRET is set, requires
 * `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends this automatically). When
 * unset (e.g. local dev), the endpoint is open so it can be curled directly.
 *
 * IDEMPOTENCY — read before changing the bucket math.
 * The schema is frozen for this PR (no "warningsSent" tracking column), so bucket
 * membership is derived *purely* from the deterministic relationship between
 * `trialEndsAt`'s calendar day and today's calendar day (both in UTC):
 *   T-14 matches only on the single day where today + 14d == trialEndsAt's day
 *   T-3  matches only on the single day where today + 3d  == trialEndsAt's day
 *   T-0  matches only on the single day where today       == trialEndsAt's day
 * Since `trialEndsAt` is fixed once onboarding sets it, each (practitioner, bucket)
 * pair satisfies its day-window on exactly one calendar day. A daily cron that runs
 * once per day therefore cannot re-send a given warning on a later run — the window
 * it matched has already closed.
 *
 * RESIDUAL EXPOSURE (honest, not solved): if THIS SAME calendar day's invocation
 * fires more than once — a Vercel retry, a manual re-trigger, a platform double-fire
 * — the query has no memory of the earlier run and will re-send the same warning to
 * the same practitioners. Calendar-day bucketing only protects against repeats
 * *across* days, not within one. Closing that gap for real needs a durable
 * "already sent (practitioner, bucket, day)" record — explicitly out of scope here
 * because the schema is frozen for this PR. A double-send is a duplicate warning
 * email, never a silent one, so it fails in the safe direction for what this route
 * exists to prevent.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type BucketLabel = 'T-14' | 'T-3' | 'T-0';

const BUCKETS: { label: BucketLabel; offsetDays: number }[] = [
  { label: 'T-14', offsetDays: 14 },
  { label: 'T-3', offsetDays: 3 },
  { label: 'T-0', offsetDays: 0 },
];

function startOfUTCDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function warningCopy(offsetDays: number, trialEndsAt: Date, slug: string) {
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(trialEndsAt);

  const subject =
    offsetDays === 0
      ? 'Your Natural Health Pros trial ends today'
      : `Your Natural Health Pros trial ends in ${offsetDays} days`;

  const when = offsetDays === 0 ? `today (${dateLabel})` : `in ${offsetDays} days, on ${dateLabel}`;
  const manageUrl = `${SITE_URL}/practitioners/${slug}/edit`;

  // TRANSACTIONAL SHAPE, deliberately plain — see src/auth.ts#sendBrandedVerificationRequest.
  // A pretty branded email with a pitch and a styled CTA button landed in Gmail's Promotions
  // tab. Action-first subject, no pitch, a plain visible URL, no button, no card layout.
  const text = [
    `Your free trial listing on Natural Health Pros ends ${when}.`,
    '',
    'Subscribe to stay listed in directory search ($59/mo):',
    manageUrl,
    '',
    'If you do nothing, your profile stays live at its direct link, but stops appearing in directory search once the trial ends.',
  ].join('\n');

  const html = `<div style="font-family: -apple-system, system-ui, sans-serif; font-size: 15px; line-height: 1.6; color: #1a1a1a;">
<p>Your free trial listing on Natural Health Pros ends ${when}.</p>
<p>Subscribe to stay listed in directory search ($59/mo): <a href="${manageUrl}">${manageUrl}</a></p>
<p style="color:#666;">If you do nothing, your profile stays live at its direct link, but stops appearing in directory search once the trial ends.</p>
</div>`;

  return { subject, text, html };
}

type BucketSummary = { matched: number; sent: number; skipped: number; failed: number };

export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Missing config, not an empty result — silently reporting "sent: 0" here would be
    // exactly the kind of silent failure this route exists to prevent. Fail loud instead.
    console.error('[trial-sweep] RESEND_API_KEY is not set; cannot send warnings');
    return NextResponse.json({ error: 'RESEND_API_KEY is not configured' }, { status: 500 });
  }
  const from = process.env.EMAIL_FROM ?? 'Natural Health Pros <onboarding@resend.dev>';

  const today = startOfUTCDay(new Date());
  const summary: Record<BucketLabel, BucketSummary> = {
    'T-14': { matched: 0, sent: 0, skipped: 0, failed: 0 },
    'T-3': { matched: 0, sent: 0, skipped: 0, failed: 0 },
    'T-0': { matched: 0, sent: 0, skipped: 0, failed: 0 },
  };
  const failures: { bucket: BucketLabel | 'delist'; practitionerId: string; error: string }[] = [];

  for (const bucket of BUCKETS) {
    const dayStart = new Date(today.getTime() + bucket.offsetDays * DAY_MS);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);

    // Day-window (>= start, < end), not an exact timestamp match — a daily cron will
    // never land on the exact instant trialEndsAt was set. Admins are exempt from the
    // clock entirely; ACTIVE/PAST_DUE practitioners are already paying (PAST_DUE is
    // Whop's dunning grace, not a trial state) so there's nothing to warn about. A
    // null trialEndsAt (pre-trial, no clock running) can never fall inside a finite
    // day-window, so it's excluded implicitly.
    const practitioners = await prisma.practitioner.findMany({
      where: {
        trialEndsAt: { gte: dayStart, lt: dayEnd },
        subscriptionStatus: { notIn: ['ACTIVE', 'PAST_DUE'] },
        user: { role: { not: 'ADMIN' } },
      },
      select: {
        id: true,
        slug: true,
        trialEndsAt: true,
        user: { select: { email: true } },
      },
    });

    const stats = summary[bucket.label];
    stats.matched = practitioners.length;

    for (const p of practitioners) {
      if (!p.user.email || !p.trialEndsAt) {
        stats.skipped += 1;
        continue;
      }

      const { subject, text, html } = warningCopy(bucket.offsetDays, p.trialEndsAt, p.slug);

      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: p.user.email, subject, html, text }),
        });
        if (!res.ok) {
          throw new Error(`Resend ${res.status}: ${JSON.stringify(await res.json())}`);
        }
        stats.sent += 1;
      } catch (err) {
        // Fail soft: one bad send must not abort the run for everyone else.
        const message = err instanceof Error ? err.message : String(err);
        stats.failed += 1;
        failures.push({ bucket: bucket.label, practitionerId: p.id, error: message });
        console.error(
          '[trial-sweep] SEND FAILED',
          JSON.stringify({ bucket: bucket.label, practitionerId: p.id, error: message }),
        );
      }
    }
  }

  // ENFORCEMENT — this is what actually applies the paywall, and it has to live in a cron.
  //
  // Every other indexPractitioner() call in this codebase hangs off an EVENT: onboarding, a
  // profile edit, a Whop webhook, an admin specialty change. Trial expiry is not an event —
  // it's the absence of one, a timestamp quietly passing with nobody there to react. So
  // without this sweep the Typesense doc for an expired pilot is never rewritten and they stay
  // in /search forever, while the home page (which evaluates listedWhere() per query) correctly
  // drops them. Two surfaces, same rule, opposite answers — and the dashboard would be telling
  // them "subscribe to return to the directory" while they were still in it.
  //
  // indexPractitioner() re-derives isListed() from the DB and upserts or deletes accordingly,
  // so this self-heals in BOTH directions: it delists a lapsed trial, and it re-lists someone
  // who subscribed while the Whop webhook was failing. Idempotent — a delete of an
  // already-absent doc is swallowed — so re-running it costs nothing but is never wrong.
  //
  // Re-sweeps every expired practitioner daily, forever, rather than tracking who's already
  // been delisted. At pilot scale (~20) that's a few no-op calls a day and it stays correct
  // with no extra state to drift. Revisit if the cohort reaches the hundreds.
  const expired = await prisma.practitioner.findMany({
    where: {
      trialEndsAt: { lt: new Date() },
      subscriptionStatus: { notIn: ['ACTIVE', 'PAST_DUE'] },
      user: { role: { not: 'ADMIN' } },
    },
    select: { id: true },
  });

  const delisted = { matched: expired.length, reconciled: 0, failed: 0 };
  for (const p of expired) {
    try {
      await indexPractitioner(p.id);
      delisted.reconciled += 1;
    } catch (err) {
      // Fail soft, but LOUD: a practitioner stuck in search past their trial is a billing
      // hole, and a silent catch here would hide it indefinitely.
      const message = err instanceof Error ? err.message : String(err);
      delisted.failed += 1;
      failures.push({ bucket: 'delist', practitionerId: p.id, error: message });
      console.error(
        '[trial-sweep] DELIST FAILED',
        JSON.stringify({ practitionerId: p.id, error: message }),
      );
    }
  }

  const ok = failures.length === 0;
  return NextResponse.json({ ok, summary, delisted, failures }, { status: ok ? 200 : 207 });
}
