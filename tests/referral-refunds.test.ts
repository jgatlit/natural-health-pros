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

function fake(row: Record<string, unknown> | null) {
  const ledger: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  return {
    ledger,
    updates,
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
        ledger.push(args.create);
        return args.create;
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

    expect(result).toEqual({ reversedUsdCents: 0, recoveryOwedUsdCents: 0, matched: false });
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
