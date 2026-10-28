import { randomBytes } from "crypto";
import type { Prisma } from "@prisma/client";
import { notFound } from "../common/errors";
import { prisma } from "../db";

const ACCESS_KEY = /^[A-Za-z0-9_-]{32,64}$/;

export function newOrderAccessToken() {
  return randomBytes(32).toString("base64url");
}

const thanksInclude = {
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
} satisfies Prisma.OrderInclude;

function asAddress(value: Prisma.JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { fullName: "", line1: "", district: "", city: "" };
  }
  const row = value as Record<string, unknown>;
  return {
    fullName: String(row.fullName ?? "").trim(),
    line1: String(row.line1 ?? "").trim(),
    district: String(row.district ?? "").trim(),
    city: String(row.city ?? "").trim(),
  };
}

function itemImage(item: {
  productName: string;
  variant: {
    media: { id: string; alt: string | null; deletedAt: Date | null } | null;
    product: { images: Array<{ media: { id: string; alt: string | null; deletedAt: Date | null } }> };
  } | null;
}) {
  const media = item.variant?.media && !item.variant.media.deletedAt
    ? item.variant.media
    : item.variant?.product.images[0]?.media;
  if (!media || media.deletedAt) return null;
  return { url: `/api/v1/media/${media.id}/file`, alt: media.alt || item.productName };
}

function bankFromMeta(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { bankName: "", accountHolder: "", iban: "" };
  }
  const row = value as Record<string, unknown>;
  return {
    bankName: String(row.bankName ?? "").trim(),
    accountHolder: String(row.accountHolder ?? "").trim(),
    iban: String(row.iban ?? "").replace(/\s+/g, "").toUpperCase(),
  };
}

export async function loadThanksByAccessKey(accessKey: string) {
  if (!ACCESS_KEY.test(accessKey)) throw notFound("Sipariş bulunamadı.");
  const order = await prisma.order.findUnique({
    where: { accessToken: accessKey },
    include: thanksInclude,
  });
  if (!order) throw notFound("Sipariş bulunamadı.");
  const payment = order.payments[0];
  const paid = payment?.status === "PAID";
  const havale = payment?.provider === "havale" && !paid;
  const bank = havale ? bankFromMeta(payment.metadata) : null;
  return {
    number: order.number,
    totalAmount: order.totalAmount,
    paid,
    paymentProvider: payment?.provider === "havale" ? "havale" : payment?.provider === "paytr" ? "paytr" : "other",
    havale: bank && bank.iban ? bank : null,
    shipping: asAddress(order.shippingAddress),
    items: order.items.map((item) => ({
      productName: item.productName,
      variantName: item.variantName,
      quantity: item.quantity,
      lineAmount: item.totalAmount,
      image: itemImage(item),
    })),
  };
}
