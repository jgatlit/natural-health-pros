-- Referrals v1.4 — stage 1: the Lead Attribution Term snapshot, operator settings, referral ledger.
--
-- EXPAND ONLY. Every added column is NULLable and nothing existing is dropped or rewritten, because
-- migrations apply during the build while the PREVIOUS deploy is still serving traffic and still
-- inserting AttributedClient rows that know nothing about these columns. `expiresAt` stays exactly
-- as it is; `termEndsAt` supersedes it in code first, and the drop is a later contract migration.

-- 1 — operator-editable commercial settings.
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- Seed the two ruled values so an unseeded environment behaves per the ruling rather than
-- falling through to whatever an env var happens to say.
INSERT INTO "PlatformSetting" ("key", "value", "updatedAt")
VALUES ('lead_attribution_term_months', '8', CURRENT_TIMESTAMP),
       ('referral_hold_days', '90', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- 2 — the term, snapshotted per attribution row, plus the referrer.
ALTER TABLE "AttributedClient" ADD COLUMN "termMonths" INTEGER;
ALTER TABLE "AttributedClient" ADD COLUMN "termAnchorAt" TIMESTAMP(3);
ALTER TABLE "AttributedClient" ADD COLUMN "termEndsAt" TIMESTAMP(3);
ALTER TABLE "AttributedClient" ADD COLUMN "referrerPractitionerId" TEXT;

CREATE INDEX "AttributedClient_termEndsAt_idx" ON "AttributedClient"("termEndsAt");
CREATE INDEX "AttributedClient_referrerPractitionerId_idx" ON "AttributedClient"("referrerPractitionerId");

-- 3 — the referral ledger.
CREATE TYPE "ReferralPayableState" AS ENUM ('PAYABLE', 'HELD', 'EXPIRED_UNCLAIMED', 'SETTLED');

CREATE TABLE "ReferralLedgerEntry" (
    "id" TEXT NOT NULL,
    "bookingIntentId" TEXT NOT NULL,
    "whopPaymentId" TEXT,
    "referrerPractitionerId" TEXT NOT NULL,
    "servingPractitionerId" TEXT NOT NULL,
    "clientEmailHash" TEXT NOT NULL,
    "grossUsdCents" INTEGER NOT NULL,
    "referrerShareUsdCents" INTEGER NOT NULL,
    "referrerRateBps" INTEGER NOT NULL,
    "collectedFeeUsdCents" INTEGER NOT NULL,
    "state" "ReferralPayableState" NOT NULL DEFAULT 'PAYABLE',
    "notifiedAt" TIMESTAMP(3),
    "holdCreatedAt" TIMESTAMP(3),
    "holdExpiresAt" TIMESTAMP(3),
    "holdDays" INTEGER,
    "settledAt" TIMESTAMP(3),
    "whopTransferId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReferralLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- IDEMPOTENCY ON WEBHOOK RETRIES. Whop redelivers payment.succeeded; a second row here is a second
-- payout, so the database refuses it rather than the handler remembering to.
CREATE UNIQUE INDEX "ReferralLedgerEntry_bookingIntentId_referrerPractitionerId_key"
    ON "ReferralLedgerEntry"("bookingIntentId", "referrerPractitionerId");
CREATE INDEX "ReferralLedgerEntry_state_holdExpiresAt_idx" ON "ReferralLedgerEntry"("state", "holdExpiresAt");
CREATE INDEX "ReferralLedgerEntry_referrerPractitionerId_state_idx" ON "ReferralLedgerEntry"("referrerPractitionerId", "state");

ALTER TABLE "ReferralLedgerEntry" ADD CONSTRAINT "ReferralLedgerEntry_bookingIntentId_fkey"
    FOREIGN KEY ("bookingIntentId") REFERENCES "BookingIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralLedgerEntry" ADD CONSTRAINT "ReferralLedgerEntry_referrerPractitionerId_fkey"
    FOREIGN KEY ("referrerPractitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralLedgerEntry" ADD CONSTRAINT "ReferralLedgerEntry_servingPractitionerId_fkey"
    FOREIGN KEY ("servingPractitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
