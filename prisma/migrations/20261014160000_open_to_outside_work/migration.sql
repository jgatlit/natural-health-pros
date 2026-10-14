-- AlterTable
ALTER TABLE "Practitioner" ADD COLUMN     "openToOutsideWork" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "openToOutsideWorkUpdatedAt" TIMESTAMP(3);
