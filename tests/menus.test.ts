import "./helpers/local-database";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { loadEnv } from "../src/config/env";
import { prisma } from "../src/db";
import { hashPassword } from "../src/common/password";
import { signAccessToken } from "../src/common/tokens";
import { safeHref } from "../src/content/menus";

const env = loadEnv();
const stamp = Date.now();
const ids = { users: [] as string[], menus: [] as string[], categories: [] as string[] };

let app: Awaited<ReturnType<typeof buildApp>>;
let editor = "";
let staff = "";

async function header(role: "EDITOR" | "ORDER_STAFF") {
  const user = await prisma.user.create({
    data: { email: `menu-test-${role.toLowerCase()}-${stamp}@datcamis.local`, passwordHash: await hashPassword("Menu-Test-12345"), name: `Menü ${role}`, role },
  });
  ids.users.push(user.id);
  return `Bearer ${await signAccessToken(env, { sub: user.id, email: user.email, role: user.role })}`;
}

function send(method: "POST" | "PUT", url: string, payload: unknown, authorization = editor) {
  return app.inject({ method, url, headers: { authorization, "content-type": "application/json" }, payload: payload as object });
}

async function createMenu(items: unknown[]) {
  const response = await send("POST", "/api/v1/admin/menus", { name: `TEST Menü ${stamp}`, items });
  if (response.statusCode === 200) ids.menus.push(response.json().data.id);
  return response;
}

const custom = (key: string, parentKey: string | null = null, url = "/urunler") => ({ key, parentKey, type: "CUSTOM", url, label: `TEST ${key}` });

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  editor = await header("EDITOR");
  staff = await header("ORDER_STAFF");
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids.users } } });
  for (const id of ids.menus) {
    await prisma.menuItem.updateMany({ where: { menuId: id }, data: { parentId: null } });
    await prisma.menu.deleteMany({ where: { id } });
  }
  if (ids.categories.length) await prisma.category.deleteMany({ where: { id: { in: ids.categories } } });
  if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await app.close();
  await prisma.$disconnect();
});

test("yalnızca yetkili roller menü düzenleyebilir", async () => {
  const response = await send("POST", "/api/v1/admin/menus", { name: `TEST yetkisiz ${stamp}` }, staff);
  expect(response.statusCode).toBe(403);
});

test("menü en fazla 2 seviye olabilir", async () => {
  const ok = await createMenu([custom("a"), custom("b", "a")]);
  expect(ok.statusCode).toBe(200);

  const deep = await createMenu([custom("a"), custom("b", "a"), custom("c", "b")]);
  expect(deep.statusCode).toBe(400);
  expect(deep.json().error.message).toContain("2 seviye");
});

test("silinen veya gizlenen kayda bağlı öğe mağazada görünmez, panelde işaretlenir", async () => {
  const category = await prisma.category.create({ data: { slug: `test-menu-kat-${stamp}`, name: `TEST Menü Kategori ${stamp}` } });
  const hidden = await prisma.category.create({ data: { slug: `test-menu-gizli-${stamp}`, name: `TEST Gizli ${stamp}`, isVisible: false } });
  ids.categories.push(category.id, hidden.id);
  const created = await createMenu([
    { key: "kat", type: "CATEGORY", categoryId: category.id, label: "" },
    { key: "alt", parentKey: "kat", type: "CUSTOM", url: "/blog", label: "TEST alt" },
    { key: "gizli", type: "CATEGORY", categoryId: hidden.id, label: "" },
    { key: "sayfa", type: "PAGE", pageKey: "contact", label: "" },
  ]);
  expect(created.statusCode).toBe(200);
  const id = created.json().data.id as string;
  const { key } = (await prisma.menu.findUniqueOrThrow({ where: { id } }));

  const before = (await app.inject({ method: "GET", url: `/api/v1/content/menus/${key}` })).json().data.items;
  expect(before.map((item: { label: string }) => item.label)).toEqual([category.name, "İletişim"]);
  expect(before[0].href).toBe(`/kategoriler/${category.slug}`);
  expect(before[0].children).toHaveLength(1);

  await prisma.category.delete({ where: { id: category.id } });
  const after = (await app.inject({ method: "GET", url: `/api/v1/content/menus/${key}` })).json().data.items;
  expect(after.map((item: { label: string }) => item.label)).toEqual(["İletişim"]);

  const admin = await app.inject({ method: "GET", url: `/api/v1/admin/menus/${id}`, headers: { authorization: editor } });
  const problems = admin.json().data.items.map((item: { problem: string | null }) => item.problem);
  expect(problems).toEqual(["Bağlı kategori silinmiş.", null, "Bağlı kategori mağazada gizli.", null]);
});

test("özel bağlantılar yalnızca güvenli adresleri kabul eder", async () => {
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "//kotu.example", "vbscript:x", "/a b", "http://localhost", "ftp://x.example"]) {
    expect(safeHref(bad), bad).toBeNull();
  }
  for (const good of ["/urunler", "/kategoriler/a?x=1", "#iletisim", "https://www.example.com/a", "mailto:merhaba@example.com", "tel:+905551112233"]) {
    expect(safeHref(good), good).not.toBeNull();
  }
  const rejected = await createMenu([custom("x", null, "javascript:alert(1)")]);
  expect(rejected.statusCode).toBe(400);
  expect(rejected.json().error.details[0].path).toBe("items.0.url");
});
