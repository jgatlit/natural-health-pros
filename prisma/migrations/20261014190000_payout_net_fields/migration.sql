-- L2a payouts prep (spec v1.5 s4): record gross share, Whop transfer fee and net paid on both ledgers.
-- Expand-only: three nullable INTEGER columns per table (metadata-only ADD COLUMN, no rewrite), so
-- the previous deploy keeps working. The only data statement is an idempotent backfill of the gross
-- share (= the current share) where it is still NULL. Transfer fee / net stay NULL until a transfer
-- is attempted.

-- AlterTable
ALTER TABLE "ReferralLedgerEntry" ADD COLUMN     "grossShareUsdCents" INTEGER,
ADD COLUMN     "netPaidUsdCents" INTEGER,
ADD COLUMN     "transferFeeUsdCents" INTEGER;

-- AlterTable
ALTER TABLE "AffiliateLedgerEntry" ADD COLUMN     "grossShareUsdCents" INTEGER,
ADD COLUMN     "netPaidUsdCents" INTEGER,
ADD COLUMN     "transferFeeUsdCents" INTEGER;

-- Backfill (idempotent: only fills NULLs)
UPDATE "ReferralLedgerEntry" SET "grossShareUsdCents" = "referrerShareUsdCents" WHERE "grossShareUsdCents" IS NULL;
UPDATE "AffiliateLedgerEntry" SET "grossShareUsdCents" = "shareUsdCents" WHERE "grossShareUsdCents" IS NULL;
