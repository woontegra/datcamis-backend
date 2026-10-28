-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN "delta" INTEGER,
ADD COLUMN "balanceAfter" INTEGER;

-- CreateIndex
CREATE INDEX "stock_movements_createdAt_idx" ON "stock_movements"("createdAt");
