import "./helpers/local-database";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { loadEnv } from "../src/config/env";
import { prisma } from "../src/db";
import { hashPassword } from "../src/common/password";
import { signAccessToken } from "../src/common/tokens";

const env = loadEnv();
const stamp = Date.now();
const ids = { users: [] as string[], categories: [] as string[], collections: [] as string[], products: [] as string[] };

let app: Awaited<ReturnType<typeof buildApp>>;
let editor = "";
let staff = "";

async function header(role: "EDITOR" | "ORDER_STAFF") {
  const user = await prisma.user.create({
    data: { email: `katalog-test-${role.toLowerCase()}-${stamp}@datcamis.local`, passwordHash: await hashPassword("Katalog-Test-12345"), name: `Katalog ${role}`, role },
  });
  ids.users.push(user.id);
  return `Bearer ${await signAccessToken(env, { sub: user.id, email: user.email, role: user.role })}`;
}

function call(method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown, authorization = editor) {
  return app.inject({ method, url, headers: { authorization, ...(payload ? { "content-type": "application/json" } : {}) }, ...(payload ? { payload: payload as object } : {}) });
}

async function category(name: string, parentId: string | null = null) {
  const response = await call("POST", "/api/v1/admin/categories", { name: `TEST ${name} ${stamp}`, parentId });
  expect(response.statusCode).toBe(200);
  const id = response.json().data.id as string;
  ids.categories.push(id);
  return id;
}

async function product(name: string, price: number, extra: { featured?: boolean; compareAt?: number; createdAt?: Date; categoryId?: string } = {}) {
  const row = await prisma.product.create({
    data: {
      slug: `test-katalog-${name}-${stamp}`,
      name: `TEST ${name} ${stamp}`,
      summary: "Test",
      description: "Test",
      status: "ACTIVE",
      featured: extra.featured ?? false,
      ...(extra.createdAt ? { createdAt: extra.createdAt } : {}),
      variants: { create: { sku: `TEST-KAT-${name}-${stamp}`, name: "100 ml", priceAmount: price, compareAtAmount: extra.compareAt ?? null, isDefault: true } },
      ...(extra.categoryId ? { categories: { create: { categoryId: extra.categoryId } } } : {}),
    },
  });
  ids.products.push(row.id);
  return row.id;
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  editor = await header("EDITOR");
  staff = await header("ORDER_STAFF");
});

afterAll(async () => {
  const entityIds = [...ids.categories, ...ids.collections];
  await prisma.auditLog.deleteMany({ where: { entityId: { in: entityIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids.users } } });
  await prisma.seoMetadata.deleteMany({ where: { entityId: { in: entityIds } } });
  if (ids.collections.length) await prisma.collection.deleteMany({ where: { id: { in: ids.collections } } });
  if (ids.products.length) await prisma.product.deleteMany({ where: { id: { in: ids.products } } });
  for (const id of [...ids.categories].reverse()) await prisma.category.deleteMany({ where: { id } });
  if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await app.close();
  await prisma.$disconnect();
});

test("yalnızca yetkili roller kategori düzenleyebilir", async () => {
  const response = await call("POST", "/api/v1/admin/categories", { name: `TEST yetkisiz ${stamp}` }, staff);
  expect(response.statusCode).toBe(403);
});

test("kategori döngüsü ve 3 seviye sınırı engellenir", async () => {
  const root = await category("Kök");
  const child = await category("Alt", root);
  const grandChild = await category("Torun", child);

  const tooDeep = await call("POST", "/api/v1/admin/categories", { name: `TEST Derin ${stamp}`, parentId: grandChild });
  expect(tooDeep.statusCode).toBe(400);
  expect(tooDeep.json().error.code).toBe("CATEGORY_DEPTH");

  const cycle = await call("PATCH", `/api/v1/admin/categories/${root}`, { name: `TEST Kök ${stamp}`, parentId: grandChild });
  expect(cycle.statusCode).toBe(400);
  expect(cycle.json().error.code).toBe("CATEGORY_CYCLE");

  const self = await call("PUT", "/api/v1/admin/categories/tree", { items: [{ id: child, parentId: child, sortOrder: 0 }] });
  expect(self.statusCode).toBe(400);
  expect(self.json().error.code).toBe("CATEGORY_CYCLE");

  const other = await category("Diğer");
  const deepMove = await call("PUT", "/api/v1/admin/categories/tree", { items: [{ id: child, parentId: other, sortOrder: 0 }, { id: other, parentId: root, sortOrder: 0 }] });
  expect(deepMove.json().error.code).toBe("CATEGORY_DEPTH");

  expect((await prisma.category.findUnique({ where: { id: root } }))?.parentId).toBeNull();
});

test("içinde ürün veya alt kategori olan kategori silinemez, boşu silinir", async () => {
  const parent = await category("Dolu");
  const child = await category("DoluAlt", parent);
  await product("dolu-urun", 5000, { categoryId: child });

  const withChild = await call("DELETE", `/api/v1/admin/categories/${parent}`);
  expect(withChild.statusCode).toBe(409);
  expect(withChild.json().error.message).toContain("1 alt kategori");

  const withProduct = await call("DELETE", `/api/v1/admin/categories/${child}`);
  expect(withProduct.statusCode).toBe(409);
  expect(withProduct.json().error.message).toContain("1 ürün");

  const empty = await category("Boş");
  expect((await call("DELETE", `/api/v1/admin/categories/${empty}`)).statusCode).toBe(200);
  expect(await prisma.category.findUnique({ where: { id: empty } })).toBeNull();
});

test("otomatik koleksiyon kuralları hepsi mantığıyla birleşir", async () => {
  const parent = await category("Oto");
  const sub = await category("OtoAlt", parent);
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const match = await product("uyan", 8000, { featured: true, compareAt: 10000, categoryId: sub });
  await product("ucuz", 2000, { featured: true, compareAt: 3000, categoryId: sub });
  await product("eski", 8000, { featured: true, compareAt: 10000, categoryId: sub, createdAt: old });
  await product("indirimsiz", 8000, { featured: true, categoryId: sub });
  await product("disarida", 8000, { featured: true, compareAt: 10000 });

  const rules = [
    { type: "category", categoryId: parent },
    { type: "price", min: 5000, max: 9000 },
    { type: "featured" },
    { type: "onSale" },
    { type: "newWithinDays", days: 30 },
  ];
  const preview = await call("POST", "/api/v1/admin/collections/preview", { rules });
  expect(preview.statusCode).toBe(200);
  expect(preview.json().meta.total).toBe(1);
  expect(preview.json().data[0].id).toBe(match);

  const noRules = await call("POST", "/api/v1/admin/collections", { name: `TEST Boş Oto ${stamp}`, type: "AUTOMATIC", rules: [] });
  expect(noRules.statusCode).toBe(400);

  const badPrice = await call("POST", "/api/v1/admin/collections/preview", { rules: [{ type: "price", min: 9000, max: 1000 }] });
  expect(badPrice.statusCode).toBe(400);

  const created = await call("POST", "/api/v1/admin/collections", { name: `TEST Oto ${stamp}`, type: "AUTOMATIC", productSort: "MANUAL", rules });
  expect(created.statusCode).toBe(200);
  const { id, slug } = created.json().data as { id: string; slug: string };
  ids.collections.push(id);
  expect((await prisma.collection.findUnique({ where: { id } }))?.productSort).toBe("NEWEST");

  const store = await app.inject({ method: "GET", url: `/api/v1/catalog/products?collection=${slug}` });
  expect(store.json().data.map((row: { id: string }) => row.id)).toEqual([match]);

  await call("PATCH", `/api/v1/admin/collections/${id}`, { name: `TEST Oto ${stamp}`, isVisible: false });
  expect((await app.inject({ method: "GET", url: `/api/v1/catalog/collections/${slug}` })).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: `/api/v1/catalog/products?collection=${slug}` })).json().meta.total).toBe(0);

  expect((await call("DELETE", `/api/v1/admin/collections/${id}`)).statusCode).toBe(200);
  expect(await prisma.product.count({ where: { id: { in: ids.products } } })).toBe(ids.products.length);
});
