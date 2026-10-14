import { describe, expect, it } from 'vitest';

import { repriceReferralRow, type RepriceInput } from '@/lib/referral-reprice';

const SCHEDULE = { referrerBps: 2000, referralTotalBps: 3000, referrerTermMonths: 4, leadTermMonths: 8 };
const ANCHOR = new Date(Date.UTC(2026, 8, 1)); // 2026-09-01

// Old rule: gross $100, referrer 20% = 2000c, NHP 20% = 2000c, so 4000c collected.
const base = (over: Partial<RepriceInput> = {}): RepriceInput => ({
  id: 'led_1',
  state: 'PAYABLE',
  grossUsdCents: 10_000,
  referrerShareUsdCents: 2000,
  collectedFeeUsdCents: 4000,
  paidAt: new Date(Date.UTC(2026, 9, 1)),
  anchorAt: ANCHOR,
  schedule: SCHEDULE,
  ...over,
});

describe('repriceReferralRow', () => {
  it('in term, share already 20%: NOOP on the share, but the NHP over-collection (20% vs 10%) is reported', () => {
    const d = repriceReferralRow(base());
    expect(d).toMatchObject({
      action: 'NOOP',
      currentShareUsdCents: 2000,
      newShareUsdCents: 2000,
      inReferrerTerm: true,
      nhpOverCollectedUsdCents: 1000,
    });
  });

  it('in term, share above the schedule (old 25%): clamped DOWN to the schedule 20%', () => {
    const d = repriceReferralRow(base({ referrerShareUsdCents: 2500, collectedFeeUsdCents: 4500 }));
    expect(d).toMatchObject({ action: 'REPRICE', newShareUsdCents: 2000, deltaUsdCents: -500 });
  });

  it('never raises a share a refund already reduced in place', () => {
    const d = repriceReferralRow(base({ referrerShareUsdCents: 500 }));
    expect(d).toMatchObject({ action: 'NOOP', newShareUsdCents: 500 });
  });

  it('past the 4-month referrer term (still inside the old 8-month term): reduced to 0', () => {
    const d = repriceReferralRow(base({ paidAt: new Date(Date.UTC(2027, 1, 1)) })); // month 5
    expect(d).toMatchObject({
      action: 'REPRICE',
      newShareUsdCents: 0,
      deltaUsdCents: -2000,
      inReferrerTerm: false,
      nhpOverCollectedUsdCents: null,
    });
  });

  it('the referrer term end is EXCLUSIVE: exactly anchor + 4 months is outside, one ms before is inside', () => {
    const ends = Date.UTC(2027, 0, 1);
    expect(repriceReferralRow(base({ paidAt: new Date(ends) })).action).toBe('REPRICE');
    expect(repriceReferralRow(base({ paidAt: new Date(ends - 1) })).action).toBe('NOOP');
  });

  it('a term stored on the client row wins over the schedule (forward-only)', () => {
    const d = repriceReferralRow(base({ paidAt: new Date(Date.UTC(2027, 1, 1)), storedReferrerTermMonths: 8 }));
    expect(d).toMatchObject({ action: 'NOOP', inReferrerTerm: true });
  });

  it('a SETTLED row is never changed, only flagged with the overpaid amount', () => {
    const d = repriceReferralRow(base({ state: 'SETTLED', paidAt: new Date(Date.UTC(2027, 1, 1)) }));
    expect(d).toMatchObject({ action: 'FLAG_SETTLED', deltaUsdCents: -2000 });
    expect((d as { reason: string }).reason).toMatch(/2000c already paid/);
  });

  it('HELD and EXPIRED_UNCLAIMED rows are re-priced like PAYABLE', () => {
    for (const state of ['HELD', 'EXPIRED_UNCLAIMED']) {
      expect(repriceReferralRow(base({ state, paidAt: new Date(Date.UTC(2027, 1, 1)) }))).toMatchObject({
        action: 'REPRICE',
        newShareUsdCents: 0,
      });
    }
  });

  it('skips, with a reason, rather than guessing: no anchor, no schedule, malformed cents, unknown state', () => {
    expect(repriceReferralRow(base({ anchorAt: null }))).toMatchObject({ action: 'SKIP', reason: expect.stringMatching(/NO_ANCHOR/) });
    expect(repriceReferralRow(base({ schedule: null }))).toMatchObject({ action: 'SKIP', reason: expect.stringMatching(/NO_SCHEDULE/) });
    expect(repriceReferralRow(base({ grossUsdCents: 100.5 }))).toMatchObject({ action: 'SKIP', reason: expect.stringMatching(/MALFORMED/) });
    expect(repriceReferralRow(base({ state: 'WAT', referrerShareUsdCents: 2500 }))).toMatchObject({
      action: 'SKIP',
      reason: expect.stringMatching(/UNKNOWN_STATE/),
    });
  });

  it('is idempotent: re-pricing the output of a re-price is a NOOP', () => {
    const first = repriceReferralRow(base({ referrerShareUsdCents: 2500, collectedFeeUsdCents: 4500 }));
    if (first.action !== 'REPRICE') throw new Error('expected REPRICE');
    const second = repriceReferralRow(base({ referrerShareUsdCents: first.newShareUsdCents }));
    expect(second.action).toBe('NOOP');
  });
});
