-- Wedge 2C — Whop Platforms scaffold (Connected Accounts / multi-tenant payment routing)
-- See docs/PHASE-2C-WHOP-DESIGN.md for the full architectural plan.
-- Live API integration paused pending Whop for Platforms API access (sales@whop.com).

CREATE TYPE "WhopKycStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'VERIFIED', 'REJECTED');
CREATE TYPE "ProductInterval" AS ENUM ('ONE_TIME', 'MONTHLY', 'ANNUAL');

ALTER TABLE "Practitioner" ADD COLUMN "whopCompanyId" TEXT;
ALTER TABLE "Practitioner" ADD COLUMN "whopKycStatus" "WhopKycStatus" NOT NULL DEFAULT 'NOT_STARTED';
ALTER TABLE "Practitioner" ADD COLUMN "whopKycCompletedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Practitioner_whopCompanyId_key" ON "Practitioner"("whopCompanyId");

CREATE TABLE "WhopProduct" (
    "id" TEXT NOT NULL,
    "practitionerId" TEXT NOT NULL,
    "whopProductId" TEXT NOT NULL,
    "whopPlanId" TEXT,
    "whopCheckoutConfigId" TEXT,
    "purchaseUrl" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priceUsdCents" INTEGER NOT NULL,
    "applicationFeeCents" INTEGER NOT NULL DEFAULT 0,
    "interval" "ProductInterval" NOT NULL DEFAULT 'ONE_TIME',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhopProduct_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhopProduct_whopProductId_key" ON "WhopProduct"("whopProductId");
CREATE INDEX "WhopProduct_practitionerId_active_idx" ON "WhopProduct"("practitionerId", "active");

ALTER TABLE "WhopProduct" ADD CONSTRAINT "WhopProduct_practitionerId_fkey"
    FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WhopWebhookEvent" (
    "id" TEXT NOT NULL,
    "whopEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "WhopWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhopWebhookEvent_whopEventId_key" ON "WhopWebhookEvent"("whopEventId");
CREATE INDEX "WhopWebhookEvent_eventType_processedAt_idx" ON "WhopWebhookEvent"("eventType", "processedAt");
