-- Whop's payout-account endpoint keys on the `poact_…` id, NOT the company id: passing `biz_…`
-- returns 404 "This PayoutAccount was not found" even for a fully connected account (verified
-- live 2026-08-13 against both existing connected accounts). Without this column the payout
-- status cannot be polled at all, so the dropped-webhook reconciliation had no way to work.
--
-- Expand/contract safe: nullable, additive, no backfill. The migration applies during build
-- while the PREVIOUS deploy still serves traffic, and nothing in the currently-live code reads
-- this column.
ALTER TABLE "Practitioner" ADD COLUMN "whopPayoutAccountId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Practitioner_whopPayoutAccountId_key" ON "Practitioner"("whopPayoutAccountId");
