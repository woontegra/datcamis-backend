-- CreateEnum
CREATE TYPE "MenuLocation" AS ENUM ('HEADER', 'FOOTER_1', 'FOOTER_2', 'FOOTER_3');

-- CreateEnum
CREATE TYPE "MenuItemType" AS ENUM ('CATEGORY', 'COLLECTION', 'PAGE', 'CUSTOM');

-- AlterTable
ALTER TABLE "menus" ADD COLUMN "location" "MenuLocation";

-- AlterTable
ALTER TABLE "menu_items" ADD COLUMN "type" "MenuItemType" NOT NULL DEFAULT 'CUSTOM',
ADD COLUMN "categoryId" TEXT,
ADD COLUMN "collectionId" TEXT,
ADD COLUMN "pageId" TEXT,
ADD COLUMN "pageKey" TEXT,
ADD COLUMN "openInNewTab" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "isHidden" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "menus_location_key" ON "menus"("location");

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
