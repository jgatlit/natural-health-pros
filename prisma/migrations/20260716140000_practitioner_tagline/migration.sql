-- AlterTable
ALTER TABLE "Practitioner" ADD COLUMN     "tagline" TEXT;

-- NOTE: `prisma migrate diff` also emitted `DROP INDEX "Practitioner_searchText_trgm_idx";`
-- above this. It was hand-stripped, deliberately. That pg_trgm GIN index is created by raw SQL
-- and is not declared in schema.prisma, so every diff reads it as drift and wants to drop it.
-- Applying it would silently kill typo-tolerant search on production.
-- See memory: gotcha_prisma_migrate_dev_broken (step 4).
