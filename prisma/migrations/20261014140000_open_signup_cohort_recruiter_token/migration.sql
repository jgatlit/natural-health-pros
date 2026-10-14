-- L0b: open sign-up cohorts + per-practitioner recruiter token. EXPAND-ONLY (nullable columns, one
-- new table); no existing column is touched, so the previous deploy keeps working while this applies.

-- AlterTable
ALTER TABLE "Practitioner" ADD COLUMN     "recruitedAt" TIMESTAMP(3),
ADD COLUMN     "recruitedById" TEXT,
ADD COLUMN     "recruitedVia" TEXT,
ADD COLUMN     "recruiterToken" TEXT;

-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "cohortId" TEXT,
ADD COLUMN     "recruiterToken" TEXT;

-- CreateTable
CREATE TABLE "SignupCohort" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "grantsPilot" BOOLEAN NOT NULL DEFAULT true,
    "rateScheduleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignupCohort_pkey" PRIMARY KEY ("id")
);

-- Backfill a recruiter token for EVERY existing practitioner (32 hex chars = 16 random bytes;
-- gen_random_uuid() is built into PG13+, no extension). Runs before the unique index so the index
-- build sees the final data; the WHERE makes a re-run a no-op.
UPDATE "Practitioner"
SET "recruiterToken" = replace(gen_random_uuid()::text, '-', '')
WHERE "recruiterToken" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "SignupCohort_slug_key" ON "SignupCohort"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Practitioner_recruiterToken_key" ON "Practitioner"("recruiterToken");

-- CreateIndex
CREATE INDEX "Invitation_cohortId_idx" ON "Invitation"("cohortId");

-- AddForeignKey
ALTER TABLE "Practitioner" ADD CONSTRAINT "Practitioner_recruitedById_fkey" FOREIGN KEY ("recruitedById") REFERENCES "Practitioner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "SignupCohort"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the `hhe` cohort idempotently (after the unique index it conflicts on), so production needs no admin action.
INSERT INTO "SignupCohort" ("id", "slug", "label", "enabled", "grantsPilot")
VALUES ('cohort_hhe', 'hhe', 'Holistic Health Educators', true, true)
ON CONFLICT ("slug") DO NOTHING;
