-- Plan A / Plan B choice + the client attribution ledger.
--
-- EXPAND-ONLY. Both Practitioner columns are nullable with no default, and the new table is
-- additive, so this applies safely during a Vercel build while the PREVIOUS deploy is still
-- serving traffic and still writing rows that know nothing about either.
--
-- Nothing is backfilled. A null `plan` honestly means "has not chosen" — true of every
-- practitioner listed before this shipped — and must not be quietly turned into a commercial
-- commitment nobody agreed to.

-- AlterTable
ALTER TABLE "Practitioner" ADD COLUMN     "plan" TEXT,
ADD COLUMN     "planChosenAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AttributedClient" (
    "id" TEXT NOT NULL,
    "practitionerId" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "party" "LeadAttributionParty",
    "source" TEXT,
    "firstBookingIntentId" TEXT,
    "attributedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttributedClient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttributedClient_practitionerId_emailHash_key" ON "AttributedClient"("practitionerId", "emailHash");

-- CreateIndex
CREATE INDEX "AttributedClient_emailHash_idx" ON "AttributedClient"("emailHash");

-- CreateIndex
CREATE INDEX "AttributedClient_expiresAt_idx" ON "AttributedClient"("expiresAt");

-- AddForeignKey
ALTER TABLE "AttributedClient" ADD CONSTRAINT "AttributedClient_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
