import type { OrderStatus, Prisma } from "@prisma/client";
import { bankFromMeta } from "../orders/thanks";

export const customerOrderInclude = {
  items: {
    include: {
      variant: {
        include: {
          media: true,
          product: {
            include: {
              images: { orderBy: { sortOrder: "asc" as const }, take: 1, include: { media: true } },
            },
          },
        },
      },
    },
  },
  payments: { orderBy: { createdAt: "asc" as const } },
  shipments: { orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof customerOrderInclude }>;

const PROGRESS: OrderStatus[] = ["PROCESSING", "SHIPPED", "DELIVERED"];

function jsonRecord(value: Prisma.JsonValue | null | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function address(value: Prisma.JsonValue) {
  const row = jsonRecord(value);
  return {
    fullName: text(row.fullName),
    phone: text(row.phone),
    line1: text(row.line1),
    line2: text(row.line2),
    district: text(row.district),
    city: text(row.city),
    postalCode: text(row.postalCode),
  };
}

function maskNationalId(value: string) {
  if (value.length !== 11) return "";
  return `${value.slice(0, 2)}*******${value.slice(-2)}`;
}

function invoice(value: Prisma.JsonValue) {
  const row = jsonRecord(value);
  const type = row.invoiceType === "CORPORATE" ? "CORPORATE" : "INDIVIDUAL";
  return {
    type,
    typeLabel: type === "CORPORATE" ? "Kurumsal" : "Bireysel",
    personName: text(row.personName) || text(row.fullName),
    companyName: type === "CORPORATE" ? text(row.companyName) : "",
    taxOffice: type === "CORPORATE" ? text(row.taxOffice) : "",
    taxId: type === "CORPORATE" ? text(row.taxId) : "",
    nationalId: maskNationalId(text(row.nationalId)),
    sameAsShipping: row.sameAsShipping === true,
    address: address(value),
  };
}

function itemImage(item: OrderRow["items"][number]) {
  const media = item.variant?.media && !item.variant.media.deletedAt
    ? item.variant.media
    : item.variant?.product.images[0]?.media;
  if (!media || media.deletedAt) return null;
  return { url: `/api/v1/media/${media.id}/file`, alt: media.alt || item.productName };
}

function paymentInfo(order: OrderRow) {
  const payment = order.payments[0];
  const provider = payment?.provider === "havale" ? "havale" : payment?.provider === "paytr" ? "paytr" : "other";
  const paid = payment?.status === "PAID";
  const refunded = payment?.status === "REFUNDED";
  const closed = order.status === "CANCELLED" || order.status === "RETURNED";
  return { provider, paid, refunded, awaitingHavale: provider === "havale" && !paid && !refunded && !closed };
}

function shipmentInfo(order: OrderRow) {
  const shipment = order.shipments[0];
  const shipped = order.status === "SHIPPED" || order.status === "DELIVERED";
  const carrier = shipment && shipment.provider !== "unconfigured" ? shipment.provider : "";
  return {
    carrier: shipped ? carrier : "",
    trackingNumber: shipped ? shipment?.trackingNumber ?? "" : "",
    inTransit: order.status === "SHIPPED",
  };
}

function badge(order: OrderRow) {
  const payment = paymentInfo(order);
  switch (order.status) {
    case "CANCELLED": return { key: "cancelled", label: "İptal edildi" };
    case "RETURNED": return { key: "returned", label: "İade edildi" };
    case "DELIVERED": return { key: "delivered", label: "Teslim edildi" };
    case "SHIPPED": return { key: "shipped", label: "Kargoda" };
    case "PROCESSING": return { key: "processing", label: "Hazırlanıyor" };
    default:
      return payment.paid ? { key: "paid", label: "Ödeme onaylandı" } : { key: "awaiting", label: "Ödeme bekleniyor" };
  }
}

function timeline(order: OrderRow) {
  const payment = paymentInfo(order);
  const reached = (status: OrderStatus) => PROGRESS.indexOf(order.status) >= PROGRESS.indexOf(status) && PROGRESS.includes(order.status);
  const returned = order.status === "RETURNED";
  const steps = [
    { key: "placed", label: "Sipariş alındı", done: true, at: order.placedAt as Date | null },
    { key: "paid", label: "Ödeme onaylandı", done: payment.paid || payment.refunded || returned || reached("PROCESSING"), at: null },
    { key: "processing", label: "Hazırlanıyor", done: returned || reached("PROCESSING"), at: null },
    { key: "shipped", label: "Kargoya verildi", done: returned || reached("SHIPPED"), at: null },
    { key: "delivered", label: "Teslim edildi", done: returned || reached("DELIVERED"), at: null },
  ];
  if (order.status === "CANCELLED") {
    return [...steps.filter((step) => step.done), { key: "cancelled", label: "İptal edildi", done: true, at: null }];
  }
  if (returned) return [...steps, { key: "returned", label: "İade edildi", done: true, at: null }];
  return steps;
}

export function serializeCustomerOrderSummary(order: OrderRow) {
  return {
    id: order.id,
    number: order.number,
    placedAt: order.placedAt,
    status: badge(order),
    itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
    totalAmount: order.totalAmount,
    currency: order.currency,
    images: order.items.slice(0, 4).map((item) => itemImage(item)),
    awaitingHavale: paymentInfo(order).awaitingHavale,
    shipment: shipmentInfo(order),
  };
}

export function serializeCustomerOrderDetail(order: OrderRow) {
  const payment = paymentInfo(order);
  const bank = payment.awaitingHavale ? bankFromMeta(order.payments[0]?.metadata ?? null) : null;
  return {
    ...serializeCustomerOrderSummary(order),
    timeline: timeline(order),
    paymentMethod: payment.provider === "havale" ? "Havale / EFT" : payment.provider === "paytr" ? "Kredi / banka kartı" : "",
    subtotalAmount: order.subtotalAmount,
    discountAmount: order.discountAmount,
    shippingAmount: order.shippingAmount,
    items: order.items.map((item) => ({
      id: item.id,
      productName: item.productName,
      variantName: item.variantName,
      quantity: item.quantity,
      unitAmount: item.unitAmount,
      totalAmount: item.totalAmount,
      image: itemImage(item),
    })),
    shippingAddress: address(order.shippingAddress),
    invoice: invoice(order.billingAddress),
    havale: bank && bank.iban ? bank : null,
  };
}
