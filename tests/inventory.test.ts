import "./helpers/local-database";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { loadEnv } from "../src/config/env";
import { prisma } from "../src/db";
import { hashPassword } from "../src/common/password";
import { signAccessToken } from "../src/common/tokens";
import { bulkPrice, priceProblem } from "../src/catalog/inventory";

const env = loadEnv();
const stamp = Date.now();
const ids = { users: [] as string[], products: [] as string[] };

let app: Awaited<ReturnType<typeof buildApp>>;
const auth = { admin: "", editor: "", staff: "" };

async function header(role: "ADMIN" | "EDITOR" | "ORDER_STAFF") {
  const user = await prisma.user.create({
    data: { email: `stock-test-${role.toLowerCase()}-${stamp}@datcamis.local`, passwordHash: await hashPassword("Stock-Test-12345"), name: `Stok ${role}`, role },
  });
  ids.users.push(user.id);
  return `Bearer ${await signAccessToken(env, { sub: user.id, email: user.email, role: user.role })}`;
}

function send(method: "GET" | "POST" | "PUT", url: string, payload?: unknown, authorization = auth.admin) {
  return app.inject({
    method,
    url,
    headers: { authorization, ...(payload ? { "content-type": "application/json" } : {}) },
    ...(payload ? { payload: payload as object } : {}),
  });
}

async function variant(key: string, priceAmount: number, compareAtAmount: number | null, onHand: number) {
  const product = await prisma.product.create({
    data: {
      slug: `test-stok-${key}-${stamp}`,
      name: `TEST Stok ${key} ${stamp}`,
      summary: "TEST",
      description: "TEST",
      variants: { create: { sku: `TEST-STK-${key}-${stamp}`, name: "Standart", priceAmount, compareAtAmount, isDefault: true, inventory: { create: { onHand } } } },
    },
    include: { variants: true },
  });
  ids.products.push(product.id);
  return product.variants[0];
}

const onHandOf = async (variantId: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId } })).onHand;

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  auth.admin = await header("ADMIN");
  auth.editor = await header("EDITOR");
  auth.staff = await header("ORDER_STAFF");
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids.users } } });
  if (ids.products.length) await prisma.product.deleteMany({ where: { id: { in: ids.products } } });
  if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await app.close();
  await prisma.$disconnect();
});

test("fiyat kuralı: sıfır/negatif yok, indirim öncesi fiyat satış fiyatından yüksek", () => {
  expect(priceProblem(0, null)).not.toBeNull();
  expect(priceProblem(-100, null)).not.toBeNull();
  expect(priceProblem(1000, 1000)).not.toBeNull();
  expect(priceProblem(1000, 1200)).toBeNull();
  expect(bulkPrice(999, { mode: "percent", direction: "increase", value: 10, includeCompareAt: true })).toBe(1099);
  expect(bulkPrice(1000, { mode: "amount", direction: "decrease", value: 250, includeCompareAt: true })).toBe(750);
});

test("toplu fiyat: fiyatı sıfıra/negatife indiren veya indirim öncesi kuralını bozan işlem uygulanmaz", async () => {
  const cheap = await variant("ucuz", 1000, null, 3);
  const discounted = await variant("indirimli", 1000, 1100, 3);

  const negative = await send("POST", "/api/v1/admin/variants/bulk-price", { ids: [cheap.id], mode: "amount", direction: "decrease", value: 1500, apply: true });
  expect(negative.statusCode).toBe(400);

  const preview = await send("POST", "/api/v1/admin/variants/bulk-price", { ids: [cheap.id, discounted.id], mode: "amount", direction: "increase", value: 200, includeCompareAt: false });
  expect(preview.statusCode).toBe(200);
  expect(preview.json().meta.problems).toBe(1);

  const blocked = await send("POST", "/api/v1/admin/variants/bulk-price", { ids: [cheap.id, discounted.id], mode: "amount", direction: "increase", value: 200, includeCompareAt: false, apply: true });
  expect(blocked.statusCode).toBe(400);
  const after = await prisma.productVariant.findMany({ where: { id: { in: [cheap.id, discounted.id] } } });
  expect(after.map((row) => row.priceAmount)).toEqual([1000, 1000]);

  const ok = await send("POST", "/api/v1/admin/variants/bulk-price", { ids: [discounted.id], mode: "percent", direction: "increase", value: 10, apply: true });
  expect(ok.statusCode).toBe(200);
  const updated = await prisma.productVariant.findUniqueOrThrow({ where: { id: discounted.id } });
  expect([updated.priceAmount, updated.compareAtAmount]).toEqual([1100, 1210]);

  const inline = await send("PUT", "/api/v1/admin/variants/prices", { items: [{ id: cheap.id, priceAmount: 0, compareAtAmount: null }] });
  expect(inline.statusCode).toBe(400);
});

test("stok sıfırın altına düşemez", async () => {
  const row = await variant("sifir", 1000, null, 2);
  const response = await send("POST", "/api/v1/admin/stock/batch", { items: [{ variantId: row.id, action: "out", quantity: 3, reason: "damage", expectedOnHand: 2 }] });
  expect(response.statusCode).toBe(400);
  expect(await onHandOf(row.id)).toBe(2);
});

test("bu arada stok değiştiyse uyarı verir ve hiçbir değişiklik uygulanmaz", async () => {
  const first = await variant("es1", 1000, null, 10);
  const second = await variant("es2", 1000, null, 10);
  await prisma.inventoryItem.update({ where: { variantId: second.id }, data: { onHand: 9 } });

  const response = await send("POST", "/api/v1/admin/stock/batch", {
    items: [
      { variantId: first.id, action: "in", quantity: 5, reason: "production", expectedOnHand: 10 },
      { variantId: second.id, action: "out", quantity: 2, reason: "damage", expectedOnHand: 10 },
    ],
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().error.code).toBe("STOCK_CHANGED");
  expect(response.json().error.details[0].path).toBe(second.id);
  expect([await onHandOf(first.id), await onHandOf(second.id)]).toEqual([10, 9]);

  const ok = await send("POST", "/api/v1/admin/stock/batch", {
    items: [{ variantId: second.id, action: "count", quantity: 7, reason: "count", expectedOnHand: 9 }],
    thresholds: [{ variantId: first.id, lowThreshold: 3 }],
  });
  expect(ok.statusCode).toBe(200);
  const movement = await prisma.stockMovement.findFirstOrThrow({ where: { inventoryItem: { variantId: second.id } } });
  expect([movement.delta, movement.balanceAfter, movement.type]).toEqual([-2, 7, "ADJUSTMENT"]);
});

test("toplu stok: seçili satırlar tek kayıtta, filtreye uyan tümünde sıfır altı atlanır ve tek AuditLog yazılır", async () => {
  const key = `toplu${stamp}`;
  const a = await variant(`${key}-a`, 1000, null, 10);
  const b = await variant(`${key}-b`, 1000, null, 2);
  const c = await variant(`${key}-c`, 1000, null, 1);
  const since = new Date();

  const batch = await send("POST", "/api/v1/admin/stock/batch", {
    items: [
      { variantId: a.id, action: "in", quantity: 5, reason: "production", expectedOnHand: 10 },
      { variantId: b.id, action: "in", quantity: 5, reason: "production", expectedOnHand: 2 },
    ],
    thresholds: [{ variantId: c.id, lowThreshold: 4 }],
  });
  expect(batch.statusCode).toBe(200);
  const batchLogs = await prisma.auditLog.findMany({ where: { actorId: ids.users[0], action: "stock.batch", createdAt: { gte: since } } });
  expect(batchLogs).toHaveLength(1);
  expect((batchLogs[0].metadata as { rows: number }).rows).toBe(3);

  const filter = { q: key };
  const operation = { type: "stock", action: "out", quantity: 3, reason: "damage" };
  const preview = await send("POST", "/api/v1/admin/stock/bulk", { filter, operation });
  expect(preview.statusCode).toBe(200);
  expect(preview.json().data).toMatchObject({ matched: 3, applicable: 2, skipped: 1 });
  expect(preview.json().data.skippedRows[0].id).toBe(c.id);

  const stale = await send("POST", "/api/v1/admin/stock/bulk", { filter, operation, apply: true, fingerprint: "eski" });
  expect(stale.statusCode).toBe(409);
  expect(await onHandOf(a.id)).toBe(15);

  const applied = await send("POST", "/api/v1/admin/stock/bulk", { filter, operation, apply: true, fingerprint: preview.json().meta.fingerprint });
  expect(applied.statusCode).toBe(200);
  expect(applied.json().data.applied).toBe(2);
  expect([await onHandOf(a.id), await onHandOf(b.id), await onHandOf(c.id)]).toEqual([12, 4, 1]);
  const bulkLogs = await prisma.auditLog.findMany({ where: { actorId: ids.users[0], action: "stock.bulk", createdAt: { gte: since } } });
  expect(bulkLogs).toHaveLength(1);
  expect((bulkLogs[0].metadata as { rows: number; skipped: number })).toMatchObject({ rows: 2, skipped: 1 });

  const editor = await send("POST", "/api/v1/admin/stock/bulk", { filter, operation }, auth.editor);
  expect(editor.statusCode).toBe(403);
});

test("fiyat ve stok değişikliği yalnızca Owner/Admin; Editor ve OrderStaff görüntüler", async () => {
  const row = await variant("yetki", 1000, null, 4);
  for (const authorization of [auth.editor, auth.staff]) {
    expect((await send("GET", "/api/v1/admin/variants", undefined, authorization)).statusCode).toBe(200);
    expect((await send("GET", "/api/v1/admin/stock", undefined, authorization)).statusCode).toBe(200);
    expect((await send("GET", "/api/v1/admin/stock/movements", undefined, authorization)).statusCode).toBe(200);
    expect((await send("PUT", "/api/v1/admin/variants/prices", { items: [{ id: row.id, priceAmount: 2000, compareAtAmount: null }] }, authorization)).statusCode).toBe(403);
    expect((await send("POST", "/api/v1/admin/variants/bulk-price", { ids: [row.id], mode: "percent", direction: "increase", value: 5, apply: true }, authorization)).statusCode).toBe(403);
    expect((await send("POST", "/api/v1/admin/stock/batch", { items: [{ variantId: row.id, action: "in", quantity: 1, reason: "production", expectedOnHand: 4 }] }, authorization)).statusCode).toBe(403);
  }
  expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: row.id } })).priceAmount).toBe(1000);
  expect(await onHandOf(row.id)).toBe(4);
});
