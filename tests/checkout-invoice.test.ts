import "./helpers/local-database";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { parse } from "../src/common/parse";
import { hashPassword, sha256 } from "../src/common/password";
import { signAccessToken } from "../src/common/tokens";
import { loadEnv, type Env } from "../src/config/env";
import { prisma } from "../src/db";
import { checkoutBodySchema, placePaytrCheckout } from "../src/orders/checkout";
import type { TokenFetcher } from "../src/providers/paytr";

const TEST_PAYTR = {
  merchantId: "000000",
  merchantKey: "test-paytr-merchant-key-not-live",
  merchantSalt: "test-paytr-merchant-salt-not-live",
  testMode: "1" as const,
};

const stamp = Date.now();
const ids = { product: "", inventory: "", variant: "", orders: [] as string[], users: [] as string[] };
const address = {
  fullName: "Ayşe Teslimat",
  phone: "05551112233",
  line1: "Teslimat cad. 1",
  district: "Datça",
  city: "Muğla",
  postalCode: "48900",
  country: "TR",
};
const billingOther = {
  fullName: "Fatura Alıcı",
  phone: "05559998877",
  line1: "Fatura sokak 8",
  district: "Menteşe",
  city: "Muğla",
  postalCode: "48000",
  country: "TR",
};

const fetchToken: TokenFetcher = async () => ({ status: "success", token: "test-iframe-token" });

let app: Awaited<ReturnType<typeof buildApp>>;
let paytrEnv: Env;
let ownerHeader = "";

async function cartWithItem() {
  const created = await app.inject({ method: "POST", url: "/api/v1/carts" });
  const token = created.json().data.token as string;
  await app.inject({
    method: "POST",
    url: "/api/v1/carts/current/items",
    headers: { "x-cart-token": token },
    payload: { variantId: ids.variant, quantity: 1 },
  });
  return token;
}

function checkout(token: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/v1/checkout",
    headers: { "x-cart-token": token },
    payload: withCheckout(payload),
  });
}

function withCheckout(payload: Record<string, unknown>) {
  return { paymentMethod: "paytr", termsAccepted: true, ...payload };
}

async function placeMocked(payload: Record<string, unknown>) {
  const token = await cartWithItem();
  const cart = await prisma.cart.findUniqueOrThrow({
    where: { tokenHash: sha256(token) },
    include: { items: { include: { variant: { include: { product: true, inventory: true } } } } },
  });
  const body = parse(checkoutBodySchema, withCheckout(payload));
  return placePaytrCheckout({ env: paytrEnv, cart, body, userIp: "127.0.0.1", fetchToken });
}

beforeAll(async () => {
  paytrEnv = loadEnv({
    ...process.env,
    PAYTR_MERCHANT_ID: TEST_PAYTR.merchantId,
    PAYTR_MERCHANT_KEY: TEST_PAYTR.merchantKey,
    PAYTR_MERCHANT_SALT: TEST_PAYTR.merchantSalt,
    PAYTR_TEST_MODE: TEST_PAYTR.testMode,
  });
  app = await buildApp(paytrEnv);
  await app.ready();
  const product = await prisma.product.create({
    data: {
      slug: `checkout-invoice-${stamp}`,
      name: "TEST Fatura Kolonyası",
      summary: "Test",
      description: "Test",
      status: "ACTIVE",
      variants: {
        create: {
          sku: `TEST-FATURA-${stamp}`,
          name: "100 ml",
          priceAmount: 12000,
          isDefault: true,
          inventory: { create: { onHand: 40 } },
        },
      },
    },
    include: { variants: { include: { inventory: true } } },
  });
  ids.product = product.id;
  ids.variant = product.variants[0].id;
  ids.inventory = product.variants[0].inventory!.id;
  const user = await prisma.user.create({
    data: {
      email: `checkout-invoice-owner-${stamp}@datcamis.local`,
      passwordHash: await hashPassword("Checkout-Test-12345"),
      name: "Checkout Owner",
      role: "OWNER",
    },
  });
  ids.users.push(user.id);
  const jwt = await signAccessToken(paytrEnv, { sub: user.id, email: user.email, role: user.role });
  ownerHeader = `Bearer ${jwt}`;
});

afterAll(async () => {
  if (ids.orders.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids.orders } } });
    await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
  }
  if (ids.product) {
    const variants = await prisma.productVariant.findMany({ where: { productId: ids.product } });
    if (variants.length) await prisma.cartItem.deleteMany({ where: { variantId: { in: variants.map((row) => row.id) } } });
    await prisma.product.delete({ where: { id: ids.product } });
  }
  if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await app.close();
  await prisma.$disconnect();
});

test("bireysel fatura TC ile kaydedilir", async () => {
  const placed = await placeMocked({
    email: `bireysel-tc-${stamp}@datcamis.local`,
    shippingAddress: address,
    invoice: { type: "INDIVIDUAL", nationalId: "10000000146", sameAsShipping: true },
  });
  expect(placed.payment.iframeToken).toBe("test-iframe-token");
  const order = await prisma.order.findFirstOrThrow({ where: { email: `bireysel-tc-${stamp}@datcamis.local` } });
  ids.orders.push(order.id);
  const billing = order.billingAddress as Record<string, unknown>;
  expect(billing.invoiceType).toBe("INDIVIDUAL");
  expect(billing.personName).toBe("Ayşe Teslimat");
  expect(billing.nationalId).toBe("10000000146");
  expect(billing.sameAsShipping).toBe(true);
  expect(order.invoiceNumber).toBeNull();
  expect(order.invoicedAt).toBeNull();
  const detail = await app.inject({ method: "GET", url: `/api/v1/admin/orders/${order.id}`, headers: { authorization: ownerHeader } });
  expect(detail.statusCode).toBe(200);
  expect(detail.json().data.invoice.collected).toBe(true);
  expect(detail.json().data.invoice.type).toBe("INDIVIDUAL");
  expect(detail.json().data.invoice.nationalId).toBe("10000000146");
  expect(JSON.stringify(detail.json().data.history)).not.toContain("10000000146");
});

test("bireysel fatura TC olmadan kaydedilir", async () => {
  const placed = await placeMocked({
    email: `bireysel-${stamp}@datcamis.local`,
    shippingAddress: address,
    invoice: { type: "INDIVIDUAL", sameAsShipping: true },
  });
  expect(placed.order.status).toBe("PENDING");
  const order = await prisma.order.findFirstOrThrow({ where: { email: `bireysel-${stamp}@datcamis.local` } });
  ids.orders.push(order.id);
  const billing = order.billingAddress as Record<string, unknown>;
  expect(billing.nationalId).toBe("");
  expect(billing.personName).toBe("Ayşe Teslimat");
});

test("kurumsal fatura kaydedilir", async () => {
  const placed = await placeMocked({
    email: `kurumsal-${stamp}@datcamis.local`,
    shippingAddress: address,
    invoice: {
      type: "CORPORATE",
      companyName: "Datça Test Ltd",
      taxOffice: "Datça",
      taxId: "1234567890",
      eInvoice: true,
      sameAsShipping: true,
    },
  });
  expect(placed.payment.provider).toBe("paytr");
  const order = await prisma.order.findFirstOrThrow({ where: { email: `kurumsal-${stamp}@datcamis.local` } });
  ids.orders.push(order.id);
  const billing = order.billingAddress as Record<string, unknown>;
  expect(billing.invoiceType).toBe("CORPORATE");
  expect(billing.companyName).toBe("Datça Test Ltd");
  expect(billing.taxOffice).toBe("Datça");
  expect(billing.taxId).toBe("1234567890");
  expect(billing.eInvoice).toBe(true);
  const detail = await app.inject({ method: "GET", url: `/api/v1/admin/orders/${order.id}`, headers: { authorization: ownerHeader } });
  expect(detail.json().data.invoice.eInvoice).toBe(true);
  expect(JSON.stringify(detail.json().data.history)).not.toContain("1234567890");
});

test("ayrı fatura adresi kaydedilir", async () => {
  await placeMocked({
    email: `ayri-adres-${stamp}@datcamis.local`,
    shippingAddress: address,
    billingAddress: billingOther,
    invoice: { type: "INDIVIDUAL", personName: "Ayrı Adres", sameAsShipping: false },
  });
  const order = await prisma.order.findFirstOrThrow({ where: { email: `ayri-adres-${stamp}@datcamis.local` } });
  ids.orders.push(order.id);
  const billing = order.billingAddress as Record<string, unknown>;
  expect(billing.line1).toBe("Fatura sokak 8");
  expect(billing.sameAsShipping).toBe(false);
  const detail = await app.inject({ method: "GET", url: `/api/v1/admin/orders/${order.id}`, headers: { authorization: ownerHeader } });
  expect(detail.json().data.invoice.sameAsShipping).toBe(false);
  expect(detail.json().data.billingAddress.line1).toBe("Fatura sokak 8");
});

test("hatalı TC reddedilir ve numarayı mesaja yazmaz", async () => {
  const token = await cartWithItem();
  const response = await checkout(token, {
    email: `bad-tc-${stamp}@datcamis.local`,
    shippingAddress: address,
    invoice: { type: "INDIVIDUAL", personName: "Hatalı TC", nationalId: "10000000145", sameAsShipping: true },
  });
  expect(response.statusCode).toBe(400);
  const body = JSON.stringify(response.json());
  expect(body).not.toContain("10000000145");
  expect(response.json().error.details.some((item: { path: string }) => item.path === "invoice.nationalId")).toBe(true);
  const count = await prisma.order.count({ where: { email: `bad-tc-${stamp}@datcamis.local` } });
  expect(count).toBe(0);
});

test("eksik vergi numarası reddedilir", async () => {
  const token = await cartWithItem();
  const response = await checkout(token, {
    email: `no-tax-${stamp}@datcamis.local`,
    shippingAddress: address,
    invoice: { type: "CORPORATE", companyName: "Eksik Vergi", taxOffice: "Datça", sameAsShipping: true },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error.details.some((item: { message: string }) => item.message.includes("Vergi numarası"))).toBe(true);
});

test("9 haneli vergi numarası reddedilir", async () => {
  const token = await cartWithItem();
  const response = await checkout(token, {
    email: `short-tax-${stamp}@datcamis.local`,
    shippingAddress: address,
    invoice: { type: "CORPORATE", companyName: "Kısa Vergi", taxOffice: "Datça", taxId: "123456789", sameAsShipping: true },
  });
  expect(response.statusCode).toBe(400);
  const body = JSON.stringify(response.json());
  expect(body).not.toContain("123456789");
  expect(response.json().error.details.some((item: { path: string }) => item.path === "invoice.taxId")).toBe(true);
});
