-- AlterTable
ALTER TABLE "Practitioner" ADD COLUMN     "hheCertified" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "WhopProduct" ADD COLUMN     "category" TEXT,
ALTER COLUMN "whopProductId" DROP NOT NULL;

