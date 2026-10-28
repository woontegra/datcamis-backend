-- CreateEnum
CREATE TYPE "CollectionType" AS ENUM ('MANUAL', 'AUTOMATIC');

-- CreateEnum
CREATE TYPE "CollectionSort" AS ENUM ('MANUAL', 'NEWEST', 'PRICE_ASC', 'PRICE_DESC');

-- AlterTable
ALTER TABLE "categories" ADD COLUMN "imageMediaId" TEXT,
ADD COLUMN "isVisible" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "collections" ADD COLUMN "imageMediaId" TEXT,
ADD COLUMN "isVisible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "productSort" "CollectionSort" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN "rules" JSONB,
ADD COLUMN "type" "CollectionType" NOT NULL DEFAULT 'MANUAL';

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_imageMediaId_fkey" FOREIGN KEY ("imageMediaId") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_imageMediaId_fkey" FOREIGN KEY ("imageMediaId") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
