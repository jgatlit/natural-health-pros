-- Transfer at clearing (lane R4): shares move to the payee's Whop balance when the client's payment
-- clears, with retry and recovery state on both ledgers and a refund-debit table for referrers.
-- Expand-only: two enum values and one new table (no rows), plus new columns on two existing tables
-- (metadata-only ADD COLUMN; the NOT NULL columns carry a constant default). Nothing is dropped,
-- renamed or rewritten, and the previous deploy never reads any of it. No data statement.
-- ALTER TYPE ... ADD VALUE runs in this migration's transaction (PostgreSQL 12+) and the new values
-- are not used by it.

-- AlterEnum
ALTER TYPE "ReferralPayableState" ADD VALUE 'SENDING';
ALTER TYPE "ReferralPayableState" ADD VALUE 'REVERSED';

-- AlterTable
ALTER TABLE "ReferralLedgerEntry" ADD COLUMN     "adjustmentAppliedUsdCents" INTEGER,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "reversedUsdCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "transferAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "transferUsdCents" INTEGER;

-- AlterTable
ALTER TABLE "AffiliateLedgerEntry" ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ReferralBalanceAdjustment" (
    "id" TEXT NOT NULL,
    "referrerPractitionerId" TEXT NOT NULL,
    "sourceLedgerEntryId" TEXT NOT NULL,
    "amountUsdCents" INTEGER NOT NULL,
    "appliedUsdCents" INTEGER NOT NULL DEFAULT 0,
    "state" "AffiliateAdjustmentState" NOT NULL DEFAULT 'OPEN',
    "reason" "AffiliateAdjustmentReason" NOT NULL DEFAULT 'REFUND',
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralBalanceAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralBalanceAdjustment_dedupeKey_key" ON "ReferralBalanceAdjustment"("dedupeKey");

-- CreateIndex
CREATE INDEX "ReferralBalanceAdjustment_referrerPractitionerId_state_crea_idx" ON "ReferralBalanceAdjustment"("referrerPractitionerId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "ReferralBalanceAdjustment_sourceLedgerEntryId_idx" ON "ReferralBalanceAdjustment"("sourceLedgerEntryId");

-- AddForeignKey
ALTER TABLE "ReferralBalanceAdjustment" ADD CONSTRAINT "ReferralBalanceAdjustment_referrerPractitionerId_fkey" FOREIGN KEY ("referrerPractitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralBalanceAdjustment" ADD CONSTRAINT "ReferralBalanceAdjustment_sourceLedgerEntryId_fkey" FOREIGN KEY ("sourceLedgerEntryId") REFERENCES "ReferralLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
