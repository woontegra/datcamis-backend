import "./helpers/local-database";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/common/password";
import { signAccessToken } from "../src/common/tokens";
import { loadEnv } from "../src/config/env";
import { prisma } from "../src/db";
import { HAVALE_SETTING_KEY } from "../src/orders/havale";
import { isValidTrIban } from "../src/orders/iban";
import { HAVALE_STOCK_REASON, STOCK_CAPTURE_REASON, restoreStockOnce } from "../src/orders/stock";

const stamp = Date.now();
const VALID_IBAN = "TR330006100519786457841326";
const ids = { product: "", inventory: "", variant: "", orders: [] as string[], users: [] as string[] };
const address = {
  fullName: "Havale Test",
  phone: "05551112233",
  line1: "Teslimat cad. 1",
  district: "Datça",
  city: "Muğla",
  postalCode: "48900",
  country: "TR",
};

const env = loadEnv();
let app: Awaited<ReturnType<typeof buildApp>>;
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

function checkoutBody(extra: Record<string, unknown> = {}) {
  return {
    email: `havale-${stamp}@datcamis.local`,
    shippingAddress: address,
    invoice: { type: "INDIVIDUAL", personName: "Havale Test", sameAsShipping: true },
    paymentMethod: "havale",
    termsAccepted: true,
    ...extra,
  };
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  const product = await prisma.product.create({
    data: {
      slug: `havale-test-${stamp}`,
      name: "TEST Havale Kolonyası",
      summary: "Test",
      description: "Test",
      status: "ACTIVE",
      variants: {
        create: {
          sku: `TEST-HAVALE-${stamp}`,
          name: "100 ml",
          priceAmount: 15000,
          isDefault: true,
          inventory: { create: { onHand: 8 } },
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
      email: `havale-owner-${stamp}@datcamis.local`,
      passwordHash: await hashPassword("Havale-Test-12345"),
      name: "Havale Owner",
      role: "OWNER",
    },
  });
  ids.users.push(user.id);
  ownerHeader = `Bearer ${await signAccessToken(env, { sub: user.id, email: user.email, role: user.role })}`;
  await prisma.siteSetting.upsert({
    where: { key: HAVALE_SETTING_KEY },
    update: {
      value: { enabled: true, bankName: "Ziraat Bankası", accountHolder: "DatçaMis Test", iban: VALID_IBAN, note: "Açıklamaya sipariş no yazın." },
    },
    create: {
      key: HAVALE_SETTING_KEY,
      value: { enabled: true, bankName: "Ziraat Bankası", accountHolder: "DatçaMis Test", iban: VALID_IBAN, note: "Açıklamaya sipariş no yazın." },
    },
  });
});

afterAll(async () => {
  await prisma.siteSetting.deleteMany({ where: { key: HAVALE_SETTING_KEY } });
  if (ids.orders.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids.orders } } });
    await prisma.stockMovement.deleteMany({ where: { referenceId: { in: ids.orders } } });
    await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
  }
  if (ids.inventory) await prisma.stockMovement.deleteMany({ where: { inventoryItemId: ids.inventory } });
  if (ids.product) {
    const variants = await prisma.productVariant.findMany({ where: { productId: ids.product } });
    if (variants.length) await prisma.cartItem.deleteMany({ where: { variantId: { in: variants.map((row) => row.id) } } });
    await prisma.product.delete({ where: { id: ids.product } });
  }
  if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await app.close();
  await prisma.$disconnect();
});

test("TR IBAN biçimi ve kontrol hanesi doğrulanır", () => {
  expect(isValidTrIban(VALID_IBAN)).toBe(true);
  expect(isValidTrIban("TR330006100519786457841327")).toBe(false);
  expect(isValidTrIban("TR33000610051978645784132")).toBe(false);
});

test("sözleşme onayı olmadan sipariş oluşmaz", async () => {
  const token = await cartWithItem();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/checkout",
    headers: { "x-cart-token": token },
    payload: checkoutBody({ termsAccepted: false, email: `no-terms-${stamp}@datcamis.local` }),
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error.details.some((item: { path: string }) => item.path === "termsAccepted")).toBe(true);
  expect(await prisma.order.count({ where: { email: `no-terms-${stamp}@datcamis.local` } })).toBe(0);
});

test("havale siparişi oluşturur ve stoku bir kez düşer", async () => {
  const before = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ids.inventory } })).onHand;
  const token = await cartWithItem();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/checkout",
    headers: { "x-cart-token": token },
    payload: checkoutBody(),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().data.payment.provider).toBe("havale");
  expect(response.json().data.payment.iban).toBe(VALID_IBAN);
  const order = await prisma.order.findFirstOrThrow({ where: { email: `havale-${stamp}@datcamis.local` } });
  ids.orders.push(order.id);
  expect(order.status).toBe("PENDING");
  expect(order.termsAcceptedAt).toBeTruthy();
  const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
  expect(payment.provider).toBe("havale");
  expect(payment.status).toBe("PENDING");
  const after = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ids.inventory } })).onHand;
  expect(after).toBe(before - 1);
  const outs = await prisma.stockMovement.count({ where: { referenceId: order.id, type: "OUT", reason: HAVALE_STOCK_REASON } });
  expect(outs).toBe(1);
  const paytrOut = await prisma.stockMovement.count({ where: { referenceId: order.id, reason: STOCK_CAPTURE_REASON } });
  expect(paytrOut).toBe(0);
  const detail = await app.inject({ method: "GET", url: `/api/v1/admin/orders/${order.id}`, headers: { authorization: ownerHeader } });
  expect(detail.json().data.payment.providerLabel).toBe("Havale/EFT");
  expect(JSON.stringify(detail.json().data.history)).not.toContain(VALID_IBAN);
});

test("havale iptalinde stok bir kez geri gelir", async () => {
  const token = await cartWithItem();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/checkout",
    headers: { "x-cart-token": token },
    payload: checkoutBody({ email: `havale-iptal-${stamp}@datcamis.local` }),
  });
  expect(response.statusCode).toBe(200);
  const order = await prisma.order.findFirstOrThrow({ where: { email: `havale-iptal-${stamp}@datcamis.local` } });
  ids.orders.push(order.id);
  const afterPlace = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ids.inventory } })).onHand;
  const cancel = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/orders/${order.id}`,
    headers: { authorization: ownerHeader },
    payload: { status: "CANCELLED", cancelReason: "Müşteri vazgeçti" },
  });
  expect(cancel.statusCode).toBe(200);
  const afterCancel = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ids.inventory } })).onHand;
  expect(afterCancel).toBe(afterPlace + 1);
  await prisma.$transaction((tx) => restoreStockOnce(tx, order.id, "order_cancel"));
  expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ids.inventory } })).onHand).toBe(afterCancel);
  expect(await prisma.stockMovement.count({ where: { referenceId: order.id, type: "IN" } })).toBe(1);
});

test("hatalı IBAN kaydı reddedilir", async () => {
  const response = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/settings/havale",
    headers: { authorization: ownerHeader },
    payload: { enabled: true, bankName: "Ziraat", accountHolder: "DatçaMis", iban: "TR330006100519786457841327", note: "" },
  });
  expect(response.statusCode).toBe(400);
  const body = JSON.stringify(response.json());
  expect(body).not.toContain("TR330006100519786457841327");
});

test("kartlı ödeme anahtar yokken hâlâ sipariş oluşturmaz", async () => {
  const token = await cartWithItem();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/checkout",
    headers: { "x-cart-token": token },
    payload: checkoutBody({ paymentMethod: "paytr", email: `kart-kapali-${stamp}@datcamis.local` }),
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().error.code).toBe("PAYMENT_UNAVAILABLE");
  expect(await prisma.order.count({ where: { email: `kart-kapali-${stamp}@datcamis.local` } })).toBe(0);
});
