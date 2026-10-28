import "./helpers/local-database";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/common/password";
import { signAccessToken } from "../src/common/tokens";
import { loadEnv } from "../src/config/env";
import { prisma } from "../src/db";
import { placePaytrCheckout } from "../src/orders/checkout";
import { HAVALE_SETTING_KEY } from "../src/orders/havale";
import { quoteShipping } from "../src/settings/pricing";
import { SECTION_KEYS } from "../src/settings/store-settings";

const stamp = Date.now();
const VALID_IBAN = "TR330006100519786457841326";
const PRICE = 25000;
const SETTING_KEYS = [...SECTION_KEYS, HAVALE_SETTING_KEY, "storeName", "pricingNotice", "contactEmail"];
const ids = { product: "", inventory: "", variant: "", orders: [] as string[], users: [] as string[], carts: [] as string[] };
const auth: Record<"owner" | "admin" | "editor" | "orders", string> = { owner: "", admin: "", editor: "", orders: "" };
const address = {
  fullName: "Ayar Test",
  phone: "05551112233",
  line1: "Test cad. 1",
  district: "Datça",
  city: "Muğla",
  postalCode: "48900",
  country: "TR",
};

const env = loadEnv();
const paytrEnv = loadEnv({
  ...process.env,
  PAYTR_MERCHANT_ID: "000000",
  PAYTR_MERCHANT_KEY: "test-paytr-merchant-key-not-live",
  PAYTR_MERCHANT_SALT: "test-paytr-merchant-salt-not-live",
  PAYTR_TEST_MODE: "1",
});
let app: Awaited<ReturnType<typeof buildApp>>;
let snapshot: Array<{ key: string; value: Prisma.JsonValue }> = [];

const SHIPPING = { flatFee: 7500, freeShippingEnabled: true, freeShippingThreshold: 75000, defaultCarrier: "Aras Kargo", dispatchTime: "1-2 iş günü" };

async function putSettings(body: Record<string, unknown>, header = auth.owner) {
  return app.inject({ method: "PUT", url: "/api/v1/admin/settings", headers: { authorization: header }, payload: body });
}

async function cart(quantity: number, headers: Record<string, string> = {}) {
  const created = await app.inject({ method: "POST", url: "/api/v1/carts", headers });
  const token = created.json().data.token as string;
  ids.carts.push(created.json().data.id);
  const added = await app.inject({
    method: "POST",
    url: "/api/v1/carts/current/items",
    headers: { ...headers, "x-cart-token": token },
    payload: { variantId: ids.variant, quantity },
  });
  return { token, data: added.json().data };
}

function checkoutBody(emailTag: string, paymentMethod = "havale") {
  return {
    email: `ayar-${emailTag}-${stamp}@datcamis.local`,
    shippingAddress: address,
    invoice: { type: "INDIVIDUAL", sameAsShipping: true },
    paymentMethod,
    termsAccepted: true,
  };
}

async function staffHeader(role: "OWNER" | "ADMIN" | "EDITOR" | "ORDER_STAFF") {
  const user = await prisma.user.create({
    data: {
      email: `ayar-${role.toLowerCase()}-${stamp}@datcamis.local`,
      passwordHash: await hashPassword("Ayar-Test-12345"),
      name: `TEST ${role}`,
      role,
    },
  });
  ids.users.push(user.id);
  return `Bearer ${await signAccessToken(env, { sub: user.id, email: user.email, role: user.role })}`;
}

beforeAll(async () => {
  snapshot = (await prisma.siteSetting.findMany({ where: { key: { in: SETTING_KEYS } } })).map((row) => ({ key: row.key, value: row.value }));
  app = await buildApp(env);
  await app.ready();
  const product = await prisma.product.create({
    data: {
      slug: `ayar-test-${stamp}`,
      name: "TEST Ayar Kolonyası",
      vatRate: 10,
      summary: "Test",
      description: "Test",
      status: "ACTIVE",
      variants: { create: { sku: `TEST-AYAR-${stamp}`, name: "250 ml", priceAmount: PRICE, isDefault: true, inventory: { create: { onHand: 50 } } } },
    },
    include: { variants: { include: { inventory: true } } },
  });
  ids.product = product.id;
  ids.variant = product.variants[0].id;
  ids.inventory = product.variants[0].inventory!.id;
  auth.owner = await staffHeader("OWNER");
  auth.admin = await staffHeader("ADMIN");
  auth.editor = await staffHeader("EDITOR");
  auth.orders = await staffHeader("ORDER_STAFF");
  const saved = await putSettings({
    shipping: SHIPPING,
    payment: { minOrderAmount: null },
    order: { numberPrefix: "TST-", havalePaymentDays: 3 },
    maintenance: { enabled: false },
    havale: { enabled: true, bankName: "Ziraat Bankası", accountHolder: "TEST Hesap", iban: VALID_IBAN, note: "" },
  });
  expect(saved.statusCode).toBe(200);
});

afterAll(async () => {
  await prisma.siteSetting.deleteMany({ where: { key: { in: SETTING_KEYS } } });
  for (const row of snapshot) {
    await prisma.siteSetting.create({ data: { key: row.key, value: row.value as Prisma.InputJsonValue } });
  }
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids.users } } });
  if (ids.orders.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids.orders } } });
    await prisma.stockMovement.deleteMany({ where: { referenceId: { in: ids.orders } } });
    await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
  }
  if (ids.inventory) await prisma.stockMovement.deleteMany({ where: { inventoryItemId: ids.inventory } });
  if (ids.variant) await prisma.cartItem.deleteMany({ where: { variantId: ids.variant } });
  if (ids.carts.length) {
    await prisma.cartItem.deleteMany({ where: { cartId: { in: ids.carts } } });
    await prisma.cart.deleteMany({ where: { id: { in: ids.carts } } });
  }
  if (ids.product) await prisma.product.delete({ where: { id: ids.product } });
  if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await app.close();
  await prisma.$disconnect();
});

test("kargo hesabı: sınırın altı, tam sınır, üstü ve sınır kapalı", () => {
  expect(quoteShipping(74999, SHIPPING)).toMatchObject({ shippingAmount: 7500, freeShippingRemaining: 1 });
  expect(quoteShipping(75000, SHIPPING)).toMatchObject({ shippingAmount: 0, freeShippingRemaining: 0 });
  expect(quoteShipping(90000, SHIPPING)).toMatchObject({ shippingAmount: 0 });
  const off = { ...SHIPPING, freeShippingEnabled: false };
  expect(quoteShipping(90000, off)).toMatchObject({ shippingAmount: 7500, freeShippingRemaining: null, freeShippingThreshold: null });
  expect(quoteShipping(0, SHIPPING).shippingAmount).toBe(0);
});

test("sepet kargoyu backend'de hesaplar ve kalan tutarı söyler", async () => {
  const below = await cart(1);
  expect(below.data).toMatchObject({ subtotalAmount: PRICE, shippingAmount: 7500, totalAmount: PRICE + 7500, freeShippingRemaining: 75000 - PRICE });
  const exact = await cart(3);
  expect(exact.data).toMatchObject({ subtotalAmount: 75000, shippingAmount: 0, totalAmount: 75000, freeShippingRemaining: 0 });
  const above = await cart(4);
  expect(above.data).toMatchObject({ shippingAmount: 0, totalAmount: 100000 });
  expect((await putSettings({ shipping: { ...SHIPPING, freeShippingEnabled: false } })).statusCode).toBe(200);
  const disabled = await app.inject({ method: "GET", url: "/api/v1/carts/current", headers: { "x-cart-token": above.token } });
  expect(disabled.json().data).toMatchObject({ shippingAmount: 7500, totalAmount: 107500, freeShippingRemaining: null });
  expect((await putSettings({ shipping: SHIPPING })).statusCode).toBe(200);
});

test("havale tutarına kargo eklenir, önek ve ödeme süresi siparişe yazılır", async () => {
  const { token } = await cart(1);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/checkout",
    headers: { "x-cart-token": token },
    payload: { ...checkoutBody("havale"), shippingAmount: 0, totalAmount: 1 },
  });
  expect(response.statusCode).toBe(200);
  const order = await prisma.order.findFirstOrThrow({ where: { email: `ayar-havale-${stamp}@datcamis.local` }, include: { payments: true } });
  ids.orders.push(order.id);
  expect(order.number.startsWith("TST-")).toBe(true);
  expect(order.shippingAmount).toBe(7500);
  expect(order.totalAmount).toBe(PRICE + 7500);
  expect(order.payments[0].amount).toBe(PRICE + 7500);
  expect(order.taxAmount).toBe(Math.round((PRICE * 10) / 110) + Math.round((7500 * 20) / 120));
  const thanks = await app.inject({ method: "GET", url: `/api/v1/checkout/thanks/${order.accessToken}` });
  expect(thanks.json().data).toMatchObject({ shippingAmount: 7500, totalAmount: PRICE + 7500, havale: { paymentDueDays: 3 } });

  expect((await putSettings({ shipping: { ...SHIPPING, flatFee: 9900 }, order: { numberPrefix: "YENI-", havalePaymentDays: 7 } })).statusCode).toBe(200);
  const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
  expect(after.number).toBe(order.number);
  expect(after.shippingAmount).toBe(7500);
  expect(after.totalAmount).toBe(PRICE + 7500);
  expect(after.payments[0].amount).toBe(PRICE + 7500);
  const thanksAfter = await app.inject({ method: "GET", url: `/api/v1/checkout/thanks/${order.accessToken}` });
  expect(thanksAfter.json().data.havale.paymentDueDays).toBe(3);
  expect((await putSettings({ shipping: SHIPPING, order: { numberPrefix: "TST-", havalePaymentDays: 3 } })).statusCode).toBe(200);
});

test("PayTR'ye giden tutar ve sepet kargoyu içerir", async () => {
  const { token } = await cart(1);
  const row = await prisma.cart.findFirstOrThrow({
    where: { id: ids.carts[ids.carts.length - 1] },
    include: { items: { include: { variant: { include: { inventory: true, product: true } } } } },
  });
  expect(token).toBeTruthy();
  let sent: URLSearchParams | null = null;
  const result = await placePaytrCheckout({
    env: paytrEnv,
    cart: row,
    body: { ...checkoutBody("kart", "paytr"), paymentMethod: "paytr", termsAccepted: true, invoice: { type: "INDIVIDUAL", sameAsShipping: true } },
    userIp: "127.0.0.1",
    fetchToken: async (_url, body) => {
      sent = body;
      return { status: "success", token: "test-token" };
    },
  });
  ids.orders.push(result.order.id);
  expect(result.order.totalAmount).toBe(PRICE + 7500);
  const form = sent as URLSearchParams | null;
  expect(form?.get("payment_amount")).toBe(String(PRICE + 7500));
  const basket = JSON.parse(Buffer.from(form?.get("user_basket") ?? "", "base64").toString("utf8")) as Array<[string, string, number]>;
  expect(basket).toContainEqual(["Kargo", "75.00", 1]);
  const basketTotal = basket.reduce((sum, [, price, qty]) => sum + Math.round(Number(price) * 100) * qty, 0);
  expect(basketTotal).toBe(PRICE + 7500);
  const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: result.order.id } });
  expect(payment.amount).toBe(PRICE + 7500);
});

test("en düşük sipariş tutarının altında sipariş engellenir", async () => {
  expect((await putSettings({ payment: { minOrderAmount: 50000 } })).statusCode).toBe(200);
  const { token, data } = await cart(1);
  expect(data.minOrderShortfall).toBe(50000 - PRICE);
  expect(data.minOrderMessage).toContain("500,00 TL");
  const response = await app.inject({ method: "POST", url: "/api/v1/checkout", headers: { "x-cart-token": token }, payload: checkoutBody("min") });
  expect(response.statusCode).toBe(400);
  expect(response.json().error.code).toBe("MIN_ORDER_AMOUNT");
  expect(response.json().error.message).toContain("250,00 TL");
  expect(await prisma.order.count({ where: { email: `ayar-min-${stamp}@datcamis.local` } })).toBe(0);
  expect((await putSettings({ payment: { minOrderAmount: null } })).statusCode).toBe(200);
});

test("bakım modunda ziyaretçi sepet/ödeme yapamaz, yönetici etkilenmez", async () => {
  const { token } = await cart(1);
  expect((await putSettings({ maintenance: { enabled: true } })).statusCode).toBe(200);
  const visitor = await app.inject({ method: "POST", url: "/api/v1/carts" });
  expect(visitor.statusCode).toBe(503);
  expect(visitor.json().error.code).toBe("MAINTENANCE");
  const checkout = await app.inject({ method: "POST", url: "/api/v1/checkout", headers: { "x-cart-token": token }, payload: checkoutBody("bakim") });
  expect(checkout.statusCode).toBe(503);
  const config = await app.inject({ method: "GET", url: "/api/v1/checkout/payment-config" });
  expect(config.statusCode).toBe(503);
  const staff = await app.inject({ method: "POST", url: "/api/v1/carts", headers: { authorization: auth.admin } });
  expect(staff.statusCode).toBe(200);
  ids.carts.push(staff.json().data.id);
  const callback = await app.inject({
    method: "POST",
    url: "/api/v1/payments/paytr/callback",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "merchant_oid=x&status=success&total_amount=1&hash=y",
  });
  expect(callback.json().error?.code).not.toBe("MAINTENANCE");
  const publicSettings = await app.inject({ method: "GET", url: "/api/v1/settings/public" });
  expect(publicSettings.json().data.maintenance.enabled).toBe(true);
  expect((await app.inject({ method: "GET", url: "/api/v1/catalog/products" })).statusCode).toBe(200);
  expect((await putSettings({ maintenance: { enabled: false } })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: "/api/v1/carts" })).statusCode).toBe(200);
});

test("yalnızca Owner ve Admin ayarları görür ve değiştirir", async () => {
  expect((await app.inject({ method: "GET", url: "/api/v1/admin/settings" })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: "/api/v1/admin/settings", headers: { authorization: auth.editor } })).statusCode).toBe(403);
  expect((await putSettings({ maintenance: { enabled: true } }, auth.orders)).statusCode).toBe(403);
  expect((await putSettings({ maintenance: { enabled: true } }, auth.editor)).statusCode).toBe(403);
  const admin = await app.inject({ method: "GET", url: "/api/v1/admin/settings", headers: { authorization: auth.admin } });
  expect(admin.statusCode).toBe(200);
  expect(admin.json().data.info.paytrConfigured).toBe(false);
  expect(JSON.stringify(admin.json())).not.toContain("merchant");
  const maintenance = await prisma.siteSetting.findUnique({ where: { key: "maintenance" } });
  expect((maintenance?.value as { enabled?: boolean } | undefined)?.enabled).toBe(false);
  const pub = await app.inject({ method: "GET", url: "/api/v1/settings/public" });
  expect(JSON.stringify(pub.json())).not.toContain(VALID_IBAN);
});

test("hatalı alanlar Türkçe mesajla reddedilir", async () => {
  const response = await putSettings({
    contact: { email: "yanlis-adres", phone: "123", whatsapp: "", address: "", workingHours: "", mapUrl: "harita" },
    company: { taxNumber: "123456789", mersisNo: "12", kepAddress: "kep" },
    social: { instagram: "javascript:alert(1)" },
    havale: { enabled: true, bankName: "Ziraat", accountHolder: "TEST Hesap", iban: "TR330006100519786457841327", note: "" },
    shipping: { ...SHIPPING, freeShippingThreshold: null, defaultCarrier: "Bilinmeyen Kargo" },
    general: { storeName: "", logoMediaId: "olmayan-medya" },
  });
  expect(response.statusCode).toBe(400);
  const details = response.json().error.details as Array<{ path: string; message: string }>;
  const byPath = Object.fromEntries(details.map((item) => [item.path, item.message]));
  expect(byPath["contact.email"]).toBe("Geçerli bir e-posta girin.");
  expect(byPath["contact.phone"]).toContain("Telefon geçersiz");
  expect(byPath["contact.mapUrl"]).toContain("geçerli bir bağlantı");
  expect(byPath["company.taxNumber"]).toBe("Vergi no 10 haneli olmalı.");
  expect(byPath["company.mersisNo"]).toBe("MERSİS no 16 haneli olmalı.");
  expect(byPath["company.kepAddress"]).toBeTruthy();
  expect(byPath["social.instagram"]).toBeTruthy();
  expect(byPath["havale.iban"]).toBe("IBAN kontrol hanesi geçersiz.");
  expect(byPath["shipping.freeShippingThreshold"]).toBe("Ücretsiz kargo sınırını girin.");
  expect(byPath["shipping.defaultCarrier"]).toBe("Listeden bir kargo firması seçin.");
  expect(byPath["general.storeName"]).toBe("Mağaza adı girin.");
  expect(JSON.stringify(response.json())).not.toContain("TR330006100519786457841327");
});

test("her değişiklik kim/ne zaman/ne değişti bilgisiyle AuditLog'a yazılır", async () => {
  const response = await putSettings({ shipping: { ...SHIPPING, flatFee: 8000 } }, auth.admin);
  expect(response.statusCode).toBe(200);
  const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "settings.update", actorId: { in: ids.users } }, orderBy: { createdAt: "desc" } });
  const meta = log.metadata as { text: string; changes: Array<{ section: string; field: string; from: string; to: string }> };
  expect(log.createdAt).toBeInstanceOf(Date);
  expect(meta.changes).toContainEqual({ section: "shipping", field: "flatFee", from: "7500", to: "8000" });
  expect(meta.text).toContain("Kargo");
  const same = await putSettings({ shipping: { ...SHIPPING, flatFee: 8000 } }, auth.admin);
  expect(same.json().data.changed).toBe(0);
  const logs = await prisma.auditLog.findMany({ where: { actorId: { in: ids.users }, action: "settings.update" } });
  for (const row of logs) expect(JSON.stringify(row.metadata)).not.toContain(VALID_IBAN);
});

test("eski duyuru kaydı yeni ayar yokken korunur", async () => {
  await prisma.siteSetting.deleteMany({ where: { key: "announcement" } });
  await prisma.siteSetting.upsert({ where: { key: "pricingNotice" }, update: { value: "TEST eski duyuru" }, create: { key: "pricingNotice", value: "TEST eski duyuru" } });
  const pub = await app.inject({ method: "GET", url: "/api/v1/settings/public" });
  expect(pub.json().data.announcement).toEqual({ enabled: true, text: "TEST eski duyuru" });
});
