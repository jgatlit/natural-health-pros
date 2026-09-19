import { describe, expect, it } from 'vitest';

import {
  referralBookedCopy,
  referralHoldCopy,
  referralsNeedingClaimNotice,
  referralsNeedingBookedNotice,
} from '@/lib/referral-notifications';

/**
 * REFERRAL NOTIFICATIONS (spec v1.4 §5.5 / R10, operator ruling 7 / R15).
 *
 * Four rules carried from code that already exists in this repo, each of which was paid for once:
 *
 *  1. NOTHING SENDS FROM THE WHOP WEBHOOK. Whop retries 3× over ~70 s and then drops the event
 *     permanently, so the handler must acknowledge fast and never block on a Resend round-trip.
 *     Every notice below fires from the 15-minute booking sweep.
 *  2. A DURABLE MARKER COLUMN, NEVER `idempotencyKey` ALONE. Resend de-duplicates for 24 HOURS.
 *     Over a candidate set nothing removes rows from, that means "one email a day, forever" —
 *     which is what `resumeEmailSentAt` exists to prevent, and this repeats the pattern.
 *  3. `notifyLeadsImmediately` GATES LEAD EMAILS ONLY. It must not gate a money event. A referrer
 *     being told they are owed funds is not a marketing notification.
 *  4. Y IS NOT TOLD THE CLIENT'S IDENTITY until they book (§5.5), and X is never told anything
 *     about Y's side at all.
 *
 * ⚠️ HONEST ABOUT "IMMEDIATELY". Ruling 7 says the unpayable-referrer notice goes out
 * immediately. It is sent from the sweep, so in practice that is "within 15 minutes" — the
 * alternative is sending inside the webhook, which risks losing the payment event itself. Stated
 * rather than papered over.
 */

const D = (day: number) => new Date(Date.UTC(2026, 0, 1 + day));

describe('referralsNeedingBookedNotice', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'touch_1',
    bookedNoticeSentAt: null,
    paidAt: D(1),
    ...over,
  });

  it('selects a paid referred booking that has not been announced', () => {
    expect(referralsNeedingBookedNotice([row()]).map((r) => r.id)).toEqual(['touch_1']);
  });

  it('skips one already announced — the DURABLE marker, not a 24-hour Resend key', () => {
    expect(referralsNeedingBookedNotice([row({ bookedNoticeSentAt: D(2) })])).toEqual([]);
  });

  it('skips an unpaid booking — a referral that has not converted owes nobody anything', () => {
    expect(referralsNeedingBookedNotice([row({ paidAt: null })])).toEqual([]);
  });
});

describe('referralsNeedingClaimNotice', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'led_1',
    state: 'HELD',
    notifiedAt: null,
    ...over,
  });

  it('R15 — selects a HELD share whose referrer has not yet been told to claim their account', () => {
    expect(referralsNeedingClaimNotice([row()]).map((r) => r.id)).toEqual(['led_1']);
  });

  it('never re-notifies — one notice per held row, per the marker', () => {
    expect(referralsNeedingClaimNotice([row({ notifiedAt: D(1) })])).toEqual([]);
  });

  it('ignores a PAYABLE share — there is nothing for that referrer to do', () => {
    expect(referralsNeedingClaimNotice([row({ state: 'PAYABLE' })])).toEqual([]);
  });

  it('ignores an EXPIRED_UNCLAIMED share — day-91 policy is unruled and this must take no action', () => {
    // ⚠️ DO NOT "helpfully" chase these. The terminal rule is deliberately undecided (operator,
    // 2026-09-18); mailing someone about money whose fate nobody has ruled on makes a promise the
    // product cannot keep.
    expect(referralsNeedingClaimNotice([row({ state: 'EXPIRED_UNCLAIMED' })])).toEqual([]);
  });
});

describe('referralBookedCopy — what the referrer is told', () => {
  const copy = referralBookedCopy({
    referredName: 'Dr Y',
    rateLabel: '20%',
    termMonths: 8,
  });

  it('names the practitioner, the rate and the term', () => {
    expect(copy.subject).toContain('Dr Y');
    expect(copy.text).toContain('20%');
    expect(copy.text).toContain('8 months');
  });

  it('says NOTHING about the client — a link referral never identified them to the referrer', () => {
    // A copied link is opened by an anonymous visitor. Naming the buyer here would disclose a
    // person the referrer may never have known was involved, on the strength of a link they
    // posted publicly.
    for (const field of [copy.subject, copy.text, copy.html]) {
      expect(field.toLowerCase()).not.toContain('client@');
      expect(field.toLowerCase()).not.toContain('@example');
    }
  });
});

describe('referralHoldCopy — R15’s claim notice', () => {
  const copy = referralHoldCopy({
    referredName: 'Dr Y',
    amountUsdCents: 2_000,
    holdExpiresAt: D(90),
    onboardingUrl: 'https://naturalhealthpros.com/practitioners/x/edit#payments',
  });

  it('states the amount held and where to go to claim it', () => {
    expect(copy.text).toContain('$20.00');
    expect(copy.text).toContain('https://naturalhealthpros.com/practitioners/x/edit#payments');
  });

  it('gives the hold deadline, because the clock is real and per-row', () => {
    expect(copy.text).toContain('2026-04-01');
  });

  it('does NOT promise what happens at the deadline — that rule is deliberately unruled', () => {
    // The terminal state is an operator decision made against real numbers (ruling 7 §4). Copy
    // that said "or you lose it" would announce a forfeiture policy nobody has agreed to, and
    // copy that said "we'll hold it forever" would announce the opposite.
    const all = `${copy.subject} ${copy.text} ${copy.html}`.toLowerCase();
    for (const claim of ['forfeit', 'lose it', 'lost', 'returned to', 'forever', 'expire and']) {
      expect(all, `copy should not promise a terminal outcome: "${claim}"`).not.toContain(claim);
    }
  });
});
