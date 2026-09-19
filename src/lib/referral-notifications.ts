/**
 * REFERRAL NOTIFICATIONS (spec v1.4 §5.5 / R10, operator ruling 7 / R15).
 *
 * The SELECTION rules and the COPY, kept pure and separate from the sweep that sends them — the
 * sweep owns the I/O, this owns the decisions, and only the decisions are worth asserting.
 *
 * Four constraints carried from code that already exists here, each paid for once:
 *
 *  1. NOTHING SENDS FROM THE WHOP WEBHOOK. Whop retries 3× over ~70 s and then drops the event
 *     permanently; a Resend round-trip inside that handler risks the payment record itself.
 *  2. A DURABLE MARKER COLUMN, NEVER `idempotencyKey` ALONE. Resend de-duplicates for 24 HOURS,
 *     and nothing removes these rows from the candidate set, so a key alone means "one email a
 *     day, forever". `bookedNoticeSentAt` and `notifiedAt` are the real guards.
 *  3. `notifyLeadsImmediately` GATES LEAD EMAILS ONLY and must not gate either notice below. Being
 *     told you are owed money is not a marketing preference.
 *  4. NOTHING HERE NAMES THE CLIENT. A copied link is opened by an anonymous visitor, so the
 *     referrer may never have known who it was; and §5.5 withholds the client's identity from the
 *     referred practitioner until they book.
 *
 * ⚠️ ON "IMMEDIATELY". Ruling 7 says the unpayable-referrer notice goes out immediately. It is
 * sent from the 15-minute sweep, so in practice that is "within 15 minutes". The alternative —
 * sending inside the webhook — trades a guaranteed payment record for a few minutes of latency,
 * which is the wrong trade. Stated here rather than papered over.
 */

import { escapeHtml } from './email';

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** A referred booking that has been paid and whose referrer has not been told. */
export function referralsNeedingBookedNotice<
  T extends { bookedNoticeSentAt: Date | null; paidAt: Date | null },
>(rows: T[]): T[] {
  return rows.filter((r) => r.paidAt !== null && r.bookedNoticeSentAt === null);
}

/**
 * A HELD share whose referrer has not yet been told to claim their Whop account (R15).
 *
 * ⚠️ `EXPIRED_UNCLAIMED` IS DELIBERATELY EXCLUDED. Day-91 policy is unruled (operator,
 * 2026-09-18), and mailing somebody about money whose fate nobody has decided makes a promise the
 * product cannot keep. Those rows are surfaced in admin with their total and nothing else.
 */
export function referralsNeedingClaimNotice<T extends { state: string; notifiedAt: Date | null }>(
  rows: T[],
): T[] {
  return rows.filter((r) => r.state === 'HELD' && r.notifiedAt === null);
}

export function referralBookedCopy(input: {
  referredName: string;
  /** Pre-formatted, so no template renders a percentage a second way. */
  rateLabel: string;
  termMonths: number;
}): { subject: string; text: string; html: string } {
  const who = input.referredName;
  const subject = `Your referral booked with ${who}`;
  const lines = [
    `Someone you referred has booked with ${who}.`,
    '',
    `You earn ${input.rateLabel} of what they book with ${who} for ${input.termMonths} months from` +
      ' their first session.',
    '',
    // Says where the money comes from, because it does NOT arrive from us directly — the same
    // question the paid-practitioner notice already had to answer.
    'Payments reach you through your connected Whop account.',
  ];
  return {
    subject,
    text: lines.join('\n'),
    html: `<div style="font-family: -apple-system, system-ui, sans-serif; font-size: 15px; line-height: 1.6; color: #1a1a1a;">
<p>Someone you referred has booked with ${escapeHtml(who)}.</p>
<p>You earn ${escapeHtml(input.rateLabel)} of what they book with ${escapeHtml(who)} for ${
      input.termMonths
    } months from their first session.</p>
<p>Payments reach you through your connected Whop account.</p>
</div>`,
  };
}

/**
 * R15 — the referrer earned a share and we cannot pay it yet.
 *
 * ⚠️ THIS COPY DELIBERATELY DOES NOT SAY WHAT HAPPENS AT THE DEADLINE. Ruling 7 §4 leaves the
 * terminal state undecided on purpose, to be made against real numbers. Saying "or you lose it"
 * would announce a forfeiture policy nobody agreed to; saying "we'll hold it indefinitely" would
 * announce the opposite. It states the date and stops.
 */
export function referralHoldCopy(input: {
  referredName: string;
  amountUsdCents: number;
  holdExpiresAt: Date;
  onboardingUrl: string;
}): { subject: string; text: string; html: string } {
  const amount = formatUsd(input.amountUsdCents);
  const by = input.holdExpiresAt.toISOString().slice(0, 10);
  const subject = `${amount} is waiting for you — finish setting up payments`;
  const lines = [
    `Someone you referred booked with ${input.referredName}, and you have earned ${amount}.`,
    '',
    'We cannot send it yet because your Whop account is not set up to receive payments.',
    `Finish setting it up and we will release it. Your share is held until ${by}.`,
    '',
    input.onboardingUrl,
  ];
  return {
    subject,
    text: lines.join('\n'),
    html: `<div style="font-family: -apple-system, system-ui, sans-serif; font-size: 15px; line-height: 1.6; color: #1a1a1a;">
<p>Someone you referred booked with ${escapeHtml(input.referredName)}, and you have earned <strong>${amount}</strong>.</p>
<p>We can&rsquo;t send it yet because your Whop account isn&rsquo;t set up to receive payments.</p>
<p>Finish setting it up and we&rsquo;ll release it. Your share is held until ${by}.</p>
<p><a href="${input.onboardingUrl}">Set up payments</a></p>
</div>`,
  };
}
