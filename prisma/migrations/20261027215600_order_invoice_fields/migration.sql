-- AlterTable
ALTER TABLE "orders" ADD COLUMN "invoiceNumber" TEXT;
ALTER TABLE "orders" ADD COLUMN "invoicedAt" TIMESTAMP(3);
