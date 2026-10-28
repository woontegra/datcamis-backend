import type { OrderStatus, PaymentStatus, Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireStaff, type StaffSession } from "../auth/staff";
import { AppError, notFound } from "../common/errors";
import { parse } from "../common/parse";
import type { Env } from "../config/env";
import { prisma } from "../db";
import {
  ORDER_STATUS_LABEL,
  ORDER_VIEW_ROLES,
  ORDER_UPDATE_ROLES,
  PAYMENT_STATUS_LABEL,
  allowedOrderTransitions,
  allowedPaymentTransitions,
  assertOrderTransition,
  assertPaymentTransition,
  canUpdateOrders,
  normalizePaymentStatus,
} from "./workflow";
import { restoreStockOnce } from "./stock";

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  q: z.string().trim().max(120).optional(),
  status: z.enum(["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED", "NEW"]).optional(),
  from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const CANCEL_REASONS = ["Müşteri vazgeçti", "Stok yok", "Ödeme alınamadı", "Adres sorunu", "Diğer"] as const;

const patchBody = z.object({
  status: z.enum(["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED"]).optional(),
  paymentStatus: z.enum(["PENDING", "PAID", "REFUNDED"]).optional(),
  carrier: z.string().trim().max(80).optional(),
  trackingNumber: z.string().trim().max(80).optional(),
  staffNote: z.string().trim().max(2000).nullable().optional(),
  customerNote: z.string().trim().max(500).nullable().optional(),
  invoiceIssued: z.boolean().optional(),
  invoiceNumber: z.string().trim().max(80).optional(),
  invoiceDate: z.union([z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]).optional(),
  cancelReason: z.enum(CANCEL_REASONS).optional(),
  cancelNote: z.string().trim().max(500).optional(),
}).refine((value) => Object.values(value).some((item) => item !== undefined), { message: "Güncellenecek alan yok." });

const orderInclude = {
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

function dayStart(iso: string) {
  return new Date(`${iso}T00:00:00.000`);
}

function dayEnd(iso: string) {
  return new Date(`${iso}T23:59:59.999`);
}

function asAddress(value: Prisma.JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { fullName: "", phone: "", line1: "", line2: "", district: "", city: "", postalCode: "", country: "TR" };
  }
  const row = value as Record<string, unknown>;
  return {
    fullName: String(row.fullName ?? ""),
    phone: String(row.phone ?? ""),
    line1: String(row.line1 ?? ""),
    line2: row.line2 ? String(row.line2) : "",
    district: String(row.district ?? ""),
    city: String(row.city ?? ""),
    postalCode: String(row.postalCode ?? ""),
    country: String(row.country ?? "TR"),
  };
}

function paymentMeta(value: Prisma.JsonValue | null | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function serializePayment(payment: { provider: string; status: PaymentStatus; amount: number; currency: string; providerRef: string | null; metadata: Prisma.JsonValue | null; updatedAt: Date }, canUpdate: boolean) {
  const meta = paymentMeta(payment.metadata);
  const failed = payment.status === "FAILED";
  const status = failed ? "FAILED" : normalizePaymentStatus(payment.status);
  return {
    provider: payment.provider,
    providerLabel: payment.provider === "paytr" ? "PayTR" : payment.provider === "havale" ? "Havale/EFT" : payment.provider === "unconfigured" ? "" : payment.provider,
    providerRef: payment.providerRef,
    status,
    statusLabel: PAYMENT_STATUS_LABEL[payment.status],
    allowedStatuses: canUpdate && !failed ? allowedPaymentTransitions(payment.status) : [],
    amount: payment.amount,
    currency: payment.currency,
    markedManually: meta.markedManually === true,
    updatedAt: payment.updatedAt,
  };
}

const SHIPMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: "Gönderilmedi",
  READY: "Gönderilmedi",
  SHIPPED: "Kargoda",
  DELIVERED: "Teslim Edildi",
  CANCELLED: "İptal",
};

function serializeShipment(shipment: { provider: string; status: string; trackingNumber: string | null; updatedAt: Date } | undefined) {
  if (!shipment) return { carrier: "", trackingNumber: "", status: "PENDING", statusLabel: "Gönderilmedi" };
  const carrier = shipment.provider === "unconfigured" ? "" : shipment.provider;
  return {
    carrier,
    trackingNumber: shipment.trackingNumber ?? "",
    status: shipment.status,
    statusLabel: SHIPMENT_STATUS_LABEL[shipment.status] ?? shipment.status,
    updatedAt: shipment.updatedAt,
  };
}

function itemImage(item: Prisma.OrderGetPayload<{ include: typeof orderInclude }>["items"][number]) {
  const media = item.variant?.media && !item.variant.media.deletedAt
    ? item.variant.media
    : item.variant?.product.images[0]?.media;
  if (!media || media.deletedAt) return null;
  return { url: `/api/v1/media/${media.id}/file`, alt: media.alt || item.productName };
}

function itemSummary(items: Array<{ productName: string; variantName: string }>) {
  if (items.length === 0) return "Bilgi yok";
  const first = `${items[0].productName} ${items[0].variantName}`.trim();
  if (items.length === 1) return first;
  return `${first} + ${items.length - 1} ürün daha`;
}

function sameAddress(a: ReturnType<typeof asAddress>, b: ReturnType<typeof asAddress>) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function dateOnly(value: Date | null | undefined) {
  if (!value) return "";
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseInvoiceDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return new Date(`${value}T12:00:00.000Z`);
}

function invoiceInfo(value: Prisma.JsonValue, invoiceNumber: string | null, invoicedAt: Date | null, billingSame: boolean) {
  const number = (invoiceNumber ?? "").trim();
  const date = dateOnly(invoicedAt);
  const empty = {
    collected: false,
    type: "",
    typeLabel: "",
    personName: "",
    nationalId: "",
    companyName: "",
    taxOffice: "",
    taxId: "",
    eInvoice: false,
    sameAsShipping: billingSame,
    issued: Boolean(invoicedAt),
    number,
    date,
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const row = value as Record<string, unknown>;
  const type = row.invoiceType === "INDIVIDUAL" || row.invoiceType === "CORPORATE" ? row.invoiceType : "";
  const companyName = String(row.companyName ?? row.company ?? "").trim();
  const taxOffice = String(row.taxOffice ?? "").trim();
  const taxId = String(row.taxId ?? row.vergiNo ?? "").trim();
  const personName = String(row.personName ?? "").trim() || (type === "INDIVIDUAL" ? String(row.fullName ?? "").trim() : "");
  return {
    collected: Boolean(type),
    type,
    typeLabel: type === "INDIVIDUAL" ? "Bireysel" : type === "CORPORATE" ? "Kurumsal" : "",
    personName,
    nationalId: String(row.nationalId ?? "").trim(),
    companyName,
    taxOffice,
    taxId,
    eInvoice: row.eInvoice === true,
    sameAsShipping: type ? row.sameAsShipping === true : billingSame,
    issued: Boolean(invoicedAt),
    number,
    date,
  };
}

type OrderHistoryRow = { action: string; text: string; actorName: string; actorEmail: string; createdAt: Date };

function serializeHistory(rows: Array<{ action: string; metadata: Prisma.JsonValue | null; createdAt: Date; actor: { name: string; email: string } | null }>): OrderHistoryRow[] {
  return rows.map((row) => {
    const meta = paymentMeta(row.metadata);
    return {
      action: row.action,
      text: typeof meta.text === "string" ? meta.text : row.action,
      actorName: row.actor?.name ?? "Sistem",
      actorEmail: row.actor?.email ?? "",
      createdAt: row.createdAt,
    };
  });
}

function serializeOrder(
  order: Prisma.OrderGetPayload<{ include: typeof orderInclude }>,
  canUpdate: boolean,
  extra: { history?: OrderHistoryRow[]; customerOrderCount?: number | null } = {},
) {
  const payment = order.payments[0];
  const shipment = order.shipments[0];
  const shipping = asAddress(order.shippingAddress);
  const billing = asAddress(order.billingAddress);
  const billingSame = sameAddress(shipping, billing);
  return {
    id: order.id,
    number: order.number,
    email: order.email,
    customerName: shipping.fullName,
    phone: shipping.phone,
    status: order.status,
    statusLabel: ORDER_STATUS_LABEL[order.status],
    allowedStatuses: canUpdate ? allowedOrderTransitions(order.status) : [],
    placedAt: order.placedAt,
    currency: order.currency,
    subtotalAmount: order.subtotalAmount,
    discountAmount: order.discountAmount,
    shippingAmount: order.shippingAmount,
    taxAmount: order.taxAmount,
    totalAmount: order.totalAmount,
    customerNote: order.customerNote,
    staffNote: order.staffNote,
    shippingAddress: shipping,
    billingAddress: billing,
    billingSameAsShipping: billingSame,
    invoice: invoiceInfo(order.billingAddress, order.invoiceNumber, order.invoicedAt, billingSame),
    itemSummary: itemSummary(order.items),
    customerOrderCount: extra.customerOrderCount ?? null,
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.variant?.product?.id ?? null,
      productName: item.productName,
      variantName: item.variantName,
      sku: item.sku,
      quantity: item.quantity,
      unitAmount: item.unitAmount,
      totalAmount: item.totalAmount,
      image: itemImage(item),
    })),
    payment: payment
      ? serializePayment(payment, canUpdate)
      : { provider: "unconfigured", providerLabel: "", providerRef: null, status: "PENDING" as const, statusLabel: PAYMENT_STATUS_LABEL.PENDING, allowedStatuses: canUpdate ? allowedPaymentTransitions("PENDING") : [], amount: order.totalAmount, currency: order.currency, markedManually: false, updatedAt: order.updatedAt },
    shipment: serializeShipment(shipment),
    canUpdate,
    history: extra.history ?? [],
  };
}

async function writeAudit(actor: StaffSession, orderId: string, action: string, text: string, extra?: Record<string, unknown>) {
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action,
      entityType: "order",
      entityId: orderId,
      metadata: { text, ...extra },
    },
  });
}

async function loadOrder(id: string) {
  const order = await prisma.order.findUnique({ where: { id }, include: orderInclude });
  if (!order) throw notFound("Sipariş bulunamadı.");
  return order;
}

function listWhere(query: z.infer<typeof listQuery>): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {};
  if (query.status === "NEW") where.status = { in: ["PENDING", "CONFIRMED"] };
  else if (query.status) where.status = query.status;
  if (query.from || query.to) {
    where.placedAt = {
      ...(query.from ? { gte: dayStart(query.from) } : {}),
      ...(query.to ? { lte: dayEnd(query.to) } : {}),
    };
  }
  const q = query.q?.trim();
  if (q) {
    where.OR = [
      { number: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
      { shippingAddress: { path: ["fullName"], string_contains: q } },
      { shippingAddress: { path: ["phone"], string_contains: q } },
      { billingAddress: { path: ["fullName"], string_contains: q } },
      { billingAddress: { path: ["phone"], string_contains: q } },
    ];
  }
  return where;
}

export function registerOrderAdminRoutes(app: FastifyInstance, env: Env) {
  app.get("/api/v1/admin/orders", async (request) => {
    const staff = await requireStaff(request, env, [...ORDER_VIEW_ROLES]);
    const query = parse(listQuery, request.query);
    const where = listWhere(query);
    const skip = (query.page - 1) * query.pageSize;
    const [total, rows] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: { placedAt: "desc" },
        skip,
        take: query.pageSize,
        include: orderInclude,
      }),
    ]);
    const canUpdate = canUpdateOrders(staff.role);
    const countWhere = listWhere({ ...query, status: undefined });
    const grouped = await prisma.order.groupBy({ by: ["status"], where: countWhere, _count: { _all: true } });
    const byStatus = Object.fromEntries(grouped.map((row) => [row.status, row._count._all])) as Record<string, number>;
    const counts = {
      all: grouped.reduce((sum, row) => sum + row._count._all, 0),
      NEW: (byStatus.PENDING ?? 0) + (byStatus.CONFIRMED ?? 0),
      PROCESSING: byStatus.PROCESSING ?? 0,
      SHIPPED: byStatus.SHIPPED ?? 0,
      DELIVERED: byStatus.DELIVERED ?? 0,
      CANCELLED: byStatus.CANCELLED ?? 0,
      RETURNED: byStatus.RETURNED ?? 0,
    };
    return {
      data: rows.map((row) => serializeOrder(row, canUpdate)),
      meta: { page: query.page, pageSize: query.pageSize, total, canUpdate, counts },
    };
  });

  app.get("/api/v1/admin/orders/:id", async (request) => {
    const staff = await requireStaff(request, env, [...ORDER_VIEW_ROLES]);
    const { id } = parse(z.object({ id: z.string().min(1) }), request.params);
    const order = await loadOrder(id);
    const logs = await prisma.auditLog.findMany({
      where: { entityType: "order", entityId: order.id },
      orderBy: { createdAt: "asc" },
      include: { actor: { select: { name: true, email: true } } },
    });
    const customerOrderCount = await prisma.order.count({ where: { email: order.email, id: { not: order.id } } });
    return { data: serializeOrder(order, canUpdateOrders(staff.role), { history: serializeHistory(logs), customerOrderCount }) };
  });

  app.patch("/api/v1/admin/orders/:id", async (request) => {
    const staff = await requireStaff(request, env, [...ORDER_UPDATE_ROLES]);
    const { id } = parse(z.object({ id: z.string().min(1) }), request.params);
    const body = parse(patchBody, request.body);
    const order = await loadOrder(id);

    if (body.staffNote !== undefined && body.staffNote !== order.staffNote) {
      await prisma.order.update({ where: { id: order.id }, data: { staffNote: body.staffNote } });
      await writeAudit(staff, order.id, "order.note", "Yönetici notu güncellendi.");
    }

    if (body.customerNote !== undefined && body.customerNote !== order.customerNote) {
      await prisma.order.update({ where: { id: order.id }, data: { customerNote: body.customerNote } });
      await writeAudit(staff, order.id, "order.customer_note", "Müşteri notu güncellendi.");
    }

    if (body.carrier !== undefined || body.trackingNumber !== undefined) {
      const shipment = order.shipments[0];
      const carrier = body.carrier !== undefined ? body.carrier : shipment && shipment.provider !== "unconfigured" ? shipment.provider : "";
      const tracking = body.trackingNumber !== undefined ? body.trackingNumber : shipment?.trackingNumber ?? "";
      const data = {
        provider: carrier || shipment?.provider || "unconfigured",
        trackingNumber: tracking || null,
      };
      if (shipment) await prisma.shipment.update({ where: { id: shipment.id }, data });
      else {
        await prisma.shipment.create({
          data: { orderId: order.id, provider: data.provider, status: "PENDING", trackingNumber: data.trackingNumber },
        });
      }
      await writeAudit(staff, order.id, "order.shipment", `Kargo bilgisi güncellendi${carrier ? `: ${carrier}` : ""}${tracking ? ` / ${tracking}` : ""}.`);
    }

    if (body.invoiceIssued !== undefined || body.invoiceNumber !== undefined || body.invoiceDate !== undefined) {
      const issued = body.invoiceIssued ?? Boolean(order.invoicedAt);
      const number = body.invoiceNumber !== undefined ? body.invoiceNumber : (order.invoiceNumber ?? "").trim();
      const date = body.invoiceDate !== undefined ? body.invoiceDate : dateOnly(order.invoicedAt);
      const invoicedAt = issued ? parseInvoiceDate(date) ?? order.invoicedAt ?? new Date() : null;
      const invoiceNumber = issued ? (number || null) : null;
      await prisma.order.update({
        where: { id: order.id },
        data: { invoiceNumber, invoicedAt },
      });
      const savedDate = dateOnly(invoicedAt);
      const summary = issued
        ? `Fatura kesildi${invoiceNumber ? ` · ${invoiceNumber}` : ""}${savedDate ? ` · ${savedDate}` : ""}.`
        : "Fatura bilgisi güncellendi.";
      await writeAudit(staff, order.id, "order.invoice", summary, { invoiceIssued: issued, invoiceNumber: invoiceNumber ?? "", invoiceDate: savedDate });
    }

    if (body.paymentStatus && normalizePaymentStatus(order.payments[0]?.status ?? "PENDING") !== body.paymentStatus) {
      const payment = order.payments[0];
      const current = payment?.status ?? "PENDING";
      assertPaymentTransition(current, body.paymentStatus);
      const meta = { ...paymentMeta(payment?.metadata), markedManually: true, markedAt: new Date().toISOString(), markedById: staff.id };
      if (payment) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: body.paymentStatus, metadata: meta as Prisma.InputJsonValue },
        });
      } else {
        await prisma.payment.create({
          data: {
            orderId: order.id,
            provider: "unconfigured",
            status: body.paymentStatus,
            amount: order.totalAmount,
            currency: order.currency,
            metadata: meta as Prisma.InputJsonValue,
          },
        });
      }
      await writeAudit(staff, order.id, "order.payment", `Ödeme durumu elle ${PAYMENT_STATUS_LABEL[body.paymentStatus]} olarak işaretlendi.`, { markedManually: true });
    }

    if (body.status && body.status !== order.status) {
      if (body.status === "CANCELLED" && !body.cancelReason) {
        throw new AppError(400, "CANCEL_REASON_REQUIRED", "İptal sebebi seçin.");
      }
      assertOrderTransition(order.status, body.status);
      const fresh = await loadOrder(id);
      if (body.status === "SHIPPED") {
        const tracking = fresh.shipments[0]?.trackingNumber?.trim();
        if (!tracking) throw new AppError(400, "TRACKING_REQUIRED", "Kargoya vermek için takip numarası gerekli.");
        const shipment = fresh.shipments[0];
        await prisma.shipment.update({ where: { id: shipment.id }, data: { status: "SHIPPED", trackingNumber: tracking } });
      }
      if (body.status === "DELIVERED" && fresh.shipments[0]) {
        await prisma.shipment.update({ where: { id: fresh.shipments[0].id }, data: { status: "DELIVERED" } });
      }
      if (body.status === "CANCELLED" && fresh.shipments[0] && fresh.shipments[0].status !== "DELIVERED") {
        await prisma.shipment.update({ where: { id: fresh.shipments[0].id }, data: { status: "CANCELLED" } });
      }
      await prisma.order.update({ where: { id: order.id }, data: { status: body.status } });
      if (body.status === "CANCELLED") await prisma.$transaction((tx) => restoreStockOnce(tx, order.id, "order_cancel"));
      if (body.status === "RETURNED") await prisma.$transaction((tx) => restoreStockOnce(tx, order.id, "order_return"));
      const statusText = body.status === "CANCELLED"
        ? `Sipariş iptal edildi. Sebep: ${body.cancelReason}.${body.cancelNote ? ` Açıklama: ${body.cancelNote}` : ""}`
        : `Sipariş durumu ${ORDER_STATUS_LABEL[body.status]} olarak güncellendi.`;
      await writeAudit(staff, order.id, "order.status", statusText, {
        from: order.status,
        to: body.status,
        ...(body.cancelReason ? { cancelReason: body.cancelReason, cancelNote: body.cancelNote ?? "" } : {}),
      });
    }

    const updated = await loadOrder(id);
    const logs = await prisma.auditLog.findMany({
      where: { entityType: "order", entityId: updated.id },
      orderBy: { createdAt: "asc" },
      include: { actor: { select: { name: true, email: true } } },
    });
    const customerOrderCount = await prisma.order.count({ where: { email: updated.email, id: { not: updated.id } } });
    return { data: serializeOrder(updated, true, { history: serializeHistory(logs), customerOrderCount }) };
  });
}
