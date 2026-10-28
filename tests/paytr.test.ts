import "./helpers/local-database";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { loadEnv } from "../src/config/env";
import { prisma } from "../src/db";
import {
  buildPaytrCallbackHash,
  buildPaytrIframeToken,
  encodePaytrBasket,
  verifyPaytrCallbackHash,
} from "../src/providers/paytr";

const TEST_PAYTR = {
  merchantId: "000000",
  merchantKey: "test-paytr-merchant-key-not-live",
  merchantSalt: "test-paytr-merchant-salt-not-live",
  testMode: "1" as const,
};

const stamp = Date.now();
const ids = { product: "", inventory: "", orders: [] as string[] };
const address = {
  fullName: "PayTR Test",
  phone: "05551112233",
  line1: "Test cad. 1",
  district: "Datça",
  city: "Muğla",
  postalCode: "48900",
  country: "TR",
};

const tokenInput = {
  merchantOid: "DM1001abc",
  email: "musteri@example.com",
  paymentAmount: 5000,
  userIp: "1.1.1.1",
  userName: "PayTR Test",
  userAddress: "Datça",
  userPhone: "05551112233",
  merchantOkUrl: "http://localhost:3010/odeme/basarili",
  merchantFailUrl: "http://localhost:3010/odeme/basarisiz",
  basket: [{ name: "Kolonya 100 ml", unitPrice: 5000, quantity: 1 }],
  noInstallment: "1" as const,
  maxInstallment: "0",
  currency: "TL" as const,
};

let app: Awaited<ReturnType<typeof buildApp>>;
let unconfiguredApp: Awaited<ReturnType<typeof buildApp>>;

function form(fields: Record<string, string>) {
  return new URLSearchParams(fields).toString();
}

async function makePendingOrder(onHand: number, amount: number, oid: string) {
  await prisma.inventoryItem.update({ where: { id: ids.inventory }, data: { onHand } });
  const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: ids.product } });
  const order = await prisma.order.create({
    data: {
      number: `TEST-PAYTR-${stamp}-${oid}`,
      email: "paytr.test@datcamis.local",
      status: "PENDING",
      subtotalAmount: amount,
      totalAmount: amount,
      shippingAddress: address,
      billingAddress: address,
      items: {
        create: {
          variantId: variant.id,
          productName: "PayTR Test Kolonyası",
          variantName: "100 ml",
          sku: `TEST-PAYTR-${stamp}`,
          quantity: 1,
          unitAmount: amount,
          totalAmount: amount,
        },
      },
      payments: {
        create: { provider: "paytr", status: "PENDING", amount, currency: "TRY", providerRef: oid },
      },
    },
  });
  ids.orders.push(order.id);
  return order;
}

beforeAll(async () => {
  const env = loadEnv({
    ...process.env,
    PAYTR_MERCHANT_ID: TEST_PAYTR.merchantId,
    PAYTR_MERCHANT_KEY: TEST_PAYTR.merchantKey,
    PAYTR_MERCHANT_SALT: TEST_PAYTR.merchantSalt,
    PAYTR_TEST_MODE: TEST_PAYTR.testMode,
  });
  app = await buildApp(env);
  await app.ready();
  unconfiguredApp = await buildApp(loadEnv(process.env));
  await unconfiguredApp.ready();
  const product = await prisma.product.create({
    data: {
      slug: `paytr-test-${stamp}`,
      name: "PayTR Test Kolonyası",
      summary: "Test",
      description: "Test",
      status: "ACTIVE",
      variants: {
        create: {
          sku: `TEST-PAYTR-${stamp}`,
          name: "100 ml",
          priceAmount: 5000,
          isDefault: true,
          inventory: { create: { onHand: 5 } },
        },
      },
    },
    include: { variants: { include: { inventory: true } } },
  });
  ids.product = product.id;
  ids.inventory = product.variants[0].inventory!.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: { in: ids.orders } } });
  await prisma.stockMovement.deleteMany({ where: { inventoryItemId: ids.inventory } });
  if (ids.orders.length) await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
  const variants = ids.product ? await prisma.productVariant.findMany({ where: { productId: ids.product } }) : [];
  if (variants.length) {
    await prisma.cartItem.deleteMany({ where: { variantId: { in: variants.map((variant) => variant.id) } } });
  }
  if (ids.product) await prisma.product.delete({ where: { id: ids.product } });
  await app.close();
  await unconfiguredApp.close();
  await prisma.$disconnect();
});

test("PayTR iframe token HMAC-SHA256 hesabı sabittir", () => {
  const token = buildPaytrIframeToken(TEST_PAYTR, tokenInput);
  const again = buildPaytrIframeToken(TEST_PAYTR, tokenInput);
  expect(token).toBe(again);
  expect(token.length).toBeGreaterThan(20);
  expect(encodePaytrBasket(tokenInput.basket)).toBe(Buffer.from(JSON.stringify([["Kolonya 100 ml", "50.00", 1]])).toString("base64"));
});

test("callback hash doğrulanır, sahte imza reddedilir", () => {
  const hash = buildPaytrCallbackHash(TEST_PAYTR, "DM1001abc", "success", "5000");
  expect(verifyPaytrCallbackHash(TEST_PAYTR, { merchant_oid: "DM1001abc", status: "success", total_amount: "5000", hash })).toBe(true);
  expect(verifyPaytrCallbackHash(TEST_PAYTR, { merchant_oid: "DM1001abc", status: "success", total_amount: "5000", hash: "tamper" })).toBe(false);
});

test("anahtarlar yokken ödemesiz sipariş oluşmaz", async () => {
  const created = await unconfiguredApp.inject({ method: "POST", url: "/api/v1/carts" });
  const token = created.json().data.token as string;
  const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: ids.product } });
  await unconfiguredApp.inject({
    method: "POST",
    url: "/api/v1/carts/current/items",
    headers: { "x-cart-token": token },
    payload: { variantId: variant.id, quantity: 1 },
  });
  const checkout = await unconfiguredApp.inject({
    method: "POST",
    url: "/api/v1/checkout",
    headers: { "x-cart-token": token },
    payload: {
      email: "paytr.none@datcamis.local",
      shippingAddress: address,
      invoice: { type: "INDIVIDUAL", personName: "PayTR Test", sameAsShipping: true },
      paymentMethod: "paytr",
      termsAccepted: true,
    },
  });
  expect(checkout.statusCode).toBe(409);
  expect(checkout.json().error.code).toBe("PAYMENT_UNAVAILABLE");
  const count = await prisma.order.count({ where: { email: "paytr.none@datcamis.local" } });
  expect(count).toBe(0);
});

test("sahte imzalı callback reddedilir", async () => {
  const order = await makePendingOrder(5, 5000, `OIDFAKE${stamp}`);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/payments/paytr/callback",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: form({ merchant_oid: `OIDFAKE${stamp}`, status: "success", total_amount: "5000", hash: "not-a-real-hash" }),
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error.code).toBe("PAYTR_HASH_INVALID");
  const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
  expect(payment.status).toBe("PENDING");
});

test("tutar uyuşmazlığı reddedilir", async () => {
  const oid = `OIDAMT${stamp}`;
  await makePendingOrder(5, 5000, oid);
  const hash = buildPaytrCallbackHash(TEST_PAYTR, oid, "success", "9999");
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/payments/paytr/callback",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: form({ merchant_oid: oid, status: "success", total_amount: "9999", hash }),
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error.code).toBe("PAYTR_AMOUNT_MISMATCH");
});

test("aynı başarılı callback stoku bir kez düşürür", async () => {
  const oid = `OIDOK${stamp}`;
  await makePendingOrder(5, 5000, oid);
  const hash = buildPaytrCallbackHash(TEST_PAYTR, oid, "success", "5000");
  const payload = form({ merchant_oid: oid, status: "success", total_amount: "5000", hash });
  const first = await app.inject({
    method: "POST",
    url: "/api/v1/payments/paytr/callback",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload,
  });
  expect(first.statusCode).toBe(200);
  expect(first.body).toBe("OK");
  const second = await app.inject({
    method: "POST",
    url: "/api/v1/payments/paytr/callback",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload,
  });
  expect(second.body).toBe("OK");
  const inventory = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ids.inventory } });
  expect(inventory.onHand).toBe(4);
  const outs = await prisma.stockMovement.count({ where: { inventoryItemId: ids.inventory, type: "OUT", reason: "paytr_paid" } });
  expect(outs).toBe(1);
});

test("başarısız ödemede stok değişmez", async () => {
  const oid = `OIDFAIL${stamp}`;
  await prisma.inventoryItem.update({ where: { id: ids.inventory }, data: { onHand: 4 } });
  const order = await makePendingOrder(4, 5000, oid);
  const hash = buildPaytrCallbackHash(TEST_PAYTR, oid, "failed", "5000");
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/payments/paytr/callback",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: form({ merchant_oid: oid, status: "failed", total_amount: "5000", hash, failed_reason_msg: "test fail" }),
  });
  expect(response.body).toBe("OK");
  const inventory = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ids.inventory } });
  expect(inventory.onHand).toBe(4);
  const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
  expect(payment.status).toBe("FAILED");
  const cancelled = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(cancelled.status).toBe("CANCELLED");
});
