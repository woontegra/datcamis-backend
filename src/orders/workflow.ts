import type { OrderStatus, PaymentStatus } from "@prisma/client";
import { AppError } from "../common/errors";

export const ORDER_VIEW_ROLES = ["OWNER", "ADMIN", "ORDER_STAFF"] as const;
export const ORDER_UPDATE_ROLES = ["OWNER", "ADMIN", "ORDER_STAFF"] as const;

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: "Yeni",
  CONFIRMED: "Yeni",
  PROCESSING: "Hazırlanıyor",
  SHIPPED: "Kargoya Verildi",
  DELIVERED: "Teslim Edildi",
  CANCELLED: "İptal Edildi",
  RETURNED: "İade Edildi",
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  PENDING: "Ödeme Bekleniyor",
  AUTHORIZED: "Ödeme Bekleniyor",
  FAILED: "Ödeme Başarısız",
  CANCELLED: "Ödeme Bekleniyor",
  PAID: "Ödendi",
  REFUNDED: "İade Edildi",
};

const NEW_STATUSES = new Set<OrderStatus>(["PENDING", "CONFIRMED"]);

export function isNewOrder(status: OrderStatus) {
  return NEW_STATUSES.has(status);
}

export function allowedOrderTransitions(from: OrderStatus): OrderStatus[] {
  if (NEW_STATUSES.has(from)) return ["PROCESSING", "CANCELLED"];
  if (from === "PROCESSING") return ["SHIPPED", "CANCELLED"];
  if (from === "SHIPPED") return ["DELIVERED", "CANCELLED"];
  if (from === "DELIVERED") return ["RETURNED"];
  return [];
}

export function assertOrderTransition(from: OrderStatus, to: OrderStatus) {
  if (from === to) return;
  if (!allowedOrderTransitions(from).includes(to)) {
    throw new AppError(409, "ORDER_STATUS_FORBIDDEN", `${ORDER_STATUS_LABEL[from]} durumundan ${ORDER_STATUS_LABEL[to]} durumuna geçilemez.`);
  }
}

const PAYMENT_SET = new Set<PaymentStatus>(["PENDING", "PAID", "REFUNDED"]);

export function normalizePaymentStatus(status: PaymentStatus): "PENDING" | "PAID" | "REFUNDED" {
  if (status === "PAID" || status === "REFUNDED") return status;
  return "PENDING";
}

export function allowedPaymentTransitions(from: PaymentStatus): Array<"PENDING" | "PAID" | "REFUNDED"> {
  const current = normalizePaymentStatus(from);
  if (current === "PENDING") return ["PAID", "REFUNDED"];
  if (current === "PAID") return ["REFUNDED"];
  return [];
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus) {
  if (!PAYMENT_SET.has(to)) {
    throw new AppError(400, "PAYMENT_STATUS_INVALID", "Bu ödeme durumu kullanılamaz.");
  }
  const next = normalizePaymentStatus(to);
  if (normalizePaymentStatus(from) === next) return;
  if (!allowedPaymentTransitions(from).includes(next)) {
    throw new AppError(409, "PAYMENT_STATUS_FORBIDDEN", `${PAYMENT_STATUS_LABEL[from]} durumundan ${PAYMENT_STATUS_LABEL[to]} durumuna geçilemez.`);
  }
}

export function canUpdateOrders(role: string) {
  return ORDER_UPDATE_ROLES.includes(role as (typeof ORDER_UPDATE_ROLES)[number]);
}
