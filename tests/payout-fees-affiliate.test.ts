import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TRANSFERS_DISABLED_REASON, settleAffiliateShares } from '@/lib/affiliate-payouts';
import { fakeAffiliateDb } from './helpers/fake-affiliate-db';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * L2a: PAYEE ABSORBS WHOP'S TRANSFER FEE, affiliate path, against a MOCKED /transfers only.
 * Nothing here can reach Whop; WHOP_TRANSFERS_ENABLED is flipped on the process env inside this
 * file and restored.
 */

const ENV = [
  'WHOP_TRANSFERS_ENABLED',
  'WHOP_COMPANY_API_KEY',
  'WHOP_PARENT_COMPANY_ID',
  'WHOP_TRANSFER_FEE_BPS',
  'WHOP_TRANSFER_FEE_MODE',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

const feeEnv = (mode: string, bps = '300') => {
  process.env.WHOP_TRANSFERS_ENABLED = 'true';
  process.env.WHOP_COMPANY_API_KEY = 'test-key';
  process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';
  process.env.WHOP_TRANSFER_FEE_MODE = mode;
  process.env.WHOP_TRANSFER_FEE_BPS = bps;
};

const NOW = new Date(Date.UTC(2027, 0, 1));
const PAST = new Date(Date.UTC(2026, 11, 1));
const wallets = { R: { whopCompanyId: 'biz_R', whopPayoutsEnabled: true } };

const entry = (over: Record<string, any> = {}) => ({
  bookingIntentId: 'bi_1',
  recruiterPractitionerId: 'R',
  recruitedPractitionerId: 'Y',
  grossUsdCents: 100_000,
  bps: 300,
  shareUsdCents: 300,
  holdUntil: PAST,
  holdDays: 90,
  ...over,
});

const okTransfer = () => vi.fn(async () => ({ transferId: 'tr_1' }));

describe('affiliate settle: fee modes and the ledger record', () => {
  it('charged-to-sender: sends gross - fee in DOLLARS and records gross / fee / net', async () => {
    feeEnv('charged-to-sender');
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry({ shareUsdCents: 1234 })] });
    const transfer = okTransfer();
    await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ amountUsdDollars: 11.98 }));
    expect(db.rows[0]).toMatchObject({
      state: 'SETTLED',
      grossShareUsdCents: 1234,
      transferFeeUsdCents: 36,
      netPaidUsdCents: 1198,
      transferUsdCents: 1198,
    });
    expect(db.rows[0].netPaidUsdCents).toBe(db.rows[0].grossShareUsdCents - db.rows[0].transferFeeUsdCents);
  });

  it('deducted-from-recipient: sends the whole gross (12.34) and records the fee the payee bears', async () => {
    feeEnv('deducted-from-recipient');
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry({ shareUsdCents: 1234 })] });
    const transfer = okTransfer();
    await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ amountUsdDollars: 12.34 }));
    expect(db.rows[0]).toMatchObject({ grossShareUsdCents: 1234, transferFeeUsdCents: 38, netPaidUsdCents: 1196 });
  });

  it('the gross is the share NET OF REFUNDS at claim time', async () => {
    feeEnv('deducted-from-recipient', '0');
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry({ shareUsdCents: 1000, reversedUsdCents: 250 })] });
    await settleAffiliateShares(db as any, { transfer: okTransfer(), at: NOW });
    expect(db.rows[0]).toMatchObject({ grossShareUsdCents: 750, transferFeeUsdCents: 0, netPaidUsdCents: 750 });
  });
});

describe('affiliate settle: tiny shares and failure paths', () => {
  it('a share too small for the fee is NOT sent, stays ACCRUED with a recorded reason, and does not starve others', async () => {
    feeEnv('charged-to-sender');
    const db = fakeAffiliateDb({
      practitioners: wallets,
      entries: [
        entry({ bookingIntentId: 'tiny', shareUsdCents: 1, holdUntil: new Date(Date.UTC(2026, 0, 1)) }),
        entry({ bookingIntentId: 'ok', shareUsdCents: 300 }),
      ],
    });
    const transfer = okTransfer();
    const summary = await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ settled: 1, belowFee: 1 });
    const tiny = db.rows.find((r: any) => r.bookingIntentId === 'tiny')!;
    expect(tiny.state).toBe('ACCRUED');
    expect(tiny.lastError).toMatch(/BELOW_TRANSFER_FEE/);
    expect(tiny.whopTransferId).toBeNull();
  });

  it('a refund that shrinks a sendable share below the fee records the reason and sends nothing', async () => {
    feeEnv('charged-to-sender');
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry({ shareUsdCents: 300, reversedUsdCents: 299 })] });
    const transfer = okTransfer();
    await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(transfer).not.toHaveBeenCalled();
    expect(db.rows[0].state).toBe('ACCRUED');
    expect(db.rows[0].lastError).toMatch(/BELOW_TRANSFER_FEE/);
  });

  it('a definitive 4xx puts the row back with no recorded fee; the retry records it once and pays once', async () => {
    feeEnv('charged-to-sender');
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry({ shareUsdCents: 1000 })] });
    const failing = vi.fn(async () => {
      throw new Error('Whop /transfers failed (422): nope');
    });
    await settleAffiliateShares(db as any, { transfer: failing as any, at: NOW });
    expect(db.rows[0]).toMatchObject({ state: 'ACCRUED', transferFeeUsdCents: null, netPaidUsdCents: null });
    const ok = okTransfer();
    await settleAffiliateShares(db as any, { transfer: ok, at: NOW });
    await settleAffiliateShares(db as any, { transfer: ok, at: NOW });
    expect(ok).toHaveBeenCalledTimes(1);
    expect(db.rows[0]).toMatchObject({ state: 'SETTLED', transferFeeUsdCents: 30, netPaidUsdCents: 970 });
  });

  it('an ambiguous failure parks HELD and keeps what was claimed; never retried', async () => {
    feeEnv('charged-to-sender');
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry({ shareUsdCents: 1000 })] });
    const boom = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    await settleAffiliateShares(db as any, { transfer: boom as any, at: NOW });
    await settleAffiliateShares(db as any, { transfer: boom as any, at: NOW });
    expect(boom).toHaveBeenCalledTimes(1);
    expect(db.rows[0]).toMatchObject({
      state: 'HELD',
      grossShareUsdCents: 1000,
      transferFeeUsdCents: 30,
      netPaidUsdCents: null,
    });
  });

  it('an invalid fee configuration blocks the run and calls nothing', async () => {
    feeEnv('charged-to-sender', 'abc');
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry()] });
    const transfer = okTransfer();
    const summary = await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(summary.blocked).toMatch(/fee configuration invalid/);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('flag false: nothing is read, written or called, whatever the fee config', async () => {
    process.env.WHOP_TRANSFER_FEE_BPS = '300';
    const db = fakeAffiliateDb({ practitioners: wallets, entries: [entry({ shareUsdCents: 1 })] });
    const upd = vi.spyOn(db.affiliateLedgerEntry, 'updateMany');
    const find = vi.spyOn(db.affiliateLedgerEntry, 'findMany');
    const transfer = okTransfer();
    const summary = await settleAffiliateShares(db as any, { transfer, at: NOW });
    expect(summary.blocked).toBe(TRANSFERS_DISABLED_REASON);
    expect(upd).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });
});
