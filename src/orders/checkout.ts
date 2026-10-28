import { randomBytes } from "crypto";
import type { FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../common/errors";
import { parse } from "../common/parse";
import type { Env } from "../config/env";
import { prisma } from "../db";
import { createShippingProvider } from "../providers/commerce";
import {
  iframeUrlForToken,
  isPaytrConfigured,
  merchantOidFromSequence,
  paytrCredentialsFromEnv,
  requestPaytrIframeToken,
  siteOrigin,
  type TokenFetcher,
} from "../providers/paytr";
import { havaleSnapshot, isHavaleReady, readHavaleSettings } from "./havale";
import { isValidTaxNumber, isValidTckn } from "./invoice";
import { captureStockOnce, HAVALE_STOCK_REASON } from "./stock";
import { newOrderAccessToken } from "./thanks";
import { TURKEY_DISTRICTS, isTurkeyCityDistrict } from "./turkey-locations";

export const addressSchema = z.object({
  fullName: z.string().trim().min(3, "Ad soyad en az 3 karakter olmalı.").max(120, "Ad soyad çok uzun."),
  phone: z.string().trim().min(10, "Telefon numarasını kontrol edin.").max(20, "Telefon numarasını kontrol edin."),
  line1: z.string().trim().min(3, "Adres en az 3 karakter olmalı.").max(200, "Adres çok uzun."),
  line2: z.string().trim().max(200, "Adres çok uzun.").optional(),
  district: z.string().trim().min(2, "İlçe girin.").max(80, "İlçe çok uzun."),
  city: z.string().trim().min(2, "İl girin.").max(80, "İl çok uzun."),
  postalCode: z.string().trim().min(4, "Posta kodunu kontrol edin.").max(10, "Posta kodunu kontrol edin."),
  country: z.string().trim().length(2).default("TR"),
});

const invoiceSchema = z.object({
  type: z.enum(["INDIVIDUAL", "CORPORATE"], { errorMap: () => ({ message: "Fatura tipi seçin." }) }),
  personName: z.string().trim().max(120, "Ad soyad çok uzun.").optional(),
  nationalId: z.string().trim().max(11).optional(),
  companyName: z.string().trim().max(160, "Ünvan çok uzun.").optional(),
  taxOffice: z.string().trim().max(80, "Vergi dairesi çok uzun.").optional(),
  taxId: z.string().trim().max(10).optional(),
  eInvoice: z.boolean().optional(),
  sameAsShipping: z.boolean(),
});

export const checkoutBodySchema = z.object({
  email: z.string().trim().email("Geçerli bir e-posta girin."),
  shippingAddress: addressSchema,
  billingAddress: addressSchema.optional(),
  invoice: invoiceSchema,
  customerNote: z.string().trim().max(500).optional(),
  paymentMethod: z.enum(["paytr", "havale"], { errorMap: () => ({ message: "Ödeme yöntemi seçin." }) }),
  termsAccepted: z.literal(true, { errorMap: () => ({ message: "Sözleşmeleri onaylamanız gerekir." }) }),
  saveAddress: z.boolean().optional(),
}).superRefine((value, ctx) => {
  const nationalId = value.invoice.nationalId?.trim() ?? "";
  if (nationalId && !isValidTckn(nationalId)) {
    ctx.addIssue({ code: "custom", path: ["invoice", "nationalId"], message: "TC kimlik numarası geçersiz." });
  }
  if (value.invoice.type === "INDIVIDUAL") {
    if (!value.invoice.sameAsShipping && (!value.invoice.personName || value.invoice.personName.length < 3)) {
      ctx.addIssue({ code: "custom", path: ["invoice", "personName"], message: "Fatura için ad soyad girin." });
    }
  }
  if (value.invoice.type === "CORPORATE") {
    if (!value.invoice.companyName) {
      ctx.addIssue({ code: "custom", path: ["invoice", "companyName"], message: "Firma unvanı girin." });
    }
    if (!value.invoice.taxOffice) {
      ctx.addIssue({ code: "custom", path: ["invoice", "taxOffice"], message: "Vergi dairesi girin." });
    }
    const taxId = value.invoice.taxId?.trim() ?? "";
    if (!taxId) {
      ctx.addIssue({ code: "custom", path: ["invoice", "taxId"], message: "Vergi numarası girin." });
    } else if (!isValidTaxNumber(taxId)) {
      ctx.addIssue({ code: "custom", path: ["invoice", "taxId"], message: "Vergi numarası 10 hane olmalı." });
    }
  }
  if (!value.invoice.sameAsShipping && !value.billingAddress) {
    ctx.addIssue({ code: "custom", path: ["billingAddress"], message: "Fatura adresini girin." });
  }
  function cityDistrict(address: { city: string; district: string }, path: string[]) {
    if (!TURKEY_DISTRICTS[address.city]) {
      ctx.addIssue({ code: "custom", path: [...path, "city"], message: "Geçerli bir il seçin." });
      return;
    }
    if (!isTurkeyCityDistrict(address.city, address.district)) {
      ctx.addIssue({ code: "custom", path: [...path, "district"], message: "İlçe, seçilen ile ait değil." });
    }
  }
  cityDistrict(value.shippingAddress, ["shippingAddress"]);
  if (value.billingAddress) cityDistrict(value.billingAddress, ["billingAddress"]);
});

function billingSnapshot(body: z.infer<typeof checkoutBodySchema>): Prisma.InputJsonValue {
  const address = body.invoice.sameAsShipping ? body.shippingAddress : body.billingAddress!;
  const individual = body.invoice.type === "INDIVIDUAL";
  return {
    ...address,
    invoiceType: body.invoice.type,
    personName: individual
      ? (body.invoice.sameAsShipping ? body.shippingAddress.fullName : (body.invoice.personName ?? "").trim())
      : "",
    nationalId: (body.invoice.nationalId ?? "").trim(),
    companyName: individual ? "" : (body.invoice.companyName ?? "").trim(),
    taxOffice: individual ? "" : (body.invoice.taxOffice ?? "").trim(),
    taxId: individual ? "" : (body.invoice.taxId ?? "").trim(),
    eInvoice: individual ? false : body.invoice.eInvoice === true,
    sameAsShipping: body.invoice.sameAsShipping,
  };
}

type Cart = {
  id: string;
  currency: string;
  items: Array<{
    variantId: string;
    quantity: number;
    variant: {
      name: string;
      sku: string;
      priceAmount: number;
      product: { name: string };
      inventory: { onHand: number; reserved: number } | null;
    };
  }>;
};

export const CHECKOUT_NONE_MESSAGE = "Şu an tamamlanabilir bir ödeme yöntemi yok.";

export async function checkoutPaymentOptions(env: Env) {
  const card = isPaytrConfigured(env);
  const havale = await readHavaleSettings();
  const havaleEnabled = isHavaleReady(havale);
  return {
    card: {
      enabled: card,
      message: card ? "Kart bilgisi DatçaMis sunucularında tutulmaz; ödeme PayTR ekranında alınır." : "Yakında aktif olacak",
    },
    havale: { enabled: havaleEnabled },
    canCheckout: card || havaleEnabled,
    noneMessage: CHECKOUT_NONE_MESSAGE,
  };
}

export function clientIp(request: FastifyRequest) {
  const forwarded = request.headers["x-forwarded-for"];
  const raw = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : "";
  return raw || request.ip || "127.0.0.1";
}

function formatAddress(address: z.infer<typeof addressSchema>) {
  return [address.line1, address.line2, address.district, address.city, address.postalCode].filter(Boolean).join(", ");
}

export async function placePaytrCheckout(options: {
  env: Env;
  cart: Cart;
  body: z.infer<typeof checkoutBodySchema>;
  userIp: string;
  fetchToken?: TokenFetcher;
  customerId?: string | null;
}) {
  const credentials = paytrCredentialsFromEnv(options.env);
  if (!credentials) {
    throw new AppError(409, "PAYMENT_UNAVAILABLE", "Online ödeme yakında aktif olacak.");
  }
  if (options.cart.items.length === 0) throw new AppError(400, "CART_EMPTY", "Sepet boş.");

  const priced = options.cart.items.map((item) => {
    const unitAmount = item.variant.priceAmount;
    return {
      ...item,
      unitAmount,
      lineAmount: unitAmount * item.quantity,
      available: (item.variant.inventory?.onHand ?? 0) - (item.variant.inventory?.reserved ?? 0),
    };
  });
  for (const item of priced) {
    if (item.available < item.quantity) throw new AppError(409, "INSUFFICIENT_STOCK", "İstenen adet stokta yok.");
  }
  const subtotal = priced.reduce((sum, item) => sum + item.lineAmount, 0);
  const shipment = createShippingProvider(options.env).createShipment({ orderNumber: "pending" });
  const origin = siteOrigin(options.env);

  const order = await prisma.$transaction(async (tx) => {
    const sequence = await tx.$queryRaw<Array<{ last: number }>>`
      UPDATE "order_sequences" SET "last" = "last" + 1 WHERE "id" = 1 RETURNING "last"
    `;
    const last = sequence[0]?.last;
    if (!last) throw new AppError(500, "SEQUENCE_MISSING", "Sipariş sırası hazır değil.");
    const number = `DM-${last}`;
    const merchantOid = merchantOidFromSequence(last, randomBytes(6).toString("hex"));
    const created = await tx.order.create({
      data: {
        number,
        customerId: options.customerId ?? null,
        email: options.body.email,
        status: "PENDING",
        currency: options.cart.currency,
        subtotalAmount: subtotal,
        discountAmount: 0,
        shippingAmount: 0,
        taxAmount: 0,
        totalAmount: subtotal,
        shippingAddress: options.body.shippingAddress,
        billingAddress: billingSnapshot(options.body),
        customerNote: options.body.customerNote,
        termsAcceptedAt: new Date(),
        accessToken: newOrderAccessToken(),
        items: {
          create: priced.map((item) => ({
            variantId: item.variantId,
            productName: item.variant.product.name,
            variantName: item.variant.name,
            sku: item.variant.sku,
            quantity: item.quantity,
            unitAmount: item.unitAmount,
            totalAmount: item.lineAmount,
          })),
        },
        payments: {
          create: {
            provider: "paytr",
            status: "PENDING",
            amount: subtotal,
            currency: options.cart.currency,
            providerRef: merchantOid,
            metadata: { testMode: credentials.testMode },
          },
        },
        shipments: {
          create: {
            provider: shipment.provider,
            status: shipment.status,
            metadata: shipment.metadata as Prisma.InputJsonValue,
          },
        },
      },
      include: { items: true, payments: true, shipments: true },
    });
    await tx.cartItem.deleteMany({ where: { cartId: options.cart.id } });
    return created;
  });

  const payment = order.payments[0];
  const shipping = options.body.shippingAddress;
  try {
    const iframeToken = await requestPaytrIframeToken(
      credentials,
      {
        merchantOid: payment.providerRef!,
        email: options.body.email,
        paymentAmount: order.totalAmount,
        userIp: options.userIp,
        userName: shipping.fullName,
        userAddress: formatAddress(shipping),
        userPhone: shipping.phone,
        merchantOkUrl: `${origin}/odeme/basarili`,
        merchantFailUrl: `${origin}/odeme/basarisiz`,
        basket: order.items.map((item) => ({ name: `${item.productName} ${item.variantName}`.trim(), unitPrice: item.unitAmount, quantity: item.quantity })),
        noInstallment: "1",
        maxInstallment: "0",
        currency: "TL",
      },
      options.fetchToken,
    );
    await prisma.payment.update({
      where: { id: payment.id },
      data: { metadata: { testMode: credentials.testMode, iframeRequested: true } },
    });
    return {
      order: { id: order.id, number: order.number, accessToken: order.accessToken, totalAmount: order.totalAmount, status: order.status, paymentStatus: "PENDING" },
      payment: { provider: "paytr", iframeToken, iframeUrl: iframeUrlForToken(iframeToken) },
    };
  } catch (error) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "FAILED", metadata: { tokenError: true } },
    });
    await prisma.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    throw error;
  }
}

export async function placeHavaleCheckout(options: {
  env: Env;
  cart: Cart;
  body: z.infer<typeof checkoutBodySchema>;
  customerId?: string | null;
}) {
  const settings = await readHavaleSettings();
  if (!isHavaleReady(settings)) {
    throw new AppError(409, "PAYMENT_UNAVAILABLE", CHECKOUT_NONE_MESSAGE);
  }
  if (options.cart.items.length === 0) throw new AppError(400, "CART_EMPTY", "Sepet boş.");

  const priced = options.cart.items.map((item) => {
    const unitAmount = item.variant.priceAmount;
    return {
      ...item,
      unitAmount,
      lineAmount: unitAmount * item.quantity,
      available: (item.variant.inventory?.onHand ?? 0) - (item.variant.inventory?.reserved ?? 0),
    };
  });
  for (const item of priced) {
    if (item.available < item.quantity) throw new AppError(409, "INSUFFICIENT_STOCK", "İstenen adet stokta yok.");
  }
  const subtotal = priced.reduce((sum, item) => sum + item.lineAmount, 0);
  const shipment = createShippingProvider(options.env).createShipment({ orderNumber: "pending" });
  const bank = havaleSnapshot(settings);

  const order = await prisma.$transaction(async (tx) => {
    const sequence = await tx.$queryRaw<Array<{ last: number }>>`
      UPDATE "order_sequences" SET "last" = "last" + 1 WHERE "id" = 1 RETURNING "last"
    `;
    const last = sequence[0]?.last;
    if (!last) throw new AppError(500, "SEQUENCE_MISSING", "Sipariş sırası hazır değil.");
    const created = await tx.order.create({
      data: {
        number: `DM-${last}`,
        customerId: options.customerId ?? null,
        email: options.body.email,
        status: "PENDING",
        currency: options.cart.currency,
        subtotalAmount: subtotal,
        discountAmount: 0,
        shippingAmount: 0,
        taxAmount: 0,
        totalAmount: subtotal,
        shippingAddress: options.body.shippingAddress,
        billingAddress: billingSnapshot(options.body),
        customerNote: options.body.customerNote,
        termsAcceptedAt: new Date(),
        accessToken: newOrderAccessToken(),
        items: {
          create: priced.map((item) => ({
            variantId: item.variantId,
            productName: item.variant.product.name,
            variantName: item.variant.name,
            sku: item.variant.sku,
            quantity: item.quantity,
            unitAmount: item.unitAmount,
            totalAmount: item.lineAmount,
          })),
        },
        payments: {
          create: {
            provider: "havale",
            status: "PENDING",
            amount: subtotal,
            currency: options.cart.currency,
            metadata: bank,
          },
        },
        shipments: {
          create: {
            provider: shipment.provider,
            status: shipment.status,
            metadata: shipment.metadata as Prisma.InputJsonValue,
          },
        },
      },
      include: { items: true, payments: true, shipments: true },
    });
    await captureStockOnce(tx, created.id, HAVALE_STOCK_REASON);
    await tx.cartItem.deleteMany({ where: { cartId: options.cart.id } });
    return created;
  });

  return {
    order: { id: order.id, number: order.number, accessToken: order.accessToken, totalAmount: order.totalAmount, status: order.status, paymentStatus: "PENDING" },
    payment: { provider: "havale" as const, ...bank },
  };
}
