-- AlterEnum
ALTER TYPE "ProductStatus" ADD VALUE 'DISABLED';

-- AlterTable
ALTER TABLE "products" ADD COLUMN "content" TEXT NOT NULL DEFAULT '';
ALTER TABLE "products" ADD COLUMN "usageNotes" TEXT NOT NULL DEFAULT '';
ALTER TABLE "products" ADD COLUMN "warningNotes" TEXT NOT NULL DEFAULT '';
ALTER TABLE "products" ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN "vatRate" INTEGER;

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN "barcode" TEXT;
ALTER TABLE "product_variants" ADD COLUMN "compareAtAmount" INTEGER;
ALTER TABLE "product_variants" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "product_variants" ADD COLUMN "mediaId" TEXT;
ALTER TABLE "product_variants" ADD COLUMN "desi" DECIMAL(8,2);
ALTER TABLE "product_variants" ADD COLUMN "disabledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "product_variants_mediaId_idx" ON "product_variants"("mediaId");

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
