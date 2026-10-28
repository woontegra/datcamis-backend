import "./helpers/local-database";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { loadEnv } from "../src/config/env";
import { prisma } from "../src/db";
import { HAVALE_SETTING_KEY } from "../src/orders/havale";

const stamp = Date.now();
const VALID_IBAN = "TR330006100519786457841326";
const ids = { product: "", variant: "", orders: [] as string[] };
const address = {
  fullName: "Serdar Topal",
  phone: "05551112233",
  line1: "İskele Mah. Bademli Cad. 43/6",
  district: "Datça",
  city: "Muğla",
  postalCode: "48900",
  country: "TR",
};

const env = loadEnv();
let app: Awaited<ReturnType<typeof buildApp>>;

async function placeHavale() {
  const created = await app.inject({ method: "POST", url: "/api/v1/carts" });
  const token = created.json().data.token as string;
  await app.inject({
    method: "POST",
    url: "/api/v1/carts/current/items",
    headers: { "x-cart-token": token },
    payload: { variantId: ids.variant, quantity: 1 },
  });
  return app.inject({
    method: "POST",
    url: "/api/v1/checkout",
    headers: { "x-cart-token": token },
    payload: {
      email: `thanks-${stamp}-${ids.orders.length}@datcamis.local`,
      shippingAddress: address,
      invoice: { type: "INDIVIDUAL", sameAsShipping: true },
      paymentMethod: "havale",
      termsAccepted: true,
    },
  });
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  const product = await prisma.product.create({
    data: {
      slug: `thanks-test-${stamp}`,
      name: "TEST Teşekkür Kolonyası",
      summary: "Test",
      description: "Test",
      status: "ACTIVE",
      variants: {
        create: {
          sku: `TEST-THANKS-${stamp}`,
          name: "100 ml",
          priceAmount: 12000,
          isDefault: true,
          inventory: { create: { onHand: 10 } },
        },
      },
    },
    include: { variants: true },
  });
  ids.product = product.id;
  ids.variant = product.variants[0].id;
  await prisma.siteSetting.upsert({
    where: { key: HAVALE_SETTING_KEY },
    update: {
      value: { enabled: true, bankName: "Ziraat Bankası", accountHolder: "DatçaMis Test", iban: VALID_IBAN, note: "Açıklamaya sipariş numaranızı yazın." },
    },
    create: {
      key: HAVALE_SETTING_KEY,
      value: { enabled: true, bankName: "Ziraat Bankası", accountHolder: "DatçaMis Test", iban: VALID_IBAN, note: "Açıklamaya sipariş numaranızı yazın." },
    },
  });
});

afterAll(async () => {
  if (ids.orders.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids.orders } } });
    await prisma.stockMovement.deleteMany({ where: { referenceId: { in: ids.orders } } });
    await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
  }
  if (ids.product) {
    const variants = await prisma.productVariant.findMany({ where: { productId: ids.product } });
    if (variants.length) await prisma.cartItem.deleteMany({ where: { variantId: { in: variants.map((row) => row.id) } } });
    await prisma.product.delete({ where: { id: ids.product } });
  }
  await app.close();
  await prisma.$disconnect();
});

test("teşekkür sayfası sipariş numarası veya id ile açılmaz", async () => {
  const placed = await placeHavale();
  const body = placed.json().data.order;
  ids.orders.push(body.id);
  expect(body.accessToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  expect(body.accessToken).not.toBe(body.id);
  const byNumber = await app.inject({ method: "GET", url: `/api/v1/checkout/thanks/${body.number}` });
  const byId = await app.inject({ method: "GET", url: `/api/v1/checkout/thanks/${body.id}` });
  expect(byNumber.statusCode).toBe(404);
  expect(byId.statusCode).toBe(404);
  expect(JSON.stringify(byNumber.json())).not.toContain(address.fullName);
  expect(JSON.stringify(byId.json())).not.toContain(VALID_IBAN);
});

test("doğru erişim anahtarı havale özetini döner, e-posta ve TC vermez", async () => {
  const placed = await placeHavale();
  const body = placed.json().data.order;
  ids.orders.push(body.id);
  const response = await app.inject({ method: "GET", url: `/api/v1/checkout/thanks/${body.accessToken}` });
  expect(response.statusCode).toBe(200);
  const data = response.json().data;
  expect(data.havale.iban).toBe(VALID_IBAN);
  expect(data.havale.bankName).toBe("Ziraat Bankası");
  expect(data.shipping.fullName).toBe("Serdar Topal");
  expect(data.shipping.line1).toContain("Bademli");
  expect(JSON.stringify(data)).not.toContain("thanks-");
  expect(JSON.stringify(data)).not.toContain("05551112233");
  expect(JSON.stringify(data)).not.toContain(body.accessToken);
  expect(data.havale.note).toBeUndefined();
});

test("yanlış anahtar müşteri bilgisi göstermez", async () => {
  const response = await app.inject({ method: "GET", url: "/api/v1/checkout/thanks/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  expect(response.statusCode).toBe(404);
  expect(JSON.stringify(response.json())).not.toContain("Serdar");
  expect(JSON.stringify(response.json())).not.toContain(VALID_IBAN);
});

test("ödenmiş siparişte havale kartı dönmez", async () => {
  const placed = await placeHavale();
  const body = placed.json().data.order;
  ids.orders.push(body.id);
  await prisma.payment.updateMany({ where: { orderId: body.id }, data: { provider: "paytr", status: "PAID" } });
  const response = await app.inject({ method: "GET", url: `/api/v1/checkout/thanks/${body.accessToken}` });
  expect(response.statusCode).toBe(200);
  expect(response.json().data.paid).toBe(true);
  expect(response.json().data.havale).toBeNull();
});
