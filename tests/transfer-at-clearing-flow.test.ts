import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accrueAffiliateShare } from '@/lib/affiliate-ledger';
import { settleAffiliateShares } from '@/lib/affiliate-payouts';
import { settlePayableShares } from '@/lib/referral-payouts';
import { reverseReferralOnRefund } from '@/lib/referral-refunds';
import type { LookupFn } from '@/lib/ledger-transfer';
import { fakeLedgerDb } from './helpers/fake-ledger-db';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * THE WHOLE CHAIN on one fake database, with the real money code: the accrual the payment webhook
 * runs, the transfer at clearing, the refund pipeline (markers, absolute reversal, debit), and the
 * next transfer's netting. The only mocks are Prisma and the Whop transfer; nothing can reach Whop.
 *
 * Each booking is a $10 session. The recruiter's share is 3% ($0.30); the referrer's share in the
 * referral half is also $0.30 so the two halves read the same.
 */

const ENV = ['WHOP_TRANSFERS_ENABLED', 'WHOP_TRANSFERS_ALLOWLIST', 'WHOP_COMPANY_API_KEY', 'WHOP_PARENT_COMPANY_ID'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});
const enable = () => {
  process.env.WHOP_TRANSFERS_ENABLED = 'true';
  process.env.WHOP_COMPANY_API_KEY = 'test-key';
  process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';
};

const NOW = new Date(Date.UTC(2027, 0, 1));
const R = 'R';
const Y = 'Y';
const wallets = { R: { whopCompanyId: 'biz_R', whopPayoutsEnabled: true } };
const noLookup: LookupFn = async () => null;
let n = 0;
const okTransfer = () => vi.fn<(args: any) => Promise<{ transferId: string }>>(async () => ({ transferId: `tr_${++n}` }));

function world() {
  const fake = fakeLedgerDb({ practitioners: wallets });
  const snapshots = new Map<string, any>();
  const db: any = Object.assign(fake, {
    bookingFeeSnapshot: { findUnique: async (args: any) => snapshots.get(args.where.bookingIntentId) ?? null },
  });
  return {
    db,
    /** The recruiter half: the real accrual, as `commitPaymentAttribution` runs it at payment.succeeded. */
    async accrueRecruiter(id: string, shareCents = 30) {
      snapshots.set(id, {
        bookingIntentId: id,
        priceUsdCents: 1_000,
        affiliateShareUsdCents: shareCents,
        recruiterPractitionerId: R,
      });
      await db.feeLedgerEntry.upsert({
        where: { dedupeKey: `APPLICATION_FEE:${id}` },
        create: {
          dedupeKey: `APPLICATION_FEE:${id}`,
          kind: 'APPLICATION_FEE',
          bookingIntentId: id,
          whopPaymentId: `pay_${id}`,
          amountUsdCents: shareCents,
        },
        update: {},
      });
      return accrueAffiliateShare(db, {
        bookingIntentId: id,
        recruitedPractitionerId: Y,
        whopPaymentId: `pay_${id}`,
        snapshot: {
          priceUsdCents: 1_000,
          applicationFeeUsdCents: shareCents,
          nhpFeeUsdCents: 0,
          affiliateBps: 300,
          affiliateShareUsdCents: shareCents,
          recruiterPractitionerId: R,
        },
        paidAt: NOW,
      });
    },
    /** The referrer half: the row `commitPaymentAttribution` writes for a payable referrer. */
    async accrueReferrer(id: string, shareCents = 30) {
      await db.referralLedgerEntry.upsert({
        where: { bookingIntentId_referrerPractitionerId: { bookingIntentId: id, referrerPractitionerId: R } },
        create: {
          bookingIntentId: id,
          whopPaymentId: `pay_${id}`,
          referrerPractitionerId: R,
          servingPractitionerId: Y,
          grossUsdCents: 1_000,
          referrerShareUsdCents: shareCents,
          state: 'PAYABLE',
        },
        update: {},
      });
    },
    refund: (id: string, dollars: number, refundId: string) =>
      reverseReferralOnRefund(db, { whopPaymentId: `pay_${id}`, refundAmountUsdDollars: dollars, refundId, at: NOW }),
  };
}

describe('SELF-AUDIT TRACE, recruiter: a recruited $10 session end to end', () => {
  it('accrual $0.30 -> transfer at clearing for the full $0.30 (no fee) -> $4 refund = $0.12 debit -> next $0.30 share nets to $0.18', async () => {
    const w = world();
    const transfer = okTransfer();
    const settle = (over: Record<string, any> = {}) => settleAffiliateShares(w.db, { transfer, lookup: noLookup, at: NOW, ...over });

    // 1. Accrual at payment: $0.30, payable at once (no hold).
    expect(await w.accrueRecruiter('bi_1')).toMatchObject({ accrued: true, shareUsdCents: 30 });
    expect(w.db.affiliateRows[0]).toMatchObject({ shareUsdCents: 30, state: 'ACCRUED', holdDays: 0 });
    expect(w.db.affiliateRows[0].holdUntil.getTime()).toBe(NOW.getTime());

    // 2. Flag OFF (production today): nothing is read, written or called.
    const off = vi.spyOn(w.db.affiliateLedgerEntry, 'findMany');
    expect((await settle()).blocked).toBe('skipped: transfers disabled');
    expect(off).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
    off.mockRestore();

    // 3. Flag ON: the transfer at clearing is for the FULL $0.30. No fee anywhere.
    enable();
    await settle();
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer.mock.calls[0][0]).toMatchObject({
      amountUsdDollars: 0.3,
      destinationId: 'biz_R',
      idempotenceKey: w.db.affiliateRows[0].id,
    });
    expect(w.db.affiliateRows[0]).toMatchObject({
      state: 'SETTLED',
      grossShareUsdCents: 30,
      transferUsdCents: 30,
      netPaidUsdCents: 30,
      adjustmentAppliedUsdCents: null,
      transferFeeUsdCents: null,
    });

    // 4. A $4 refund of that $10 payment arrives AFTER the transfer: a $0.12 debit, no clawback.
    const out = await w.refund('bi_1', 4, 'ref_1');
    expect(out).toMatchObject({ affiliateReversedUsdCents: 12, affiliateDebitRecordedUsdCents: 12 });
    expect(w.db.affiliateAdjustments).toHaveLength(1);
    expect(w.db.affiliateAdjustments[0]).toMatchObject({ amountUsdCents: 12, appliedUsdCents: 0, state: 'OPEN' });
    expect(transfer).toHaveBeenCalledTimes(1);

    // The webhook is redelivered 3x: still one debit.
    await w.refund('bi_1', 4, 'ref_1');
    await w.refund('bi_1', 4, 'ref_1');
    expect(w.db.affiliateAdjustments).toHaveLength(1);

    // 5. The NEXT $0.30 share: the transfer is $0.30 - $0.12 = $0.18.
    await w.accrueRecruiter('bi_2');
    await settle();
    const second = w.db.affiliateRows.find((r: any) => r.bookingIntentId === 'bi_2');
    expect(second).toMatchObject({
      state: 'SETTLED',
      grossShareUsdCents: 30,
      adjustmentAppliedUsdCents: 12,
      transferUsdCents: 18,
      netPaidUsdCents: 18,
    });
    expect(transfer.mock.calls[1][0].amountUsdDollars).toBe(0.18);

    // 6. The debit is APPLIED once; a later redelivery of the refund adds nothing.
    expect(w.db.affiliateAdjustments[0]).toMatchObject({ appliedUsdCents: 12, state: 'APPLIED' });
    await w.refund('bi_1', 4, 'ref_1');
    await settle();
    expect(w.db.affiliateAdjustments).toHaveLength(1);
    expect(transfer).toHaveBeenCalledTimes(2);

    // Books close: of 60 cents earned the recruiter was sent 30 + 18; 12 went to the refund.
    expect(30 + 18 + 12).toBe(60);
  });

  it('a refund BEFORE the transfer shrinks it; a full refund before the transfer means no transfer at all', async () => {
    enable();
    const w = world();
    const transfer = okTransfer();
    await w.accrueRecruiter('bi_1');
    await w.refund('bi_1', 4, 'ref_1');
    expect(w.db.affiliateAdjustments).toHaveLength(0);
    await settleAffiliateShares(w.db, { transfer, lookup: noLookup, at: NOW });
    expect(transfer.mock.calls[0][0].amountUsdDollars).toBe(0.18);

    await w.accrueRecruiter('bi_2');
    await w.refund('bi_2', 10, 'ref_2');
    expect(w.db.affiliateRows.find((r: any) => r.bookingIntentId === 'bi_2').state).toBe('REVERSED');
    await settleAffiliateShares(w.db, { transfer, lookup: noLookup, at: NOW });
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it('two refunds of one payment, one before and one after the transfer: the first reduces, the second is a debit for its own cents only', async () => {
    enable();
    const w = world();
    const transfer = okTransfer();
    await w.accrueRecruiter('bi_1');
    await w.refund('bi_1', 2, 'ref_a'); // $0.06 off before the transfer
    await settleAffiliateShares(w.db, { transfer, lookup: noLookup, at: NOW });
    expect(transfer.mock.calls[0][0].amountUsdDollars).toBe(0.24);
    await w.refund('bi_1', 2, 'ref_b'); // another $0.06, after
    expect(w.db.affiliateAdjustments.map((a: any) => a.amountUsdCents)).toEqual([6]);
    expect(w.db.affiliateRows[0].reversedUsdCents).toBe(12);
  });
});

describe('SELF-AUDIT TRACE, referrer: the same session on the client-referral ledger', () => {
  it('share $0.30 sent in full at clearing -> $4 refund = $0.12 debit -> next $0.30 share nets to $0.18', async () => {
    enable();
    const w = world();
    const transfer = okTransfer();
    const settle = () => settlePayableShares(w.db, { transfer, lookup: noLookup, at: NOW });

    await w.accrueReferrer('bi_1');
    await settle();
    expect(transfer.mock.calls[0][0]).toMatchObject({ amountUsdDollars: 0.3, destinationId: 'biz_R' });
    expect(w.db.referralRows[0]).toMatchObject({ state: 'SETTLED', grossShareUsdCents: 30, netPaidUsdCents: 30, transferFeeUsdCents: null });

    const out = await w.refund('bi_1', 4, 'ref_1');
    expect(out).toMatchObject({ reversedUsdCents: 12, referrerDebitRecordedUsdCents: 12, matched: true });
    expect(w.db.referralAdjustments).toHaveLength(1);
    expect(w.db.referralAdjustments[0]).toMatchObject({ amountUsdCents: 12, state: 'OPEN', dedupeKey: expect.stringMatching(/^REFERRAL_REFUND:/) });
    expect(w.db.fees.find((f: any) => f.kind === 'REFUND_REVERSAL')).toMatchObject({ status: 'SETTLED', amountUsdCents: -12 });

    await w.refund('bi_1', 4, 'ref_1'); // redelivery
    expect(w.db.referralAdjustments).toHaveLength(1);

    await w.accrueReferrer('bi_2');
    await settle();
    expect(transfer.mock.calls[1][0].amountUsdDollars).toBe(0.18);
    expect(w.db.referralRows.find((r: any) => r.bookingIntentId === 'bi_2')).toMatchObject({
      state: 'SETTLED',
      adjustmentAppliedUsdCents: 12,
      netPaidUsdCents: 18,
    });
    expect(w.db.referralAdjustments[0]).toMatchObject({ appliedUsdCents: 12, state: 'APPLIED' });
  });

  it('a refund before the transfer reduces the share; nothing is ever flagged for a human', async () => {
    enable();
    const w = world();
    await w.accrueReferrer('bi_1');
    const out = await w.refund('bi_1', 5, 'ref_1');
    expect(out).toMatchObject({ reversedUsdCents: 15, referrerDebitRecordedUsdCents: 0 });
    expect(w.db.referralRows[0]).toMatchObject({ referrerShareUsdCents: 30, reversedUsdCents: 15, state: 'PAYABLE' });
    const transfer = okTransfer();
    await settlePayableShares(w.db, { transfer, lookup: noLookup, at: NOW });
    expect(transfer.mock.calls[0][0].amountUsdDollars).toBe(0.15);
  });
});

describe('one person on both ledgers: debits stay on the ledger that created them', () => {
  it('a referral refund debit is netted from the next REFERRAL transfer, not from a recruiter transfer', async () => {
    enable();
    const w = world();
    const transfer = okTransfer();
    await w.accrueReferrer('bi_r1');
    await settlePayableShares(w.db, { transfer, lookup: noLookup, at: NOW });
    await w.refund('bi_r1', 4, 'ref_1');
    expect(w.db.referralAdjustments).toHaveLength(1);

    await w.accrueRecruiter('bi_a1');
    await settleAffiliateShares(w.db, { transfer, lookup: noLookup, at: NOW });
    expect(transfer.mock.calls[1][0].amountUsdDollars).toBe(0.3); // untouched by the referral debit
    expect(w.db.referralAdjustments[0].appliedUsdCents).toBe(0);
  });
});
