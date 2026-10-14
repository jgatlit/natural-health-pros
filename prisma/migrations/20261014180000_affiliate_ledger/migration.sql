-- CreateEnum
CREATE TYPE "AffiliateLedgerState" AS ENUM ('ACCRUED', 'HELD', 'SENDING', 'SETTLED', 'REVERSED');

-- CreateTable
CREATE TABLE "AffiliateLedgerEntry" (
    "id" TEXT NOT NULL,
    "bookingIntentId" TEXT NOT NULL,
    "whopPaymentId" TEXT,
    "recruiterPractitionerId" TEXT NOT NULL,
    "recruitedPractitionerId" TEXT NOT NULL,
    "grossUsdCents" INTEGER NOT NULL,
    "bps" INTEGER NOT NULL,
    "shareUsdCents" INTEGER NOT NULL,
    "reversedUsdCents" INTEGER NOT NULL DEFAULT 0,
    "state" "AffiliateLedgerState" NOT NULL DEFAULT 'ACCRUED',
    "holdDays" INTEGER NOT NULL,
    "holdUntil" TIMESTAMP(3) NOT NULL,
    "transferUsdCents" INTEGER,
    "settledAt" TIMESTAMP(3),
    "whopTransferId" TEXT,
    "transferAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliateLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AffiliateLedgerEntry_state_holdUntil_idx" ON "AffiliateLedgerEntry"("state", "holdUntil");

-- CreateIndex
CREATE INDEX "AffiliateLedgerEntry_recruiterPractitionerId_state_idx" ON "AffiliateLedgerEntry"("recruiterPractitionerId", "state");

-- CreateIndex
CREATE INDEX "AffiliateLedgerEntry_recruitedPractitionerId_idx" ON "AffiliateLedgerEntry"("recruitedPractitionerId");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateLedgerEntry_bookingIntentId_recruiterPractitionerI_key" ON "AffiliateLedgerEntry"("bookingIntentId", "recruiterPractitionerId");

-- AddForeignKey
ALTER TABLE "AffiliateLedgerEntry" ADD CONSTRAINT "AffiliateLedgerEntry_bookingIntentId_fkey" FOREIGN KEY ("bookingIntentId") REFERENCES "BookingIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateLedgerEntry" ADD CONSTRAINT "AffiliateLedgerEntry_recruiterPractitionerId_fkey" FOREIGN KEY ("recruiterPractitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateLedgerEntry" ADD CONSTRAINT "AffiliateLedgerEntry_recruitedPractitionerId_fkey" FOREIGN KEY ("recruitedPractitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
