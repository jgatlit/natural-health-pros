import { describe, expect, it } from 'vitest';

import { reverseReferralOnRefund } from '@/lib/referral-refunds';

/**
 * REFUNDS (spec v1.4 §6.2, §9 test 17).
 *
 * Whop reverses the APPLICATION FEE itself, proportionally — that half needs no code. What does
 * need code is the referrer's share, which is a separate object on a separate account and does
 * not auto-reverse, and which behaves completely differently depending on whether we have paid it
 * out yet:
 *
 *   NOT YET PAID (PAYABLE / HELD) — the debt is still a proposal. Reduce it. Nothing has moved.
 *   ALREADY PAID (SETTLED)        — the money is in the referrer's own Whop account. Recovering it
 *                                   means pulling funds back OUT of a third party's account, which
 *                                   is never done automatically here.
 *
 * ⚠️ WHOP SENDS REFUND AMOUNTS IN DOLLARS. The SDK's own type says so: "The refunded amount as a
 * decimal in the specified currency, such as 10.43 for $10.43 USD" (`RefundCreatedWebhookEvent`).
 * Same unit trap as `/transfers` and the fee lines.
 *
 * ⚠️ THE STORED SHARE IS NEVER INFLATED, ONLY REDUCED. A refund can only ever take money back.
 */

const PAID_AT = new Date(Date.UTC(2026, 5, 1));

function fake(
  row: Record<string, unknown> | null,
  extra: { feeLedger?: Record<string, unknown>[]; snapshot?: Record<string, unknown> | null } = {},
) {
  const ledger: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const preexisting = extra.feeLedger ?? [];
  return {
    ledger,
    updates,
    bookingFeeSnapshot: {
      async findUnique() {
        return extra.snapshot ?? null;
      },
    },
    referralLedgerEntry: {
      async findFirst() {
        return row;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async update(args: any) {
        updates.push(args.data);
        return { ...row, ...args.data };
      },
    },
    feeLedgerEntry: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async upsert(args: any) {
        const existing = ledger.find((l) => l.dedupeKey === args.where.dedupeKey);
        if (existing) return existing;
        ledger.push(args.create);
        return args.create;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findFirst(args: any) {
        return (
          [...preexisting, ...ledger].find(
            (l) => l.kind === args.where.kind && l.whopPaymentId === args.where.whopPaymentId,
          ) ?? null
        );
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findMany(args: any) {
        return [...preexisting, ...ledger].filter(
          (l) => l.kind === args.where.kind && l.bookingIntentId === args.where.bookingIntentId,
        );
      },
    },
  };
}

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'led_1',
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
    expect(db.updates[0]).toMatchObject({ referrerShareUsdCents: 0 });
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
    expect(db.updates[0]).toMatchObject({ referrerShareUsdCents: 1_500 });
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
    expect(db.updates[0]).toMatchObject({ referrerShareUsdCents: 0 });
  });

  it('reduces a HELD share too — an unpaid debt is reversible whether or not we could pay it', async () => {
    const db = fake(entry({ state: 'HELD' }));

    await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_1',
      refundAmountUsdDollars: 100,
      refundId: 'ref_1',
      at: PAID_AT,
    });

    expect(db.updates[0]).toMatchObject({ referrerShareUsdCents: 0 });
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

describe('reverseReferralOnRefund — already paid out', () => {
  it('does NOT claw back automatically — it records a recovery owed, for a human', async () => {
    // The money is in the referrer's own Whop account. Pulling funds back out of a third party's
    // account on an automated heuristic is not recoverable if the heuristic is wrong, and Whop's
    // own child → parent transfer needs that child to be holding a balance at the time.
    const db = fake(entry({ state: 'SETTLED', settledAt: PAID_AT, whopTransferId: 'tr_1' }));

    const result = await reverseReferralOnRefund(db, {
      whopPaymentId: 'pay_1',
      refundAmountUsdDollars: 100,
      refundId: 'ref_1',
      at: PAID_AT,
    });

    expect(result.recoveryOwedUsdCents).toBe(2_000);
    expect(db.updates).toEqual([]);
    expect(db.ledger[0]).toMatchObject({ kind: 'REFUND_REVERSAL', status: 'PENDING' });
    expect(String(db.ledger[0]!.note)).toMatch(/already paid|recover/i);
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
      recoveryOwedUsdCents: 0,
      matched: false,
      affiliateReversedUsdCents: 0,
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
 * SPEC v1.5 §1 — a refund reverses the AFFILIATE share too, not only the referrer's. The affiliate
 * ledger does not exist yet (lane L2b), so the reversal is an append-only negative FeeLedgerEntry
 * keyed on the refund: that entry is the seam L2b will apply.
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
