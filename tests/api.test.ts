import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { loadEnv } from "../src/config/env";
import { loadDotEnv } from "../src/load-env";
import { prisma } from "../src/db";

loadDotEnv();
const env = loadEnv();

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

function accessCookie(setCookie: string | string[] | undefined) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const found = list.find((item) => item.startsWith("dm_access="));
  if (!found) throw new Error("dm_access çerezi yok");
  return found.split(";")[0];
}

test("health veritabanına bağlanır", async () => {
  const response = await app.inject({ method: "GET", url: "/api/v1/health" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ data: { status: "ok" } });
});

test("hatalı giriş reddedilir", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/admin/auth/login",
    payload: { email: "owner@datcamis.local", password: "yanlis-sifre-123" },
  });
  expect(response.statusCode).toBe(401);
});

test("yönetici oturumu ve pano gerçek veriyle açılır", async () => {
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/admin/auth/login",
    payload: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const cookie = accessCookie(login.headers["set-cookie"]);

  const denied = await app.inject({ method: "GET", url: "/api/v1/admin/dashboard" });
  expect(denied.statusCode).toBe(401);

  const dashboard = await app.inject({ method: "GET", url: "/api/v1/admin/dashboard", headers: { cookie } });
  expect(dashboard.statusCode).toBe(200);
  const body = dashboard.json();
  expect(typeof body.data.revenueAmount).toBe("number");
  expect(body.data.conversionRate).toBeNull();
  expect(Array.isArray(body.data.salesSeries)).toBe(true);
  expect(body.data.salesSeries).toHaveLength(14);
});

test("seed ürünler listelenir ve fiyat kuruş olarak tam sayıdır", async () => {
  const response = await app.inject({ method: "GET", url: "/api/v1/catalog/products?pageSize=24" });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.meta.total).toBeGreaterThanOrEqual(10);
  const flower = body.data.find((item: { slug: string }) => item.slug === "limon-cicegi-kolonyasi");
  expect(flower.isSeed).toBe(true);
  expect(Number.isInteger(flower.variants[0].priceAmount)).toBe(true);
});

test("sepet ve checkout sipariş anlık görüntüsü üretir", async () => {
  const created = await app.inject({ method: "POST", url: "/api/v1/carts" });
  const token = created.json().data.token as string;
  const variant = await prisma.productVariant.findFirstOrThrow({
    where: { sku: "SEED-LIMON-CICEGI-KOLONYASI-1" },
  });
  const added = await app.inject({
    method: "POST",
    url: "/api/v1/carts/current/items",
    headers: { "x-cart-token": token },
    payload: { variantId: variant.id, quantity: 1 },
  });
  expect(added.statusCode).toBe(200);

  const checkout = await app.inject({
    method: "POST",
    url: "/api/v1/checkout",
    headers: { "x-cart-token": token },
    payload: {
      email: "seed-checkout@datcamis.local",
      shippingAddress: {
        fullName: "Test Alıcı",
        phone: "05550000000",
        line1: "Seed mahalle",
        district: "Datça",
        city: "Muğla",
        postalCode: "48900",
        country: "TR",
      },
    },
  });
  expect(checkout.statusCode).toBe(200);
  const order = checkout.json().data;
  expect(order.items[0].productName).toBe("Limon Çiçeği Kolonyası");
  expect(order.payments[0].provider).toBe("unconfigured");
  expect(order.shipments[0].provider).toBe("unconfigured");
  expect(Number.isInteger(order.totalAmount)).toBe(true);
});

test("editör olmayan istek kullanıcı listesine giremez", async () => {
  const response = await app.inject({ method: "GET", url: "/api/v1/admin/users" });
  expect(response.statusCode).toBe(401);
});
