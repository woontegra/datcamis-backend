import "./helpers/local-database";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { loadEnv } from "../src/config/env";
import { prisma } from "../src/db";
import { hashPassword } from "../src/common/password";
import { signAccessToken } from "../src/common/tokens";

const env = loadEnv();
const stamp = Date.now();
const ids = { users: [] as string[], category: "", products: [] as string[], media: "" };

let app: Awaited<ReturnType<typeof buildApp>>;
let ownerHeader = "";
let editorHeader = "";
let staffHeader = "";

async function token(role: "OWNER" | "EDITOR" | "ORDER_STAFF") {
  const user = await prisma.user.create({
    data: {
      email: `urun-test-${role.toLowerCase()}-${stamp}@datcamis.local`,
      passwordHash: await hashPassword("Urun-Test-12345"),
      name: `Ürün ${role}`,
      role,
    },
  });
  ids.users.push(user.id);
  const jwt = await signAccessToken(env, { sub: user.id, email: user.email, role: user.role });
  return { authorization: `Bearer ${jwt}` };
}

const variant = (sku: string, price = 5000, compareAtAmount: number | null = 7000) => ({
  name: "100 ml",
  sku,
  priceAmount: price,
  compareAtAmount,
  weightGrams: 120,
  desi: 0.5,
  isDefault: true,
});

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  ownerHeader = (await token("OWNER")).authorization;
  editorHeader = (await token("EDITOR")).authorization;
  staffHeader = (await token("ORDER_STAFF")).authorization;
  const category = await prisma.category.create({
    data: { slug: `test-urun-kat-${stamp}`, name: "TEST Ürün Kategori" },
  });
  ids.category = category.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: { in: ids.products } } });
  await prisma.seoMetadata.deleteMany({ where: { entityId: { in: ids.products } } });
  if (ids.products.length) await prisma.product.deleteMany({ where: { id: { in: ids.products } } });
  if (ids.category) await prisma.category.delete({ where: { id: ids.category } }).catch(() => undefined);
  if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await app.close();
  await prisma.$disconnect();
});

test("editör fiyat ve stok değiştiremez, personel yalnızca görür", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products",
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: {
      name: `TEST Kolonya ${stamp}`,
      summary: "Test",
      description: "Test açıklama",
      categoryIds: [ids.category],
      variants: [variant(`TEST-SKU-${stamp}`)],
    },
  });
  expect(created.statusCode).toBe(200);
  const id = created.json().data.id as string;
  ids.products.push(id);

  const editorCreate = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products",
    headers: { authorization: editorHeader, "content-type": "application/json" },
    payload: { name: "TEST editor", variants: [variant(`TEST-ED-${stamp}`)] },
  });
  expect(editorCreate.statusCode).toBe(403);

  const staffList = await app.inject({ method: "GET", url: "/api/v1/admin/products", headers: { authorization: staffHeader } });
  expect(staffList.statusCode).toBe(200);

  const editorStock = await app.inject({
    method: "POST",
    url: `/api/v1/admin/products/${id}/stock`,
    headers: { authorization: editorHeader, "content-type": "application/json" },
    payload: { variantId: created.json().data.variants[0].id, action: "in", quantity: 2, reason: "TEST ekleme" },
  });
  expect(editorStock.statusCode).toBe(403);
});

test("SKU ve slug benzersizdir, indirim öncesi fiyat satıştan yüksek olmalıdır", async () => {
  const first = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products",
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: {
      name: `TEST Slug ${stamp}`,
      slug: `test-slug-${stamp}`,
      variants: [variant(`TEST-UNIQ-${stamp}`, 4000, 6000)],
    },
  });
  expect(first.statusCode).toBe(200);
  ids.products.push(first.json().data.id);

  const dupSlug = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products",
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: {
      name: `TEST Slug iki ${stamp}`,
      slug: `test-slug-${stamp}`,
      variants: [variant(`TEST-UNIQ-B-${stamp}`, 4000, 6000)],
    },
  });
  expect(dupSlug.statusCode).toBe(200);
  expect(dupSlug.json().data.slug).not.toBe(`test-slug-${stamp}`);
  ids.products.push(dupSlug.json().data.id);

  const badPrice = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products",
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: {
      name: `TEST Fiyat ${stamp}`,
      variants: [variant(`TEST-BADP-${stamp}`, 5000, 5000)],
    },
  });
  expect(badPrice.statusCode).toBe(400);
  expect(badPrice.json().error.code).toBe("COMPARE_AT_INVALID");
});

test("stok hareketi kaydedilir, kopya taslak ve stoksuz olur, siparişli ürün silinemez", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/admin/products",
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: {
      name: `TEST Stok ${stamp}`,
      variants: [variant(`TEST-STK-${stamp}`, 3000, 4500)],
    },
  });
  const id = created.json().data.id as string;
  const variantId = created.json().data.variants[0].id as string;
  ids.products.push(id);

  const add = await app.inject({
    method: "POST",
    url: `/api/v1/admin/products/${id}/stock`,
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: { variantId, action: "in", quantity: 4, reason: "TEST mal kabul" },
  });
  expect(add.statusCode).toBe(200);
  expect(add.json().data.variants[0].onHand).toBe(4);

  const copy = await app.inject({
    method: "POST",
    url: `/api/v1/admin/products/${id}/copy`,
    headers: { authorization: ownerHeader },
  });
  expect(copy.statusCode).toBe(200);
  expect(copy.json().data.status).toBe("DRAFT");
  expect(copy.json().data.variants[0].onHand).toBe(0);
  expect(copy.json().data.slug).not.toBe(created.json().data.slug);
  ids.products.push(copy.json().data.id);

  await prisma.order.create({
    data: {
      number: `TEST-PRD-${stamp}`,
      email: "urun.test@datcamis.local",
      status: "PENDING",
      subtotalAmount: 3000,
      totalAmount: 3000,
      shippingAddress: { fullName: "Test" },
      billingAddress: { fullName: "Test" },
      items: {
        create: {
          variantId,
          productName: "TEST Stok",
          variantName: "100 ml",
          sku: `TEST-STK-${stamp}`,
          quantity: 1,
          unitAmount: 3000,
          totalAmount: 3000,
        },
      },
    },
  });
  const del = await app.inject({
    method: "DELETE",
    url: `/api/v1/admin/products/${id}`,
    headers: { authorization: ownerHeader },
  });
  expect(del.statusCode).toBe(409);
  expect(del.json().error.code).toBe("PRODUCT_HAS_ORDERS");
  const archived = await prisma.product.findUniqueOrThrow({ where: { id } });
  expect(archived.status).toBe("ARCHIVED");
  await prisma.order.deleteMany({ where: { number: `TEST-PRD-${stamp}` } });
});
