-- AlterTable: the 90-day pilot clock. Nullable = "pre-trial" (operator-seeded, never
-- onboarded) and still listed. Additive only — `comped` is deliberately NOT dropped here.
-- Dropping it in the same migration would break the LIVE deployment the moment this applies,
-- because migrate deploy runs during build while the previous deploy still serves traffic and
-- still reads comped. Expand now; contract (DROP COLUMN "comped") in a follow-up once nothing
-- reads it.
ALTER TABLE "Practitioner" ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

-- AddForeignKey: Invitation.acceptedByUserId was a bare String with no relation, so an
-- /admin/invites row could not reach the practitioner behind an accepted invite. Needed for the
-- Reset-trial action. ON DELETE SET NULL — deleting a user must not delete the audit trail of
-- the invitation that was sent.
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- NOTE: `prisma migrate diff` also emitted `DROP INDEX "Practitioner_searchText_trgm_idx";`
-- above these. Hand-stripped, deliberately — that pg_trgm GIN index is raw SQL, invisible to
-- schema.prisma, so every diff reads it as drift. Applying it silently kills typo-tolerant
-- search on production. Third time this has fired. See gotcha_prisma_migrate_dev_broken.
