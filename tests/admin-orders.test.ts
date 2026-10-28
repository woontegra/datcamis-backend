import "./helpers/local-database";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { loadEnv } from "../src/config/env";
import { prisma } from "../src/db";
import { hashPassword } from "../src/common/password";
import { signAccessToken } from "../src/common/tokens";

const env = loadEnv();
const stamp = Date.now();
const ids = {
  users: [] as string[],
  product: "",
  variant: "",
  inventory: "",
  orders: [] as string[],
};

let app: Awaited<ReturnType<typeof buildApp>>;
let ownerHeader = "";
let editorHeader = "";
let staffHeader = "";

async function token(role: "OWNER" | "EDITOR" | "ORDER_STAFF", name: string) {
  const user = await prisma.user.create({
    data: {
      email: `siparis-test-${role.toLowerCase()}-${stamp}@datcamis.local`,
      passwordHash: await hashPassword("Siparis-Test-12345"),
      name,
      role,
    },
  });
  ids.users.push(user.id);
  const jwt = await signAccessToken(env, { sub: user.id, email: user.email, role: user.role });
  return { authorization: `Bearer ${jwt}` };
}

const address = {
  fullName: "Ayşe Test",
  phone: "05551112233",
  line1: "Test sokak 1",
  district: "Merkez",
  city: "Muğla",
  postalCode: "48900",
  country: "TR",
};

async function makeOrder(number: string, onHandStart = 10) {
  if (!ids.variant) throw new Error("varyant yok");
  await prisma.inventoryItem.update({ where: { id: ids.inventory }, data: { onHand: onHandStart } });
  const order = await prisma.order.create({
    data: {
      number,
      email: "ayse.test@datcamis.local",
      status: "PENDING",
      subtotalAmount: 12000,
      totalAmount: 12000,
      shippingAddress: address,
      billingAddress: address,
      items: {
        create: {
          variantId: ids.variant,
          productName: "Sipariş Test Kolonyası",
          variantName: "100 ml",
          sku: `TEST-SIPARIS-${stamp}`,
          quantity: 2,
          unitAmount: 6000,
          totalAmount: 12000,
        },
      },
      payments: { create: { provider: "unconfigured", status: "PENDING", amount: 12000, currency: "TRY" } },
      shipments: { create: { provider: "unconfigured", status: "PENDING" } },
    },
  });
  ids.orders.push(order.id);
  await prisma.stockMovement.create({
    data: {
      inventoryItemId: ids.inventory,
      type: "OUT",
      quantity: 2,
      reason: "paytr_paid",
      referenceType: "order",
      referenceId: order.id,
    },
  });
  return order;
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  ownerHeader = (await token("OWNER", "Sipariş Owner")).authorization;
  editorHeader = (await token("EDITOR", "Sipariş Editor")).authorization;
  staffHeader = (await token("ORDER_STAFF", "Sipariş Personeli")).authorization;
  const product = await prisma.product.create({
    data: {
      slug: `siparis-test-${stamp}`,
      name: "Sipariş Test Kolonyası",
      summary: "Test",
      description: "Test",
      status: "ACTIVE",
      variants: {
        create: {
          sku: `TEST-SIPARIS-${stamp}`,
          name: "100 ml",
          priceAmount: 6000,
          isDefault: true,
          inventory: { create: { onHand: 10, reserved: 0 } },
        },
      },
    },
    include: { variants: { include: { inventory: true } } },
  });
  ids.product = product.id;
  ids.variant = product.variants[0].id;
  ids.inventory = product.variants[0].inventory!.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: { in: ids.orders } } });
  await prisma.stockMovement.deleteMany({ where: { inventoryItemId: ids.inventory } });
  if (ids.orders.length) await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
  if (ids.product) await prisma.product.delete({ where: { id: ids.product } });
  if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await app.close();
  await prisma.$disconnect();
});

test("editör siparişleri göremez, owner ve sipariş personeli görür", async () => {
  const denied = await app.inject({ method: "GET", url: "/api/v1/admin/orders", headers: { authorization: editorHeader } });
  expect(denied.statusCode).toBe(403);
  const list = await app.inject({ method: "GET", url: "/api/v1/admin/orders", headers: { authorization: ownerHeader } });
  expect(list.statusCode).toBe(200);
  const staff = await app.inject({ method: "GET", url: "/api/v1/admin/orders", headers: { authorization: staffHeader } });
  expect(staff.statusCode).toBe(200);
});

test("liste arama, durum filtresi ve sayfalama çalışır", async () => {
  const order = await makeOrder(`TEST-ORD-${stamp}-LIST`);
  const found = await app.inject({
    method: "GET",
    url: `/api/v1/admin/orders?q=${encodeURIComponent("05551112233")}&status=NEW&page=1&pageSize=20`,
    headers: { authorization: ownerHeader },
  });
  expect(found.statusCode).toBe(200);
  const body = found.json();
  expect(body.data.some((row: { id: string }) => row.id === order.id)).toBe(true);
  expect(body.meta.pageSize).toBe(20);
  expect(body.meta.counts.all).toBeGreaterThanOrEqual(1);
  expect(body.meta.counts.NEW).toBeGreaterThanOrEqual(1);
  const listed = body.data.find((row: { id: string; itemSummary?: string }) => row.id === order.id);
  expect(listed.itemSummary).toContain("Sipariş Test Kolonyası");
});

test("teslimden yeniye dönülemez, kargoda takip numarası zorunludur", async () => {
  const order = await makeOrder(`TEST-ORD-${stamp}-FLOW`);
  const bad = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/orders/${order.id}`,
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: { status: "DELIVERED" },
  });
  expect(bad.statusCode).toBe(409);
  expect(bad.json().error.code).toBe("ORDER_STATUS_FORBIDDEN");

  await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/orders/${order.id}`,
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: { status: "PROCESSING" },
  });
  const missing = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/orders/${order.id}`,
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: { status: "SHIPPED" },
  });
  expect(missing.statusCode).toBe(400);
  expect(missing.json().error.code).toBe("TRACKING_REQUIRED");

  const shipped = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/orders/${order.id}`,
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: { carrier: "Yurtiçi Kargo", trackingNumber: "YK123456", status: "SHIPPED" },
  });
  expect(shipped.statusCode).toBe(200);
  expect(shipped.json().data.status).toBe("SHIPPED");
  expect(shipped.json().data.shipment.trackingNumber).toBe("YK123456");
});

test("ödeme elle işaretlenir ve not geçmişe yazılır", async () => {
  const order = await makeOrder(`TEST-ORD-${stamp}-PAY`);
  const paid = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/orders/${order.id}`,
    headers: { authorization: staffHeader, "content-type": "application/json" },
    payload: { paymentStatus: "PAID", staffNote: "Elden onaylandı." },
  });
  expect(paid.statusCode).toBe(200);
  expect(paid.json().data.payment.status).toBe("PAID");
  expect(paid.json().data.payment.markedManually).toBe(true);
  expect(paid.json().data.staffNote).toBe("Elden onaylandı.");
  expect(paid.json().data.history.some((item: { action: string }) => item.action === "order.payment")).toBe(true);
  expect(paid.json().data.history.some((item: { action: string }) => item.action === "order.note")).toBe(true);
});

test("iptal stoku bir kez geri ekler, ikinci iptal stoku artırmaz", async () => {
  const order = await makeOrder(`TEST-ORD-${stamp}-CANCEL`, 8);
  const first = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/orders/${order.id}`,
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: { status: "CANCELLED", cancelReason: "Stok yok" },
  });
  expect(first.statusCode).toBe(200);
  const afterFirst = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ids.inventory } });
  expect(afterFirst.onHand).toBe(10);
  const second = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/orders/${order.id}`,
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: { status: "CANCELLED" },
  });
  expect(second.statusCode).toBe(200);
  const afterSecond = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ids.inventory } });
  expect(afterSecond.onHand).toBe(10);
  const ins = await prisma.stockMovement.count({ where: { inventoryItemId: ids.inventory, type: "IN", referenceId: order.id } });
  expect(ins).toBe(1);
});

test("iade stoku bir kez geri ekler", async () => {
  const order = await makeOrder(`TEST-ORD-${stamp}-RETURN`, 4);
  await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/orders/${order.id}`,
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: { status: "PROCESSING" },
  });
  await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/orders/${order.id}`,
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: { trackingNumber: "RET-1", carrier: "PTT", status: "SHIPPED" },
  });
  await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/orders/${order.id}`,
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: { status: "DELIVERED" },
  });
  const returned = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/orders/${order.id}`,
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: { status: "RETURNED" },
  });
  expect(returned.statusCode).toBe(200);
  expect(returned.json().data.status).toBe("RETURNED");
  const stock = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ids.inventory } });
  expect(stock.onHand).toBe(6);
  const again = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/orders/${order.id}`,
    headers: { authorization: ownerHeader, "content-type": "application/json" },
    payload: { status: "RETURNED" },
  });
  expect(again.statusCode).toBe(200);
  const stockAgain = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ids.inventory } });
  expect(stockAgain.onHand).toBe(6);
});
