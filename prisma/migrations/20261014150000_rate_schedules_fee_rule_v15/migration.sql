-- Rate schedules + fee rule v1.5 (spec v1.5 §2, lane L1). EXPAND-ONLY: new tables, nullable
-- columns, and an idempotent seed + backfill. Nothing is dropped, renamed or made NOT NULL — the
-- previous deploy keeps working while this applies (build runs `prisma migrate deploy` while the old
-- release still serves traffic). Making "Practitioner"."rateScheduleId" NOT NULL is a later contract
-- release.
--
-- 1. DDL (generated offline, schema -> schema; no shadow database).
-- 2. Seed schedule v1 "Go-forward 2026-10". The contentHash literal below is the output of the
--    application's own canonical hash (src/lib/rate-schedule-hash.ts) over these exact numbers;
--    tests/rate-schedule-hash.test.ts parses it back out of THIS FILE and asserts equality, so SQL
--    and code cannot drift. Never hand-edit it.
-- 3. Point new sign-ups at v1 (PlatformSetting current_rate_schedule_id).
-- 4. Backfill every existing practitioner onto v1, with one history row each.
--
-- Every statement from step 2 on is idempotent: re-applying this file changes nothing.

-- 1 — DDL
-- AlterTable
ALTER TABLE "Practitioner" ADD COLUMN     "rateScheduleId" TEXT;

-- AlterTable
ALTER TABLE "AttributedClient" ADD COLUMN     "rateScheduleId" TEXT,
ADD COLUMN     "referrerTermEndsAt" TIMESTAMP(3),
ADD COLUMN     "referrerTermMonths" INTEGER;

-- AlterTable
ALTER TABLE "BookingFeeSnapshot" ADD COLUMN     "affiliateBps" INTEGER,
ADD COLUMN     "affiliateShareUsdCents" INTEGER,
ADD COLUMN     "nhpNetUsdCents" INTEGER,
ADD COLUMN     "rateScheduleId" TEXT,
ADD COLUMN     "recruiterPractitionerId" TEXT,
ADD COLUMN     "referrerTermState" TEXT;

-- CreateTable
CREATE TABLE "RateSchedule" (
    "id" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "planAMonthlyCents" INTEGER NOT NULL,
    "annualDiscountBps" INTEGER NOT NULL,
    "planASourcedBps" INTEGER NOT NULL,
    "planBMonthlyCents" INTEGER NOT NULL,
    "planBSourcedBps" INTEGER NOT NULL,
    "referralTotalBps" INTEGER NOT NULL,
    "referrerBps" INTEGER NOT NULL,
    "affiliateBps" INTEGER NOT NULL,
    "leadTermMonths" INTEGER NOT NULL,
    "referrerTermMonths" INTEGER NOT NULL,
    "maxTotalFeeBps" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,

    CONSTRAINT "RateSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateScheduleAssignment" (
    "id" TEXT NOT NULL,
    "practitionerId" TEXT NOT NULL,
    "rateScheduleId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "byUserId" TEXT,

    CONSTRAINT "RateScheduleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RateSchedule_contentHash_key" ON "RateSchedule"("contentHash");

-- CreateIndex
CREATE INDEX "RateScheduleAssignment_practitionerId_effectiveFrom_idx" ON "RateScheduleAssignment"("practitionerId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "RateScheduleAssignment_rateScheduleId_idx" ON "RateScheduleAssignment"("rateScheduleId");

-- AddForeignKey
ALTER TABLE "Practitioner" ADD CONSTRAINT "Practitioner_rateScheduleId_fkey" FOREIGN KEY ("rateScheduleId") REFERENCES "RateSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateScheduleAssignment" ADD CONSTRAINT "RateScheduleAssignment_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateScheduleAssignment" ADD CONSTRAINT "RateScheduleAssignment_rateScheduleId_fkey" FOREIGN KEY ("rateScheduleId") REFERENCES "RateSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2 — SEED SCHEDULE v1 "Go-forward 2026-10" (operator rulings O1–O8, 2026-10-14).
INSERT INTO "RateSchedule" (
    "id", "contentHash", "label",
    "planAMonthlyCents", "annualDiscountBps", "planASourcedBps",
    "planBMonthlyCents", "planBSourcedBps",
    "referralTotalBps", "referrerBps", "affiliateBps",
    "leadTermMonths", "referrerTermMonths", "maxTotalFeeBps",
    "createdAt"
) VALUES (
    'rs_go_forward_2026_10',
    'a16f357fd12566c065c909037870542881bbbf34dae690200e908bd01a55c4b9',
    'Go-forward 2026-10',
    3900, 2000, 1000,
    0, 3000,
    3000, 2000, 300,
    8, 4, 3000,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("contentHash") DO NOTHING;

-- 3 — NEW SIGN-UPS GET v1. DO NOTHING on conflict so re-applying never overrides a schedule an
-- admin has since made current. Resolved by hash, not by the fixed id, so it points at whichever row
-- holds these numbers.
INSERT INTO "PlatformSetting" ("key", "value", "createdAt", "updatedAt")
SELECT 'current_rate_schedule_id', rs."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "RateSchedule" rs
WHERE rs."contentHash" = 'a16f357fd12566c065c909037870542881bbbf34dae690200e908bd01a55c4b9'
ON CONFLICT ("key") DO NOTHING;

-- 4 — BACKFILL. Only practitioners with no schedule yet (so a re-run, or a practitioner an admin
-- has since moved, is untouched).
UPDATE "Practitioner"
   SET "rateScheduleId" = (
         SELECT rs."id" FROM "RateSchedule" rs
          WHERE rs."contentHash" = 'a16f357fd12566c065c909037870542881bbbf34dae690200e908bd01a55c4b9'
       )
 WHERE "rateScheduleId" IS NULL;

-- One history row per practitioner that has a schedule but no history yet.
INSERT INTO "RateScheduleAssignment" ("id", "practitionerId", "rateScheduleId", "effectiveFrom", "reason")
SELECT gen_random_uuid()::text, p."id", p."rateScheduleId", CURRENT_TIMESTAMP, 'ADMIN_MIGRATION'
FROM "Practitioner" p
WHERE p."rateScheduleId" IS NOT NULL
  AND NOT EXISTS (
        SELECT 1 FROM "RateScheduleAssignment" a WHERE a."practitionerId" = p."id"
      );
