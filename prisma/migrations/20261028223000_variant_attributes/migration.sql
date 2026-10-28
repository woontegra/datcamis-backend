-- CreateEnum
CREATE TYPE "AttributeDisplay" AS ENUM ('BUTTONS', 'SELECT', 'SWATCH');

-- AlterTable
ALTER TABLE "product_option_values" ADD COLUMN "attributeValueId" TEXT;

-- AlterTable
ALTER TABLE "product_options" ADD COLUMN "attributeId" TEXT;

-- CreateTable
CREATE TABLE "variant_attributes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayType" "AttributeDisplay" NOT NULL DEFAULT 'BUTTONS',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "variant_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_attribute_values" (
    "id" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colorHex" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "variant_attribute_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "variant_attributes_name_key" ON "variant_attributes"("name");

-- CreateIndex
CREATE UNIQUE INDEX "variant_attribute_values_attributeId_name_key" ON "variant_attribute_values"("attributeId", "name");

-- CreateIndex
CREATE INDEX "product_option_values_attributeValueId_idx" ON "product_option_values"("attributeValueId");

-- CreateIndex
CREATE INDEX "product_options_attributeId_idx" ON "product_options"("attributeId");

-- AddForeignKey
ALTER TABLE "variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "variant_attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "variant_attributes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_values" ADD CONSTRAINT "product_option_values_attributeValueId_fkey" FOREIGN KEY ("attributeValueId") REFERENCES "variant_attribute_values"("id") ON DELETE SET NULL ON UPDATE CASCADE;
