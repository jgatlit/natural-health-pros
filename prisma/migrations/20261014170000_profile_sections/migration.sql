-- CreateTable
CREATE TABLE "ProfileSection" (
    "id" TEXT NOT NULL,
    "practitionerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "mediaKind" TEXT,
    "mediaUrl" TEXT,
    "embedProvider" TEXT,
    "embedId" TEXT,
    "posterUrl" TEXT,
    "caption" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileSection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProfileSection_practitionerId_sortOrder_idx" ON "ProfileSection"("practitionerId", "sortOrder");

-- AddForeignKey
ALTER TABLE "ProfileSection" ADD CONSTRAINT "ProfileSection_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

