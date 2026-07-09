-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('NONE', 'ACTIVE', 'PAST_DUE', 'CANCELED');


-- AlterTable
ALTER TABLE "Practitioner" ADD COLUMN     "comped" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "whopMembershipId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Practitioner_whopMembershipId_key" ON "Practitioner"("whopMembershipId");


-- Comp existing pilot practitioners (Layer X V1; new practitioners default comped=false)
UPDATE "Practitioner" SET "comped" = true;
