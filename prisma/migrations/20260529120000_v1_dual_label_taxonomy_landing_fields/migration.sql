-- V1 pilot — dual-label specialty taxonomy + rich landing-page fields (Amy 5/28-29).
-- Generated via `prisma migrate diff` against the live DB (shadow-DB replay is broken
-- by a historical migration-ordering bug: _init sorts after pg_trgm_search). Expand-only.
-- NB: diff also proposed `DROP INDEX "Practitioner_searchText_trgm_idx"` (the pg_trgm GIN
-- index added by raw SQL, not declared in schema.prisma). That line is intentionally
-- OMITTED here to preserve pg_trgm typo-tolerant search.

-- CreateEnum
CREATE TYPE "SpecialtyStatus" AS ENUM ('ACTIVE', 'PROPOSED', 'MERGED');

-- CreateEnum
CREATE TYPE "AliasSource" AS ENUM ('PRACTITIONER', 'CURATED', 'IMPORT');

-- CreateEnum
CREATE TYPE "AliasStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Practitioner" ADD COLUMN     "firstSessionPriceCents" INTEGER,
ADD COLUMN     "headline" TEXT,
ADD COLUMN     "inPerson" BOOLEAN,
ADD COLUMN     "photoUrl" TEXT,
ADD COLUMN     "telehealth" BOOLEAN,
ADD COLUMN     "websiteUrl" TEXT;

-- AlterTable
ALTER TABLE "PractitionerSpecialty" ADD COLUMN     "rawLabel" TEXT;

-- AlterTable
ALTER TABLE "Specialty" ADD COLUMN     "mergedIntoId" TEXT,
ADD COLUMN     "status" "SpecialtyStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "SpecialtyAlias" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "specialtyId" TEXT NOT NULL,
    "source" "AliasSource" NOT NULL DEFAULT 'PRACTITIONER',
    "status" "AliasStatus" NOT NULL DEFAULT 'PENDING',
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpecialtyAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseStudy" (
    "id" TEXT NOT NULL,
    "practitionerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "outcome" TEXT,
    "anonymized" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseStudy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SpecialtyAlias_label_key" ON "SpecialtyAlias"("label");

-- CreateIndex
CREATE INDEX "SpecialtyAlias_status_idx" ON "SpecialtyAlias"("status");

-- CreateIndex
CREATE INDEX "SpecialtyAlias_specialtyId_idx" ON "SpecialtyAlias"("specialtyId");

-- CreateIndex
CREATE INDEX "CaseStudy_practitionerId_idx" ON "CaseStudy"("practitionerId");

-- AddForeignKey
ALTER TABLE "Specialty" ADD CONSTRAINT "Specialty_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialtyAlias" ADD CONSTRAINT "SpecialtyAlias_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseStudy" ADD CONSTRAINT "CaseStudy_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

