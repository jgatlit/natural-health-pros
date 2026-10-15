-- Transfer outcome tracking (lane R4, review round 1): three nullable columns on each payout ledger.
--   adjustmentAllocations  how a claim split its refund-debit netting, so a definitive refusal can
--                          restore exactly those amounts
--   maybeSentAt            an attempt ended with an unknown outcome: a transfer may exist
--   attentionReason        a person must decide whether the transfer went out
-- Expand-only: metadata-only ADD COLUMN of nullable columns, no default, no rewrite, no data
-- statement. The previous deploy never reads any of them.

-- AlterTable
ALTER TABLE "ReferralLedgerEntry" ADD COLUMN     "adjustmentAllocations" TEXT,
ADD COLUMN     "attentionReason" TEXT,
ADD COLUMN     "maybeSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AffiliateLedgerEntry" ADD COLUMN     "adjustmentAllocations" TEXT,
ADD COLUMN     "attentionReason" TEXT,
ADD COLUMN     "maybeSentAt" TIMESTAMP(3);
