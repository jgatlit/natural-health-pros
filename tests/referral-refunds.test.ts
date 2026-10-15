import { describe, expect, it } from 'vitest';

import { reverseReferralOnRefund } from '@/lib/referral-refunds';
import { fakeLedgerDb } from './helpers/fake-ledger-db';

/**
 * REFUNDS (spec v1.4 §6.2, §9 test 17).
 *
 * Whop reverses the APPLICATION FEE itself, proportionally — that half needs no code. What does
 * need code is the referrer's share, which is a separate object on a separate account and does
 * not auto-reverse, and which behaves differently depending on whether a transfer has been CLAIMED
 * for it yet:
 *
 *   NOT CLAIMED — the debt is still a proposal. Reduce it (`reversedUsdCents` rises). Nothing moved.
 *   CLAIMED     — the amount is fixed and may be in the referrer's own Whop account. Nothing is
 *                 pulled back: the refund is booked as a debit netted off their next transfer.
 *
 * ⚠️ WHOP SENDS REFUND AMOUNTS IN DOLLARS. The SDK's own type says so: "The refunded amount as a
 * decimal in the specified currency, such as 10.43 for $10.43 USD" (`RefundCreatedWebhookEvent`).
 * Same unit trap as `/transfers` and the fee lines.
 *
 * ⚠️ THE STORED SHARE IS NEVER EDITED. Refunds raise `reversedUsdCents`, an absolute total that is
 * rebuilt from the append-only reversal markers.
 */

const PAID_AT = new Date(Date.UTC(2026, 5, 1));

function fake(
  row: Record<string, unknown> | null,
  extra: { feeLedger?: Record<string, unknown>[]; snapshot?: Record<string, unknown> | null } = {},
) {
  const db = fakeLedgerDb({ referral: { entries: row ? [row] : [] } });
  for (const f of extra.feeLedger ?? []) db.fees.push({ ...f });
  const markers = () => db.fees.filter((f: Record<string, unknown>) => String(f.kind).endsWith('REVERSAL'));
  Object.defineProperty(db, 'ledger', { get: markers });
  Object.defineProperty(db, 'row', { get: () => db.referralRows[0] as Record<string, any> | undefined }); // eslint-disable-line @typescript-eslint/no-explicit-any
  db.bookingFeeSnapshot = {
    async findUnique() {
      return extra.snapshot ?? null;
    },
  };
  return db as typeof db & { ledger: Record<string, any>[]; row: Record<string, any> | undefined }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'led_1',
  bookingIntentId: 'bi_1',
  state: 'PAYABLE',
  grossUsdCents: 10_000,
  referrerShareUsdCents: 2_000,
  referrerPractitionerId: 'X',
  servingPractitionerId: 'Y',
  whopPaymentId: 'pay_1',
  ...over,
});

describe('reverseReferralOnRefund — not yet paid out', () => {
  it('reverses the whole share on a FULL refund', async () => {
    const db = fake(entry());

    const result = await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_1',
      refundAmountUsdDollars: 100,
      refundId: 'ref_1',
      at: PAID_AT,
    });

    expect(result.reversedUsdCents).toBe(2_000);
    expect(db.row).toMatchObject({ referrerShareUsdCents: 2_000, reversedUsdCents: 2_000, state: 'REVERSED' });
  });

  it('reverses PROPORTIONALLY on a partial refund', async () => {
    const db = fake(entry());

    const result = await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_1',
      refundAmountUsdDollars: 25,
      refundId: 'ref_1',
      at: PAID_AT,
    });

    expect(result.reversedUsdCents).toBe(500);
    expect(db.row).toMatchObject({ referrerShareUsdCents: 2_000, reversedUsdCents: 500, state: 'PAYABLE' });
    expect(result.referrerDebitRecordedUsdCents).toBe(0);
  });

  it('⚠️ reads the refund amount as DOLLARS — $100 of a $100 session is a FULL refund', async () => {
    // If 100 were read as cents this would be a 1% refund and the referrer would keep 99% of a
    // share on a session the client got all their money back for.
    const db = fake(entry());

    const result = await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_1',
      refundAmountUsdDollars: 100,
      refundId: 'ref_1',
      at: PAID_AT,
    });

    expect(result.reversedUsdCents).toBe(2_000);
  });

  it('never reverses more than is owed, however large the refund claims to be', async () => {
    const db = fake(entry());

    const result = await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_1',
      refundAmountUsdDollars: 10_000,
      refundId: 'ref_1',
      at: PAID_AT,
    });

    expect(result.reversedUsdCents).toBe(2_000);
    expect(db.row).toMatchObject({ reversedUsdCents: 2_000 });
  });

  it('reduces a HELD share too — an unpaid debt is reversible whether or not we could pay it', async () => {
    const db = fake(entry({ state: 'HELD' }));

    await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_1',
      refundAmountUsdDollars: 100,
      refundId: 'ref_1',
      at: PAID_AT,
    });

    expect(db.row).toMatchObject({ reversedUsdCents: 2_000, state: 'REVERSED' });
  });

  it('records the reversal on the fee ledger, keyed so a redelivered refund cannot double-count', async () => {
    const db = fake(entry());

    await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_1',
      refundAmountUsdDollars: 100,
      refundId: 'ref_1',
      at: PAID_AT,
    });

    expect(db.ledger[0]).toMatchObject({
      kind: 'REFUND_REVERSAL',
      status: 'SETTLED',
      amountUsdCents: -2_000,
      dedupeKey: 'REFUND_REVERSAL:ref_1:led_1',
    });
  });
});

describe('reverseReferralOnRefund — a transfer was already claimed', () => {
  it('does NOT claw back, and does not flag a human: it books a DEBIT netted off the next transfer', async () => {
    // The money is in the referrer's own Whop account. Pulling funds back out of a third party's
    // account is not done; the next transfer to the same person is reduced instead.
    const db = fake(entry({ state: 'SETTLED', settledAt: PAID_AT, whopTransferId: 'tr_1', transferUsdCents: 2_000 }));

    const result = await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_1',
      refundAmountUsdDollars: 100,
      refundId: 'ref_1',
      at: PAID_AT,
    });

    expect(result.reversedUsdCents).toBe(2_000);
    expect(result.referrerDebitRecordedUsdCents).toBe(2_000);
    expect(db.referralAdjustments).toHaveLength(1);
    expect(db.referralAdjustments[0]).toMatchObject({
      referrerPractitionerId: 'X',
      sourceLedgerEntryId: 'led_1',
      amountUsdCents: 2_000,
      appliedUsdCents: 0,
      state: 'OPEN',
      dedupeKey: 'REFERRAL_REFUND:led_1:2000',
    });
    expect(db.ledger[0]).toMatchObject({ kind: 'REFUND_REVERSAL', status: 'SETTLED', amountUsdCents: -2_000 });
    expect(db.row).toMatchObject({ state: 'SETTLED', reversedUsdCents: 2_000, referrerShareUsdCents: 2_000 });
  });

  it('a transfer in flight (SENDING) books the debit immediately too', async () => {
    const db = fake(entry({ state: 'SENDING', transferUsdCents: 2_000, transferAttempts: 1 }));
    const result = await reverseReferralOnRefund(db, { whopPaymentId: 'pay_1', refundAmountUsdDollars: 50, refundId: 'r1', at: PAID_AT });
    expect(result.referrerDebitRecordedUsdCents).toBe(1_000);
    expect(db.referralAdjustments.map((a: Record<string, unknown>) => a.amountUsdCents)).toEqual([1_000]);
  });
});

describe('reverseReferralOnRefund — nothing to do', () => {
  it('is a no-op when the refunded payment carried no referrer share', async () => {
    const db = fake(null);

    const result = await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_unknown',
      refundAmountUsdDollars: 100,
      refundId: 'ref_1',
      at: PAID_AT,
    });

    expect(result).toEqual({
      reversedUsdCents: 0,
      referrerDebitRecordedUsdCents: 0,
      matched: false,
      affiliateReversedUsdCents: 0,
      affiliateDebitRecordedUsdCents: 0,
    });
    expect(db.ledger).toEqual([]);
  });

  it('ignores a zero or negative refund amount rather than writing a meaningless entry', async () => {
    const db = fake(entry());

    const result = await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_1',
      refundAmountUsdDollars: 0,
      refundId: 'ref_1',
      at: PAID_AT,
    });

    expect(result.reversedUsdCents).toBe(0);
    expect(db.ledger).toEqual([]);
  });
});


/**
 * SPEC v1.5 §1 — a refund reverses the AFFILIATE share too, not only the referrer's. The reversal is
 * an append-only negative FeeLedgerEntry keyed on the refund, applied to the AffiliateLedgerEntry
 * (lane L2b; tests/affiliate-ledger.test.ts covers the ledger side).
 */
describe('reverseReferralOnRefund — the recruiting affiliate share (spec v1.5)', () => {
  const snapshot = {
    bookingIntentId: 'bi_1',
    priceUsdCents: 10_000,
    affiliateShareUsdCents: 300,
    recruiterPractitionerId: 'R',
  };
  const appFee = {
    kind: 'APPLICATION_FEE',
    whopPaymentId: 'pay_1',
    bookingIntentId: 'bi_1',
    dedupeKey: 'APPLICATION_FEE:bi_1',
  };

  it('a FULL refund reverses the whole affiliate share AND the referrer share', async () => {
    const db = fake(entry(), { feeLedger: [appFee], snapshot });
    const result = await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_1',
      refundAmountUsdDollars: 100,
      refundId: 'ref_1',
      at: PAID_AT,
    });

    expect(result.reversedUsdCents).toBe(2_000);
    expect(result.affiliateReversedUsdCents).toBe(300);
    const aff = db.ledger.find((l) => l.kind === 'AFFILIATE_REFUND_REVERSAL');
    expect(aff).toMatchObject({
      amountUsdCents: -300,
      counterpartyPractitionerId: 'R',
      bookingIntentId: 'bi_1',
      whopPaymentId: 'pay_1',
    });
  });

  it('a partial refund reverses the affiliate share pro rata, floored', async () => {
    const db = fake(null, { feeLedger: [appFee], snapshot });
    const result = await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_1',
      refundAmountUsdDollars: 33.33,
      refundId: 'ref_1',
      at: PAID_AT,
    });
    expect(result.affiliateReversedUsdCents).toBe(99);
    expect(result.matched).toBe(false);
  });

  it('is idempotent on a Whop redelivery of the same refund — one entry, the same answer', async () => {
    const db = fake(null, { feeLedger: [appFee], snapshot });
    const input = { whopPaymentId: 'pay_1', refundAmountUsdDollars: 50, refundId: 'ref_1', at: PAID_AT };
    const first = await reverseReferralOnRefund(db, input);
    const second = await reverseReferralOnRefund(db, input);

    expect(first.affiliateReversedUsdCents).toBe(150);
    expect(second.affiliateReversedUsdCents).toBe(150);
    expect(db.ledger.filter((l) => l.kind === 'AFFILIATE_REFUND_REVERSAL')).toHaveLength(1);
  });

  it('several partial refunds can never reverse more than the share that was owed', async () => {
    const db = fake(null, { feeLedger: [appFee], snapshot });
    const a = await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_1',
      refundAmountUsdDollars: 80,
      refundId: 'r1',
      at: PAID_AT,
    });
    const b = await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_1',
      refundAmountUsdDollars: 80,
      refundId: 'r2',
      at: PAID_AT,
    });

    expect(a.affiliateReversedUsdCents).toBe(240);
    expect(b.affiliateReversedUsdCents).toBe(60);
    const total = db.ledger
      .filter((l) => l.kind === 'AFFILIATE_REFUND_REVERSAL')
      .reduce((n, l) => n + (l.amountUsdCents as number), 0);
    expect(total).toBe(-300);
  });

  it('reverses nothing when the booking owed no affiliate', async () => {
    const db = fake(null, {
      feeLedger: [appFee],
      snapshot: { ...snapshot, affiliateShareUsdCents: 0, recruiterPractitionerId: null },
    });
    const result = await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_1',
      refundAmountUsdDollars: 100,
      refundId: 'r1',
      at: PAID_AT,
    });
    expect(result.affiliateReversedUsdCents).toBe(0);
    expect(db.ledger).toHaveLength(0);
  });

  it('reverses nothing for a payment we cannot trace to a booking (no APPLICATION_FEE row)', async () => {
    const db = fake(null, { snapshot });
    const result = await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_x',
      refundAmountUsdDollars: 100,
      refundId: 'r1',
      at: PAID_AT,
    });
    expect(result.affiliateReversedUsdCents).toBe(0);
  });
});


/**
 * REFUND ARITHMETIC (review round 1, MINOR 6). The rule: every refund is measured against the
 * ORIGINAL share; each reverses floor(original x refund / gross), capped at what is still
 * un-reversed. So the total never exceeds the share, and falls short of exact pro-rata by under one
 * cent per refund event, in the payee's favour. A redelivered refund changes nothing.
 */
describe('reverseReferralOnRefund — cumulative partial refunds', () => {
  const refund = (db: ReturnType<typeof fake>, dollars: number, id: string, pay = 'pay_1') =>
    reverseReferralOnRefund(db, { whopPaymentId: pay, refundAmountUsdDollars: dollars, refundId: id, at: PAID_AT });

  it('two 50% refunds reverse the WHOLE share (they used to reverse 50% then 25%)', async () => {
    const db = fake(entry());
    const a = await refund(db, 50, 'r1');
    const b = await refund(db, 50, 'r2');

    expect(a.reversedUsdCents).toBe(1_000);
    expect(b.reversedUsdCents).toBe(1_000);
    expect(db.row!.reversedUsdCents).toBe(2_000);
  });

  it('a REDELIVERED refund does not reduce the share a second time', async () => {
    const db = fake(entry());
    const first = await refund(db, 25, 'r1');
    const replay = await refund(db, 25, 'r1');
    const replay2 = await refund(db, 25, 'r1');

    expect(first.reversedUsdCents).toBe(500);
    expect(replay).toEqual(first);
    expect(replay2).toEqual(first);
    expect(db.row!.reversedUsdCents).toBe(500);
    expect(db.ledger).toHaveLength(1);
  });

  it('on an ALREADY-PAID share, repeated full refunds can never debit more than was paid', async () => {
    const db = fake(entry({ state: 'SETTLED', transferUsdCents: 2_000 }));
    const a = await refund(db, 100, 'r1');
    const b = await refund(db, 100, 'r2');

    expect(a.reversedUsdCents).toBe(2_000);
    expect(a.referrerDebitRecordedUsdCents).toBe(2_000);
    expect(b.reversedUsdCents).toBe(0);
    expect(b.matched).toBe(false);
    const owed = db.referralAdjustments.reduce((n: number, l: Record<string, number>) => n + l.amountUsdCents, 0);
    expect(owed).toBe(2_000);
  });

  it('property: any split of refunds never over-reverses and under-reverses by < 1 cent per event', async () => {
    const splits = [[3_333, 6_667], [1, 9_999], [2_500, 2_500, 2_500, 2_500], [3_334, 3_333, 3_333], [10_000], [9_999, 1]];
    for (const share of [300, 2_000, 1_999, 7]) {
      for (const split of splits) {
        const db = fake(entry({ referrerShareUsdCents: share }));
        let total = 0;
        for (const [i, cents] of Array.from(split.entries())) {
          total += (await refund(db, cents / 100, `r${i}`)).reversedUsdCents;
        }
        const refunded = split.reduce((a, b) => a + b, 0);
        const exact = (share * refunded) / 10_000;
        expect(total, `${share}/${split}`).toBeLessThanOrEqual(share);
        expect(total, `${share}/${split}`).toBeLessThanOrEqual(Math.ceil(exact));
        expect(exact - total, `${share}/${split}`).toBeLessThan(split.length);
      }
    }
  });
});
