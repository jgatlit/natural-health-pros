-- Referrals v1.4 — stages 3-8: the client list, referral links, the per-booking fee snapshot,
-- the fee ledger, and the settings audit log.
--
-- EXPAND ONLY. Every added column on an existing table is NULLable or carries a DEFAULT, and
-- nothing is dropped or rewritten. Migrations apply DURING THE BUILD while the previous deploy is
-- still serving traffic and still inserting BookingIntent and AttributedClient rows that know
-- nothing about these columns — a NOT NULL without a default here fails every live capture for
-- the length of the deploy.
--
-- `AttributedClient.owner` is the one non-null addition, and it is safe precisely because it has
-- a DEFAULT: an in-flight insert from the old code omits the column and gets 'NHP', which is the
-- correct conservative answer (a booking we cannot prove was pre-listed is ours). Defaulting the
-- other way would silently make every in-flight booking free.
--
-- Nothing here is destructive, so it needs no backfill and no data migration: R1 is forward-only.


-- AlterTable
ALTER TABLE "BookingIntent" ADD COLUMN     "referralCarriage" TEXT,
ADD COLUMN     "referralTouchId" TEXT;

-- AlterTable
ALTER TABLE "AttributedClient" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedByRule" TEXT,
ADD COLUMN     "overriddenAt" TIMESTAMP(3),
ADD COLUMN     "overriddenByUserId" TEXT,
ADD COLUMN     "overrideNote" TEXT,
ADD COLUMN     "owner" TEXT NOT NULL DEFAULT 'NHP',
ADD COLUMN     "referralTouchId" TEXT;

-- CreateTable
CREATE TABLE "ClientListEntry" (
    "id" TEXT NOT NULL,
    "practitionerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "name" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "invitedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "note" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "termMonths" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "emailSentAt" TIMESTAMP(3),
    "referrerNoticeSentAt" TIMESTAMP(3),
    "referredNoticeSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralTouch" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "touchToken" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientEmail" TEXT,
    "clientEmailHash" TEXT,
    "receivedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPENED',
    "bookedNoticeSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralTouch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingFeeSnapshot" (
    "id" TEXT NOT NULL,
    "bookingIntentId" TEXT NOT NULL,
    "attributionOwner" TEXT NOT NULL,
    "termState" TEXT NOT NULL,
    "inTerm" BOOLEAN NOT NULL,
    "planAtMint" TEXT NOT NULL,
    "isCrossReferral" BOOLEAN NOT NULL,
    "priceUsdCents" INTEGER NOT NULL,
    "nhpFeeBps" INTEGER NOT NULL,
    "nhpFeeUsdCents" INTEGER NOT NULL,
    "referrerFeeBps" INTEGER NOT NULL,
    "referrerShareUsdCents" INTEGER NOT NULL,
    "referrerPractitionerId" TEXT,
    "practitionerNetUsdCents" INTEGER NOT NULL,
    "applicationFeeUsdCents" INTEGER NOT NULL,
    "whopCheckoutConfigId" TEXT,
    "whopPaymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingFeeSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeLedgerEntry" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "bookingIntentId" TEXT,
    "practitionerId" TEXT,
    "counterpartyPractitionerId" TEXT,
    "amountUsdCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "whopPaymentId" TEXT,
    "whopTransferId" TEXT,
    "whopFeeOrigin" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "dedupeKey" TEXT NOT NULL,

    CONSTRAINT "FeeLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSettingChange" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT NOT NULL,
    "changedByUserId" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformSettingChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientListEntry_practitionerId_addedAt_idx" ON "ClientListEntry"("practitionerId", "addedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClientListEntry_practitionerId_emailHash_key" ON "ClientListEntry"("practitionerId", "emailHash");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_token_key" ON "Referral"("token");

-- CreateIndex
CREATE INDEX "Referral_referrerId_issuedAt_idx" ON "Referral"("referrerId", "issuedAt");

-- CreateIndex
CREATE INDEX "Referral_referredId_idx" ON "Referral"("referredId");

-- CreateIndex
CREATE INDEX "Referral_expiresAt_idx" ON "Referral"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralTouch_touchToken_key" ON "ReferralTouch"("touchToken");

-- CreateIndex
CREATE INDEX "ReferralTouch_referralId_openedAt_idx" ON "ReferralTouch"("referralId", "openedAt");

-- CreateIndex
CREATE INDEX "ReferralTouch_clientEmailHash_receivedAt_idx" ON "ReferralTouch"("clientEmailHash", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingFeeSnapshot_bookingIntentId_key" ON "BookingFeeSnapshot"("bookingIntentId");

-- CreateIndex
CREATE INDEX "BookingFeeSnapshot_referrerPractitionerId_idx" ON "BookingFeeSnapshot"("referrerPractitionerId");

-- CreateIndex
CREATE UNIQUE INDEX "FeeLedgerEntry_dedupeKey_key" ON "FeeLedgerEntry"("dedupeKey");

-- CreateIndex
CREATE INDEX "FeeLedgerEntry_kind_status_idx" ON "FeeLedgerEntry"("kind", "status");

-- CreateIndex
CREATE INDEX "FeeLedgerEntry_bookingIntentId_idx" ON "FeeLedgerEntry"("bookingIntentId");

-- CreateIndex
CREATE INDEX "FeeLedgerEntry_practitionerId_createdAt_idx" ON "FeeLedgerEntry"("practitionerId", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformSettingChange_key_changedAt_idx" ON "PlatformSettingChange"("key", "changedAt");

-- AddForeignKey
ALTER TABLE "ClientListEntry" ADD CONSTRAINT "ClientListEntry_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralTouch" ADD CONSTRAINT "ReferralTouch_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingFeeSnapshot" ADD CONSTRAINT "BookingFeeSnapshot_bookingIntentId_fkey" FOREIGN KEY ("bookingIntentId") REFERENCES "BookingIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
