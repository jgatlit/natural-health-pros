/**
 * The two payout ledgers share one transfer routine (`ledger-transfer.ts`) and one refund routine
 * (`ledger-reversal.ts`). They differ only in table, column and state names, which are spelled out
 * here once.
 *
 *   affiliate  AffiliateLedgerEntry  / AffiliateBalanceAdjustment   the recruiter's 3% share
 *   referral   ReferralLedgerEntry   / ReferralBalanceAdjustment    the client-referral share
 *
 * Both ledgers keep the share immutable and the refunds as an absolute running total, so what a row
 * owes is always `share - reversedUsdCents`.
 */

export type LedgerKind = 'affiliate' | 'referral';

export type LedgerConfig = {
  kind: LedgerKind;
  /** Prisma delegate names. */
  entry: 'affiliateLedgerEntry' | 'referralLedgerEntry';
  adjustment: 'affiliateBalanceAdjustment' | 'referralBalanceAdjustment';
  /** The payee's id column; the same name on the entry and on the adjustment. */
  payeeKey: 'recruiterPractitionerId' | 'referrerPractitionerId';
  /** The relation to the payee's Practitioner row. */
  payeeRel: 'recruiterPractitioner' | 'referrerPractitioner';
  /** The unique key on (bookingIntentId, payee). */
  uniqueKey: 'bookingIntentId_recruiterPractitionerId' | 'bookingIntentId_referrerPractitionerId';
  /** The immutable original share, in cents. */
  shareKey: 'shareUsdCents' | 'referrerShareUsdCents';
  /** The state of a row that is owed and not yet claimed. */
  waiting: 'ACCRUED' | 'PAYABLE';
  /** States a fully reversed, never-claimed row is moved to REVERSED from. */
  healFrom: string[];
  /** The affiliate path pays only while the recruiter is active; the referral path has no such rule. */
  activePayeeOnly: boolean;
  /** Prefix of the debit `dedupeKey`: <prefix>:<ledger row id>:<cumulative reversed after the refund>. */
  dedupePrefix: 'REFUND' | 'REFERRAL_REFUND';
  logTag: string;
};

export const AFFILIATE_LEDGER: LedgerConfig = {
  kind: 'affiliate',
  entry: 'affiliateLedgerEntry',
  adjustment: 'affiliateBalanceAdjustment',
  payeeKey: 'recruiterPractitionerId',
  payeeRel: 'recruiterPractitioner',
  uniqueKey: 'bookingIntentId_recruiterPractitionerId',
  shareKey: 'shareUsdCents',
  waiting: 'ACCRUED',
  healFrom: ['ACCRUED', 'HELD'],
  activePayeeOnly: true,
  dedupePrefix: 'REFUND',
  logTag: 'affiliate-payouts',
};

export const REFERRAL_LEDGER: LedgerConfig = {
  kind: 'referral',
  entry: 'referralLedgerEntry',
  adjustment: 'referralBalanceAdjustment',
  payeeKey: 'referrerPractitionerId',
  payeeRel: 'referrerPractitioner',
  uniqueKey: 'bookingIntentId_referrerPractitionerId',
  shareKey: 'referrerShareUsdCents',
  waiting: 'PAYABLE',
  healFrom: ['PAYABLE', 'HELD', 'EXPIRED_UNCLAIMED'],
  activePayeeOnly: false,
  dedupePrefix: 'REFERRAL_REFUND',
  logTag: 'referral-payouts',
};
