import "./helpers/local-database";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { loadEnv } from "../src/config/env";
import { prisma } from "../src/db";
import { hashPassword } from "../src/common/password";
import { signAccessToken } from "../src/common/tokens";
import { combinations } from "../src/catalog/attributes";
import { reportChanges, setupVariantAttributes } from "../src/catalog/attribute-setup";

const env = loadEnv();
const stamp = Date.now();
const ids = { users: [] as string[], products: [] as string[], attributes: [] as string[], orders: [] as string[] };

let app: Awaited<ReturnType<typeof buildApp>>;
const auth = { admin: "", editor: "" };

type AttributeJson = { id: string; name: string; values: Array<{ id: string; name: string; productCount: number }> };

async function header(role: "ADMIN" | "EDITOR") {
  const user = await prisma.user.create({
    data: { email: `attr-test-${role.toLowerCase()}-${stamp}@datcamis.local`, passwordHash: await hashPassword("Attr-Test-12345"), name: `Özellik ${role}`, role },
  });
  ids.users.push(user.id);
  return `Bearer ${await signAccessToken(env, { sub: user.id, email: user.email, role: user.role })}`;
}

function send(method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, authorization = auth.admin) {
  return app.inject({
    method,
    url,
    headers: { authorization, ...(payload ? { "content-type": "application/json" } : {}) },
    ...(payload ? { payload: payload as object } : {}),
  });
}

async function attribute(name: string, values: string[]) {
  const response = await send("POST", "/api/v1/admin/attributes", { name: `TEST ${name} ${stamp}`, values: values.map((value) => ({ name: value })) }, auth.editor);
  expect(response.statusCode).toBe(200);
  const body = response.json().data as AttributeJson;
  ids.attributes.push(body.id);
  return body;
}

const valueId = (attr: AttributeJson, name: string) => attr.values.find((value) => value.name === name)!.id;

async function createProduct(key: string, options: Array<{ attributeId: string; valueIds: string[] }>, firstCombo: string[]) {
  const response = await send("POST", "/api/v1/admin/products", {
    name: `TEST Seçenek ${key} ${stamp}`,
    vatRate: 20,
    options,
    variants: [{ name: "x", sku: `TEST-OPT-${key}-${stamp}`, priceAmount: 5000, optionValueIds: firstCombo }],
  });
  expect(response.statusCode).toBe(200);
  ids.products.push(response.json().data.id);
  return response.json().data as { id: string; variants: Array<{ id: string; name: string; sku: string; priceAmount: number; disabled: boolean; optionValueIds: string[] }> };
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  auth.admin = await header("ADMIN");
  auth.editor = await header("EDITOR");
});

afterAll(async () => {
  if (ids.orders.length) await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
  if (ids.products.length) await prisma.product.deleteMany({ where: { id: { in: ids.products } } });
  if (ids.attributes.length) await prisma.variantAttribute.deleteMany({ where: { id: { in: ids.attributes } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids.users } } });
  if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await app.close();
  await prisma.$disconnect();
});

test("kombinasyon üretimi: Metal (Altın, Gümüş) × Ölçü (S, M) = 4 varyant", async () => {
  expect(combinations([["Altın", "Gümüş"], ["S", "M"]])).toEqual([["Altın", "S"], ["Altın", "M"], ["Gümüş", "S"], ["Gümüş", "M"]]);

  const metal = await attribute("Metal", ["Altın", "Gümüş"]);
  const size = await attribute("Ölçü", ["S", "M"]);
  const product = await createProduct(
    "kombi",
    [{ attributeId: metal.id, valueIds: [valueId(metal, "Altın"), valueId(metal, "Gümüş")] }, { attributeId: size.id, valueIds: [valueId(size, "S"), valueId(size, "M")] }],
    [valueId(metal, "Altın"), valueId(size, "S")],
  );
  expect(product.variants).toHaveLength(4);
  expect(product.variants.map((variant) => variant.name).sort()).toEqual(
    [`${metal.name}: Altın · ${size.name}: M`, `${metal.name}: Altın · ${size.name}: S`, `${metal.name}: Gümüş · ${size.name}: M`, `${metal.name}: Gümüş · ${size.name}: S`].sort(),
  );
  expect(new Set(product.variants.map((variant) => variant.sku)).size).toBe(4);
  expect(product.variants.every((variant) => variant.priceAmount === 5000)).toBe(true);

  const tooMany = await send("POST", "/api/v1/admin/products", {
    name: `TEST Fazla ${stamp}`,
    vatRate: 20,
    options: [1, 2, 3, 4].map(() => ({ attributeId: metal.id, valueIds: [valueId(metal, "Altın")] })),
    variants: [{ name: "x", sku: `TEST-FAZLA-${stamp}`, priceAmount: 5000 }],
  });
  expect(tooMany.statusCode).toBe(400);
});

test("üründe kullanılan değer ve özellik silinemez; kullanılmayan silinir; ad değişince sipariş adı değişmez", async () => {
  const volume = await attribute("Hacim", ["100 ml", "250 ml", "400 ml"]);
  const product = await createProduct("kullanim", [{ attributeId: volume.id, valueIds: [valueId(volume, "100 ml"), valueId(volume, "250 ml")] }], [valueId(volume, "100 ml")]);
  const small = product.variants.find((variant) => variant.name.endsWith("100 ml"))!;
  const order = await prisma.order.create({
    data: {
      number: `TEST-ATTR-${stamp}`,
      email: "attr.test@datcamis.local",
      subtotalAmount: 5000,
      totalAmount: 5000,
      shippingAddress: { fullName: "Test" },
      billingAddress: { fullName: "Test" },
      items: { create: { variantId: small.id, productName: "TEST", variantName: small.name, sku: small.sku, quantity: 1, unitAmount: 5000, totalAmount: 5000 } },
    },
  });
  ids.orders.push(order.id);

  const values = (names: string[]) => names.map((name) => ({ id: valueId(volume, name), name }));
  const removeUsed = await send("PUT", `/api/v1/admin/attributes/${volume.id}`, { name: volume.name, values: values(["250 ml", "400 ml"]) }, auth.editor);
  expect(removeUsed.statusCode).toBe(409);
  expect(removeUsed.json().error.code).toBe("VALUE_IN_USE");
  expect(removeUsed.json().error.message).toContain("100 ml");

  const deleteAttr = await send("DELETE", `/api/v1/admin/attributes/${volume.id}`, undefined, auth.editor);
  expect(deleteAttr.statusCode).toBe(409);

  const removeUnused = await send("PUT", `/api/v1/admin/attributes/${volume.id}`, { name: volume.name, values: values(["100 ml", "250 ml"]) }, auth.editor);
  expect(removeUnused.statusCode).toBe(200);
  expect((removeUnused.json().data as AttributeJson).values.map((value) => value.name)).toEqual(["100 ml", "250 ml"]);

  const rename = await send("PUT", `/api/v1/admin/attributes/${volume.id}`, { name: volume.name, values: [{ id: valueId(volume, "100 ml"), name: "100 mL" }, { id: valueId(volume, "250 ml"), name: "250 ml" }] }, auth.editor);
  expect(rename.statusCode).toBe(200);
  expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: small.id } })).name).toBe(`${volume.name}: 100 mL`);
  expect((await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })).variantName).toBe(small.name);
});

test("değer üründen kaldırılınca siparişi olan varyant pasife alınır, olmayan kaldırılır", async () => {
  const size = await attribute("Beden", ["S", "M", "L"]);
  const product = await createProduct("pasif", [{ attributeId: size.id, valueIds: [valueId(size, "S"), valueId(size, "M"), valueId(size, "L")] }], [valueId(size, "S")]);
  const byName = (suffix: string) => product.variants.find((variant) => variant.name.endsWith(`: ${suffix}`))!;
  const order = await prisma.order.create({
    data: {
      number: `TEST-ATTR-P-${stamp}`,
      email: "attr.test@datcamis.local",
      subtotalAmount: 5000,
      totalAmount: 5000,
      shippingAddress: { fullName: "Test" },
      billingAddress: { fullName: "Test" },
      items: { create: { variantId: byName("M").id, productName: "TEST", variantName: byName("M").name, sku: byName("M").sku, quantity: 1, unitAmount: 5000, totalAmount: 5000 } },
    },
  });
  ids.orders.push(order.id);

  const keep = byName("S");
  const response = await send("PATCH", `/api/v1/admin/products/${product.id}`, {
    name: `TEST Seçenek pasif ${stamp}`,
    vatRate: 20,
    options: [{ attributeId: size.id, valueIds: [valueId(size, "S")] }],
    variants: [{ id: keep.id, name: keep.name, sku: keep.sku, priceAmount: 5000, optionValueIds: [valueId(size, "S")] }],
  });
  expect(response.statusCode).toBe(200);
  const medium = await prisma.productVariant.findUniqueOrThrow({ where: { id: byName("M").id } });
  expect(medium.disabledAt).not.toBeNull();
  expect(medium.deletedAt).toBeNull();
  expect(await prisma.productVariant.findUnique({ where: { id: byName("L").id } })).toBeNull();
  const active = (response.json().data.variants as Array<{ disabled: boolean }>).filter((variant) => !variant.disabled);
  expect(active).toHaveLength(1);
});

test("aktarım betiği tekrar çalışınca hiçbir şey değiştirmez; fiyat, stok ve SKU aynı kalır", async () => {
  const product = await prisma.product.create({
    data: {
      slug: `test-betik-${stamp}`,
      name: `TEST Betik ${stamp}`,
      summary: "TEST",
      description: "TEST",
      variants: {
        create: [
          { sku: `TEST-BTK-100-${stamp}`, name: "100 ml", priceAmount: 4000, isDefault: true, inventory: { create: { onHand: 7 } } },
          { sku: `TEST-BTK-250-${stamp}`, name: "250 ml", priceAmount: 7000, inventory: { create: { onHand: 3 } } },
        ],
      },
    },
  });
  ids.products.push(product.id);
  const odd = await prisma.product.create({
    data: { slug: `test-betik-std-${stamp}`, name: `TEST Betik Standart ${stamp}`, summary: "TEST", description: "TEST", variants: { create: { sku: `TEST-BTK-STD-${stamp}`, name: "Standart", priceAmount: 1000 } } },
  });
  ids.products.push(odd.id);
  const attributeName = `TEST Hacim betik ${stamp}`;

  const first = await setupVariantAttributes({ attributeName, productIds: [product.id, odd.id] });
  const created = await prisma.variantAttribute.findUniqueOrThrow({ where: { name: attributeName } });
  ids.attributes.push(created.id);
  expect(first.productsLinked).toBe(1);
  expect(first.unmatched.map((row) => row.name)).toEqual(["Standart"]);

  const second = await setupVariantAttributes({ attributeName, productIds: [product.id, odd.id] });
  expect(reportChanges(second)).toBe(0);

  const variants = await prisma.productVariant.findMany({ where: { productId: product.id }, include: { inventory: true }, orderBy: { priceAmount: "asc" } });
  expect(variants.map((variant) => [variant.name, variant.sku, variant.priceAmount, variant.inventory?.onHand])).toEqual([
    [`${attributeName}: 100 ml`, `TEST-BTK-100-${stamp}`, 4000, 7],
    [`${attributeName}: 250 ml`, `TEST-BTK-250-${stamp}`, 7000, 3],
  ]);
});
