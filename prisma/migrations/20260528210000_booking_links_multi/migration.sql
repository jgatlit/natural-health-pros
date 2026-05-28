-- Wedge 2B (expand) — multiple practitioner-owned booking links.
-- Additive + zero-downtime on the shared Neon DB: creates BookingLink and copies
-- existing Practitioner.bookingUrl values forward. The deprecated bookingUrl column
-- is intentionally retained here; a follow-up contract migration drops it once the
-- new code (which reads/writes bookingLinks) is fully deployed.

-- CreateTable
CREATE TABLE "BookingLink" (
    "id" TEXT NOT NULL,
    "practitionerId" TEXT NOT NULL,
    "label" TEXT,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingLink_practitionerId_idx" ON "BookingLink"("practitionerId");

-- AddForeignKey
ALTER TABLE "BookingLink" ADD CONSTRAINT "BookingLink_practitionerId_fkey"
    FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data migration: carry forward each practitioner's existing single booking URL.
INSERT INTO "BookingLink" ("id", "practitionerId", "label", "url", "sortOrder", "createdAt")
SELECT gen_random_uuid()::text, "id", NULL, "bookingUrl", 0, CURRENT_TIMESTAMP
FROM "Practitioner"
WHERE "bookingUrl" IS NOT NULL AND "bookingUrl" <> '';
