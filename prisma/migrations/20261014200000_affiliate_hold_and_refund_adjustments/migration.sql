-- Lane R2: recruiter payouts with no hold + refund-after-payout netting.
-- Expand-only: two new enums, one new table (no rows), one nullable column on each of two existing
-- tables (metadata-only ADD COLUMN, no rewrite). The previous deploy never reads any of it.
-- No data statement: the `affiliate_hold_days` setting resolves database row -> env -> default 0
-- (it is NOT seeded by SQL, exactly like `referral_hold_days`), and the AffiliateLedgerEntry table
-- is empty in production, so no existing row's holdUntil is rewritten.
-- Foreign keys on the new table are RESTRICT (a debt must not be erased by a cascade).

-- CreateEnum
CREATE TYPE "AffiliateAdjustmentState" AS ENUM ('OPEN', 'APPLIED');

-- CreateEnum
CREATE TYPE "AffiliateAdjustmentReason" AS ENUM ('REFUND');

-- AlterTable
ALTER TABLE "AffiliateLedgerEntry" ADD COLUMN     "adjustmentAppliedUsdCents" INTEGER;

-- AlterTable
ALTER TABLE "PlatformSettingChange" ADD COLUMN     "reason" TEXT;

-- CreateTable
CREATE TABLE "AffiliateBalanceAdjustment" (
    "id" TEXT NOT NULL,
    "recruiterPractitionerId" TEXT NOT NULL,
    "sourceLedgerEntryId" TEXT NOT NULL,
    "amountUsdCents" INTEGER NOT NULL,
    "appliedUsdCents" INTEGER NOT NULL DEFAULT 0,
    "state" "AffiliateAdjustmentState" NOT NULL DEFAULT 'OPEN',
    "reason" "AffiliateAdjustmentReason" NOT NULL DEFAULT 'REFUND',
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliateBalanceAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateBalanceAdjustment_dedupeKey_key" ON "AffiliateBalanceAdjustment"("dedupeKey");

-- CreateIndex
CREATE INDEX "AffiliateBalanceAdjustment_recruiterPractitionerId_state_cr_idx" ON "AffiliateBalanceAdjustment"("recruiterPractitionerId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "AffiliateBalanceAdjustment_sourceLedgerEntryId_idx" ON "AffiliateBalanceAdjustment"("sourceLedgerEntryId");

-- AddForeignKey
ALTER TABLE "AffiliateBalanceAdjustment" ADD CONSTRAINT "AffiliateBalanceAdjustment_recruiterPractitionerId_fkey" FOREIGN KEY ("recruiterPractitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateBalanceAdjustment" ADD CONSTRAINT "AffiliateBalanceAdjustment_sourceLedgerEntryId_fkey" FOREIGN KEY ("sourceLedgerEntryId") REFERENCES "AffiliateLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
