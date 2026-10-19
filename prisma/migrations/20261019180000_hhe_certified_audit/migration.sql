-- tsk_1fb8683b: record who last granted or removed the 'HHE Certified' badge, and when.
-- Expand-only: two nullable columns and a foreign key. No existing row's values change
-- ("hheCertified" is not touched).
ALTER TABLE "Practitioner" ADD COLUMN     "hheCertifiedChangedAt" TIMESTAMP(3),
ADD COLUMN     "hheCertifiedChangedById" TEXT;

ALTER TABLE "Practitioner" ADD CONSTRAINT "Practitioner_hheCertifiedChangedById_fkey" FOREIGN KEY ("hheCertifiedChangedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
