import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SETTING_DEFS } from '@/lib/platform-settings';
import { referralBookedCopy } from '@/lib/referral-notifications';

/**
 * THE 2026-09-19 OPERATOR CORRECTION, ASSERTED WHERE IT CAN ACTUALLY REGRESS.
 *
 * Lead attribution clocks anchor on the DAY OF TRANSACTION — the client's first payment to that
 * practitioner — not on the session's scheduled start. This supersedes commit `c98bf6d` and spec
 * v1.4 §6.1 for BOTH the anchor and the per-session boundary.
 *
 * Two of the three places this rule lives are unreachable from a unit test:
 *
 *   1. `book/[token]/page.tsx` is an async server component that opens a Prisma client, mints a
 *      Whop configuration and renders React. Nothing in this suite renders it, so "which instant
 *      does it hand the fee path" is only observable in the source text — and it is exactly the
 *      kind of one-token edit (`intent.scheduledAt ?? new Date()`) that tsc, eslint and every
 *      runtime test here accept silently.
 *   2. The copy is a pure function, so that half IS asserted for real, below.
 *
 * The webhook's anchor is asserted behaviourally in whop-webhook-v1.test.ts; this file guards the
 * call sites and the words, which are the parts a future edit reverts by accident.
 */

const ROOT = join(__dirname, '..', 'src');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

/**
 * Source with comments removed — `//`, `/* … *\/` and the JSX `{/* … *\/}` form.
 *
 * Stripping is what makes these assertions honest rather than brittle. Every site below carries a
 * long comment EXPLAINING that the scheduled start is no longer read, and one quotes the old card
 * labels verbatim to record a bug. A naive substring check fails on the documentation of the very
 * fix it is guarding, and the cure for that is usually to weaken the assertion. Code is asserted
 * on; prose is not.
 */
function stripComments(src: string): string {
  return src.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/\/\/.*$/gm, '');
}

/** The argument object of `fn(` … `});`, comments removed. */
function callArgs(src: string, fn: string): string {
  const stripped = stripComments(src);
  const call = stripped.slice(stripped.indexOf(fn));
  return call.slice(0, call.indexOf('});'));
}

describe('the fee path measures the term at the TRANSACTION instant', () => {
  it('the booking page does not anchor the boundary on the scheduled start', () => {
    const args = callArgs(
      read('app', 'practitioners', '[slug]', 'book', '[token]', 'page.tsx'),
      'resolveBookingFee(',
    );

    expect(args, 'resolveBookingFee is no longer called from this page').toContain('priceUsdCents');
    expect(
      args,
      'the per-session boundary must be the session’s own transaction instant — reading ' +
        '`intent.scheduledAt` here puts the boundary on a different calendar from the anchor, ' +
        'which is the mismatch the 2026-09-19 correction exists to remove',
    ).not.toContain('scheduledAt');
  });

  it('the payment webhook does not prefer the scheduled start over the payment instant', () => {
    const args = callArgs(
      read('app', 'api', 'whop', 'webhook', 'v1', 'route.ts'),
      'commitPaymentAttribution(',
    );

    expect(args, 'commitPaymentAttribution is no longer called from this route').toContain(
      'termMonths',
    );
    expect(
      args,
      'the anchor is the payment instant UNCONDITIONALLY — a `?? ` fallback to it is the ' +
        'superseded c98bf6d behaviour',
    ).not.toContain('scheduledAt');
  });
});

describe('practitioner-facing copy says PAYMENT, not session', () => {
  it('the referral notice dates the term from the first payment', () => {
    const copy = referralBookedCopy({ referredName: 'Sarah', rateLabel: '20%', termMonths: 8 });
    for (const body of [copy.text, copy.html]) {
      expect(body).toContain('first payment');
      expect(
        body,
        'a referrer told "8 months from their first session" will date their own earnings from a ' +
          'calendar the ledger does not use',
      ).not.toContain('first session');
    }
  });

  it('every practitioner-facing surface that names the term also names its anchor', () => {
    // ⚠️ THESE SCREENS DESCRIBED A CLOCK WITHOUT SAYING WHAT STARTS IT. "for 8 months" is the
    // sentence a practitioner reasons about when choosing a plan and when deciding whether a
    // referral is worth making, and until now neither screen said 8 months from WHAT. Under the
    // superseded rule the honest answer was "the first booked session"; it is now the first
    // payment, and the difference is the whole booking lead time on any advance booking.
    //
    // Source-text, because these are server components and nothing in this suite renders React.
    const surfaces = [
      read('components', 'practitioners', 'PlanChoice.tsx'),
      read('components', 'practitioners', 'ClientsAndReferralsSection.tsx'),
    ];
    for (const src of surfaces.map(stripComments)) {
      expect(src).toContain('first payment');
      expect(
        src,
        'the term runs from a payment, so copy naming a session start describes a calendar no ' +
          'attribution row is measured on',
      ).not.toMatch(/first (booked )?session/i);
    }
  });

  it('the admin Lead Attribution Term help text describes the payment anchor', () => {
    const { help } = SETTING_DEFS.leadAttributionTermMonths;
    expect(help).toMatch(/payment/i);
    expect(
      help,
      'the operator reads this string to answer "when does a claim expire" — it must name the ' +
        'same instant `snapshotTerm()` actually stores',
    ).not.toMatch(/scheduled/i);
  });
});
