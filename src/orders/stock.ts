import type { Prisma } from "@prisma/client";
import { AppError } from "../common/errors";

export const STOCK_CAPTURE_REASON = "paytr_paid";
export const HAVALE_STOCK_REASON = "havale_placed";
export const STOCK_RESTORE_REASONS = ["order_cancel", "order_return"] as const;

type Tx = Prisma.TransactionClient;

async function orderItems(tx: Tx, orderId: string) {
  return tx.orderItem.findMany({ where: { orderId } });
}

export async function captureStockOnce(tx: Tx, orderId: string, reason = STOCK_CAPTURE_REASON) {
  const already = await tx.stockMovement.findFirst({
    where: { referenceType: "order", referenceId: orderId, type: "OUT" },
  });
  if (already) return;
  const items = await orderItems(tx, orderId);
  for (const item of items) {
    if (!item.variantId) continue;
    const updated = await tx.$executeRaw`
      UPDATE "inventory_items"
      SET "onHand" = "onHand" - ${item.quantity}, "updatedAt" = NOW()
      WHERE "variantId" = ${item.variantId} AND ("onHand" - "reserved") >= ${item.quantity}
    `;
    if (Number(updated) !== 1) {
      throw new AppError(
        409,
        "INSUFFICIENT_STOCK",
        reason === HAVALE_STOCK_REASON ? "İstenen adet stokta yok." : "Ödeme alındı ancak stok yetersiz.",
      );
    }
    const inventory = await tx.inventoryItem.findUniqueOrThrow({ where: { variantId: item.variantId } });
    await tx.stockMovement.create({
      data: {
        inventoryItemId: inventory.id,
        type: "OUT",
        quantity: item.quantity,
        reason,
        referenceType: "order",
        referenceId: orderId,
      },
    });
  }
}

export async function restoreStockOnce(tx: Tx, orderId: string, reason: (typeof STOCK_RESTORE_REASONS)[number]) {
  const captured = await tx.stockMovement.findFirst({
    where: { referenceType: "order", referenceId: orderId, type: "OUT" },
  });
  if (!captured) return;
  const already = await tx.stockMovement.findFirst({
    where: { referenceType: "order", referenceId: orderId, type: "IN", reason: { in: [...STOCK_RESTORE_REASONS] } },
  });
  if (already) return;
  const items = await orderItems(tx, orderId);
  for (const item of items) {
    if (!item.variantId) continue;
    const inventory = await tx.inventoryItem.findUnique({ where: { variantId: item.variantId } });
    if (!inventory) continue;
    await tx.inventoryItem.update({
      where: { id: inventory.id },
      data: { onHand: { increment: item.quantity } },
    });
    await tx.stockMovement.create({
      data: {
        inventoryItemId: inventory.id,
        type: "IN",
        quantity: item.quantity,
        reason,
        referenceType: "order",
        referenceId: orderId,
      },
    });
  }
}
