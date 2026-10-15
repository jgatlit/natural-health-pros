/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, vi } from 'vitest';

import type { LookupFn } from '@/lib/ledger-transfer';
import { AFFILIATE_LEDGER, REFERRAL_LEDGER } from '@/lib/ledger-config';
import { settleAffiliateShares } from '@/lib/affiliate-payouts';
import { settlePayableShares } from '@/lib/referral-payouts';
import { fakeLedgerDb, type Entry } from './fake-ledger-db';

/**
 * Shared set-up for the transfer suites: the two payout ledgers described once (`KINDS`), a database
 * factory for either, and the env switches (`enable` = payouts on with the lookup verified,
 * `enableUnverified` = payouts on, lookup not verified).
 */

export const ENV = ['WHOP_TRANSFERS_ENABLED', 'WHOP_TRANSFERS_ALLOWLIST', 'WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED', 'WHOP_COMPANY_API_KEY', 'WHOP_PARENT_COMPANY_ID'];
let saved: Record<string, string | undefined>;

/** Registers the env isolation and console silencing every transfer suite needs. Call once at the top of the file. */
export function installTransferTestEnv() {
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
}

/** Payouts on, with the lookup verified (the operator recorded the canary result). */
export const enable = () => {
  process.env.WHOP_TRANSFERS_ENABLED = 'true';
  process.env.WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED = 'true';
  process.env.WHOP_COMPANY_API_KEY = 'test-key';
  process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';
};
/** Payouts on, the lookup NOT verified (the state until the canary has been read). */
export const enableUnverified = () => {
  enable();
  delete process.env.WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED;
};

export const NOW = new Date(Date.UTC(2027, 0, 1));
export const at = (ms: number) => new Date(NOW.getTime() + ms);
export const MIN = 60_000;

export const VERIFIED = { whopCompanyId: 'biz_R', whopPayoutsEnabled: true };
export const wallets = {
  R: VERIFIED,
  S: { whopCompanyId: 'biz_S', whopPayoutsEnabled: true },
  U: { whopCompanyId: null, whopPayoutsEnabled: false },
  P: { whopCompanyId: 'biz_P', whopPayoutsEnabled: false },
};

export const okTransfer = () => {
  let n = 0;
  return vi.fn<(args: any) => Promise<{ transferId: string }>>(async () => ({ transferId: `tr_${++n}` }));
};
export const noLookup: LookupFn = async () => ({ kind: 'not-found' });

export type Kind = {
  name: 'affiliate' | 'referral';
  cfg: typeof AFFILIATE_LEDGER;
  waiting: 'ACCRUED' | 'PAYABLE';
  payee: 'recruiterPractitionerId' | 'referrerPractitionerId';
  entry(over?: Record<string, any>): Entry;
  settle(db: any, over?: Record<string, any>): ReturnType<typeof settleAffiliateShares>;
  rows(db: any): Entry[];
  adjustments(db: any): Entry[];
  entryDelegate(db: any): any;
  adjustmentDelegate(db: any): any;
  debit(amount: number, over?: Record<string, any>): Entry;
};

export const KINDS: Kind[] = [
  {
    name: 'affiliate',
    cfg: AFFILIATE_LEDGER,
    waiting: 'ACCRUED',
    payee: 'recruiterPractitionerId',
    entry: (over = {}) => ({
      bookingIntentId: 'bi_1',
      recruiterPractitionerId: 'R',
      recruitedPractitionerId: 'Y',
      grossUsdCents: 10_000,
      bps: 300,
      shareUsdCents: 300,
      holdDays: 0,
      holdUntil: new Date(Date.UTC(2026, 11, 1)),
      ...over,
    }),
    settle: (db, over = {}) =>
      settleAffiliateShares(db, { transfer: okTransfer(), lookup: noLookup, at: NOW, ...over } as any),
    rows: (db) => db.affiliateRows,
    adjustments: (db) => db.affiliateAdjustments,
    entryDelegate: (db) => db.affiliateLedgerEntry,
    adjustmentDelegate: (db) => db.affiliateBalanceAdjustment,
    debit: (amount, over = {}) => ({ recruiterPractitionerId: 'R', sourceLedgerEntryId: 'afl_old', amountUsdCents: amount, ...over }),
  },
  {
    name: 'referral',
    cfg: REFERRAL_LEDGER as any,
    waiting: 'PAYABLE',
    payee: 'referrerPractitionerId',
    entry: (over = {}) => ({
      bookingIntentId: 'bi_1',
      referrerPractitionerId: 'R',
      servingPractitionerId: 'Y',
      grossUsdCents: 1_500,
      referrerShareUsdCents: 300,
      ...over,
    }),
    settle: (db, over = {}) =>
      settlePayableShares(db, { transfer: okTransfer(), lookup: noLookup, at: NOW, ...over } as any) as any,
    rows: (db) => db.referralRows,
    adjustments: (db) => db.referralAdjustments,
    entryDelegate: (db) => db.referralLedgerEntry,
    adjustmentDelegate: (db) => db.referralBalanceAdjustment,
    debit: (amount, over = {}) => ({ referrerPractitionerId: 'R', sourceLedgerEntryId: 'rfl_old', amountUsdCents: amount, ...over }),
  },
];

export function makeDb(k: Kind, o: { practitioners?: Record<string, any>; entries?: Entry[]; adjustments?: Entry[] } = {}) {
  return fakeLedgerDb({
    practitioners: o.practitioners ?? wallets,
    [k.name]: { entries: o.entries, adjustments: o.adjustments },
  } as any);
}
