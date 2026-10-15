import { describe, expect, it } from 'vitest';

import { repriceReferralRow, type RepriceInput } from '@/lib/referral-reprice';

const SCHEDULE = { referrerBps: 2000, referralTotalBps: 3000, referrerTermMonths: 4, leadTermMonths: 8, planASourcedBps: 1000, planBSourcedBps: 3000 };
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
  plan: 'PLAN_B',
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
      collectedUsdCents: 4000,
      v15ChargeUsdCents: 3000,
      nhpRetainsUsdCents: 2000,
      v15NhpWouldKeepUsdCents: 1000,
      nhpExcessUsdCents: 1000,
      practitionerOverchargedUsdCents: 1000,
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
      // Past the referrer term the old rule still took 40%. NHP keeps all 4000; v1.5 on Plan B
      // would have charged 3000 (all NHP's). The practitioner was over-charged 1000.
      collectedUsdCents: 4000,
      nhpRetainsUsdCents: 4000,
      v15ChargeUsdCents: 3000,
      v15NhpWouldKeepUsdCents: 3000,
      nhpExcessUsdCents: 1000,
      practitionerOverchargedUsdCents: 1000,
    });
  });

  it('past the referrer term the v1.5 charge follows the PLAN (A = 10%), and is unknown without one', () => {
    const late = new Date(Date.UTC(2027, 1, 1));
    expect(repriceReferralRow(base({ paidAt: late, plan: 'PLAN_A' }))).toMatchObject({
      v15ChargeUsdCents: 1000,
      nhpExcessUsdCents: 3000,
      practitionerOverchargedUsdCents: 3000,
    });
    expect(repriceReferralRow(base({ paidAt: late, plan: null }))).toMatchObject({
      v15ChargeUsdCents: null,
      nhpExcessUsdCents: null,
    });
  });

  it('past the 8-month lead term v1.5 charges nothing: the whole collected fee is excess', () => {
    const d = repriceReferralRow(base({ paidAt: new Date(Date.UTC(2027, 5, 1)) }));
    expect(d).toMatchObject({ v15ChargeUsdCents: 0, nhpExcessUsdCents: 4000, practitionerOverchargedUsdCents: 4000 });
  });

  it('SKIPS a row whose transfer is in flight or failed; PENDING / BLOCKED / SETTLED receipts / none are fine', () => {
    for (const transferStatus of ['SENDING', 'FAILED']) {
      expect(repriceReferralRow(base({ referrerShareUsdCents: 2500, transferStatus }))).toMatchObject({
        action: 'SKIP',
        reason: expect.stringMatching(/IN_FLIGHT_TRANSFER/),
      });
    }
    for (const transferStatus of ['PENDING', 'BLOCKED', 'SETTLED', null]) {
      expect(repriceReferralRow(base({ referrerShareUsdCents: 2500, transferStatus })).action).toBe('REPRICE');
    }
  });

  it('SKIPS a ledger row that is itself SENDING: a transfer may have left', () => {
    expect(repriceReferralRow(base({ state: 'SENDING', referrerShareUsdCents: 2500 }))).toMatchObject({
      action: 'SKIP',
      reason: expect.stringMatching(/IN_FLIGHT_TRANSFER: the ledger row is SENDING/),
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

  it('a SETTLED row\u2019s share was already paid out: NHP retains collected minus what was paid, never collected minus a zeroed share', () => {
    const settled = repriceReferralRow(base({ state: 'SETTLED', paidAt: new Date(Date.UTC(2027, 1, 1)) }));
    const unpaid = repriceReferralRow(base({ state: 'PAYABLE', paidAt: new Date(Date.UTC(2027, 1, 1)) }));
    // Past the referrer term, collected 4000, v1.5 would charge 3000 (Plan B) and NHP would keep 3000.
    expect(settled).toMatchObject({ action: 'FLAG_SETTLED', nhpRetainsUsdCents: 2000, nhpExcessUsdCents: 0 });
    expect(unpaid).toMatchObject({ action: 'REPRICE', nhpRetainsUsdCents: 4000, nhpExcessUsdCents: 1000 });
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
