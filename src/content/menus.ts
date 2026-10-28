import type { MenuItemType, MenuLocation, Prisma, StaffRole } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireStaff, type StaffSession } from "../auth/staff";
import { AppError, notFound } from "../common/errors";
import { parse } from "../common/parse";
import type { Env } from "../config/env";
import { prisma } from "../db";
import { slugify } from "../catalog/admin";
import { visibleCategoryIds } from "../catalog/taxonomy";

export const MENU_EDIT_ROLES: StaffRole[] = ["OWNER", "ADMIN", "EDITOR"];
export const MAX_MENU_DEPTH = 2;
export const MENU_LOCATIONS: MenuLocation[] = ["HEADER", "FOOTER_1", "FOOTER_2", "FOOTER_3"];
const HOME_EDITOR_SLUG = "ana-sayfa";

/** Fixed store routes that can be linked as "Sayfa" items. */
export const SYSTEM_PAGES = [
  { key: "home", label: "Ana Sayfa", href: "/" },
  { key: "products", label: "Ürünler", href: "/urunler" },
  { key: "collections", label: "Koleksiyonlar", href: "/koleksiyonlar" },
  { key: "story", label: "Hikayemiz", href: "/hikayemiz" },
  { key: "blog", label: "Blog", href: "/blog" },
  { key: "contact", label: "İletişim", href: "/iletisim" },
  { key: "search", label: "Arama", href: "/arama" },
  { key: "favorites", label: "Favoriler", href: "/favoriler" },
  { key: "account", label: "Hesap", href: "/hesap" },
] as const;
const SYSTEM_BY_KEY = new Map<string, (typeof SYSTEM_PAGES)[number]>(SYSTEM_PAGES.map((page) => [page.key, page]));

/* ---------- Safe links ---------- */

const UNSAFE_CHARS = /[\u0000-\u001f\u007f\s\\]/;

/** Relative store paths, http(s), mailto and tel only. */
export function safeHref(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 500 || UNSAFE_CHARS.test(value)) return null;
  if (value.startsWith("/")) return value.startsWith("//") ? null : value;
  if (value.startsWith("#")) return value;
  const lower = value.toLowerCase();
  if (lower.startsWith("mailto:")) return /^mailto:[^@\s]+@[^@\s]+$/i.test(value) ? value : null;
  if (lower.startsWith("tel:")) return /^tel:\+?[0-9()\-.]{3,30}$/.test(value) ? value : null;
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".")) return url.toString();
  } catch {
    return null;
  }
  return null;
}

/* ---------- Validation ---------- */

const itemSchema = z.object({
  key: z.string().min(1).max(60),
  parentKey: z.string().min(1).max(60).nullable().optional(),
  type: z.enum(["CATEGORY", "COLLECTION", "PAGE", "CUSTOM"]),
  categoryId: z.string().min(1).nullable().optional(),
  collectionId: z.string().min(1).nullable().optional(),
  pageId: z.string().min(1).nullable().optional(),
  pageKey: z.string().min(1).max(40).nullable().optional(),
  url: z.string().max(500).nullable().optional(),
  label: z.string().trim().max(80, "Görünen ad en fazla 80 karakter olabilir.").default(""),
  openInNewTab: z.boolean().default(false),
  isHidden: z.boolean().default(false),
});

type ItemInput = z.infer<typeof itemSchema>;

const menuBody = z.object({
  name: z.string({ required_error: "Menü adı girin." }).trim().min(2, "Menü adı en az 2 karakter olmalı.").max(60, "Menü adı en fazla 60 karakter olabilir."),
  location: z.enum(["HEADER", "FOOTER_1", "FOOTER_2", "FOOTER_3"]).nullable().optional(),
  items: z.array(itemSchema).max(200, "Bir menüde en fazla 200 öğe olabilir.").optional(),
});

function invalid(index: number, message: string, field = "") {
  return new AppError(400, "MENU_ITEM_INVALID", message, [{ path: `items.${index}${field ? `.${field}` : ""}`, message }]);
}

/** Checks the 2-level limit, links and linked records; returns rows ready to insert (in order). */
export async function prepareItems(items: ItemInput[]) {
  const position = new Map(items.map((item, index) => [item.key, index]));
  if (position.size !== items.length) throw new AppError(400, "MENU_ITEM_INVALID", "Menü öğeleri tekrar ediyor.");
  items.forEach((item, index) => {
    if (!item.parentKey) return;
    const parentIndex = position.get(item.parentKey);
    if (parentIndex === undefined || parentIndex >= index) throw invalid(index, "Üst menü öğesi bulunamadı.");
    if (items[parentIndex].parentKey) throw invalid(index, `Menüler en fazla ${MAX_MENU_DEPTH} seviye olabilir.`);
  });

  const ids = (type: MenuItemType, field: "categoryId" | "collectionId" | "pageId") =>
    [...new Set(items.filter((item) => item.type === type && item[field]).map((item) => item[field]!))];
  const [categories, collections, pages] = await Promise.all([
    prisma.category.findMany({ where: { id: { in: ids("CATEGORY", "categoryId") }, deletedAt: null }, select: { id: true } }),
    prisma.collection.findMany({ where: { id: { in: ids("COLLECTION", "collectionId") }, deletedAt: null }, select: { id: true } }),
    prisma.page.findMany({ where: { id: { in: ids("PAGE", "pageId") }, deletedAt: null }, select: { id: true } }),
  ]);
  const known = new Set([...categories, ...collections, ...pages].map((row) => row.id));

  return items.map((item, index) => {
    const base = { key: item.key, parentKey: item.parentKey ?? null, type: item.type, label: item.label, openInNewTab: item.openInNewTab, isHidden: item.isHidden };
    const none = { categoryId: null, collectionId: null, pageId: null, pageKey: null, href: "" };
    switch (item.type) {
      case "CATEGORY":
        if (!item.categoryId || !known.has(item.categoryId)) throw invalid(index, "Bağlı kategori bulunamadı. Öğeyi menüden çıkarın.");
        return { ...base, ...none, categoryId: item.categoryId };
      case "COLLECTION":
        if (!item.collectionId || !known.has(item.collectionId)) throw invalid(index, "Bağlı koleksiyon bulunamadı. Öğeyi menüden çıkarın.");
        return { ...base, ...none, collectionId: item.collectionId };
      case "PAGE":
        if (item.pageKey) {
          if (!SYSTEM_BY_KEY.has(item.pageKey)) throw invalid(index, "Sayfa bulunamadı.");
          return { ...base, ...none, pageKey: item.pageKey };
        }
        if (!item.pageId || !known.has(item.pageId)) throw invalid(index, "Bağlı sayfa bulunamadı. Öğeyi menüden çıkarın.");
        return { ...base, ...none, pageId: item.pageId };
      case "CUSTOM": {
        const href = safeHref(item.url ?? "");
        if (!href) throw invalid(index, "Bağlantı güvenli değil. “/” ile başlayan site içi adres, https://, mailto: veya tel: kullanın.", "url");
        if (!item.label) throw invalid(index, "Özel bağlantı için görünen ad girin.", "label");
        return { ...base, ...none, href };
      }
    }
  });
}

/* ---------- Resolving items ---------- */

const itemInclude = {
  category: { select: { id: true, name: true, slug: true, isVisible: true, deletedAt: true } },
  collection: { select: { id: true, name: true, slug: true, isVisible: true, deletedAt: true } },
  page: { select: { id: true, title: true, slug: true, status: true, deletedAt: true, publishedRevisionId: true } },
} satisfies Prisma.MenuItemInclude;

type ItemRow = Prisma.MenuItemGetPayload<{ include: typeof itemInclude }>;

type Resolved = { name: string; href: string; problem: string | null };

async function visibleCategorySet() {
  const rows = await prisma.category.findMany({ where: { deletedAt: null }, select: { id: true, parentId: true, isVisible: true } });
  return visibleCategoryIds(rows);
}

/** Where the item points and why it cannot be shown in the store (null = fine). */
export function resolveItem(item: ItemRow, visibleCategories: Set<string>): Resolved {
  switch (item.type) {
    case "CATEGORY": {
      const category = item.category;
      if (!category || category.deletedAt) return { name: "", href: "", problem: "Bağlı kategori silinmiş." };
      const problem = visibleCategories.has(category.id) ? null : "Bağlı kategori mağazada gizli.";
      return { name: category.name, href: `/kategoriler/${category.slug}`, problem };
    }
    case "COLLECTION": {
      const collection = item.collection;
      if (!collection || collection.deletedAt) return { name: "", href: "", problem: "Bağlı koleksiyon silinmiş." };
      return { name: collection.name, href: `/koleksiyonlar/${collection.slug}`, problem: collection.isVisible ? null : "Bağlı koleksiyon mağazada gizli." };
    }
    case "PAGE": {
      if (item.pageKey) {
        const system = SYSTEM_BY_KEY.get(item.pageKey);
        return system ? { name: system.label, href: system.href, problem: null } : { name: "", href: "", problem: "Sayfa bulunamadı." };
      }
      const page = item.page;
      if (!page || page.deletedAt) return { name: "", href: "", problem: "Bağlı sayfa silinmiş." };
      const live = page.status === "PUBLISHED" && Boolean(page.publishedRevisionId);
      return { name: page.title, href: `/sayfa/${page.slug}`, problem: live ? null : "Bağlı sayfa yayında değil." };
    }
    default: {
      const href = safeHref(item.href);
      return { name: item.label, href: href ?? "", problem: href ? null : "Bağlantı güvenli değil." };
    }
  }
}

export type StoreMenuItem = { label: string; href: string; newTab: boolean; children: StoreMenuItem[] };

export async function storeMenu(menuId: string): Promise<StoreMenuItem[]> {
  const [rows, visibleCategories] = await Promise.all([
    prisma.menuItem.findMany({ where: { menuId }, include: itemInclude, orderBy: { sortOrder: "asc" } }),
    visibleCategorySet(),
  ]);
  const shown = (row: ItemRow) => {
    if (row.isHidden) return null;
    const resolved = resolveItem(row, visibleCategories);
    if (resolved.problem) return null;
    return { label: row.label || resolved.name, href: resolved.href, newTab: row.openInNewTab, children: [] as StoreMenuItem[] };
  };
  const top: StoreMenuItem[] = [];
  for (const row of rows.filter((item) => !item.parentId)) {
    const item = shown(row);
    if (!item) continue;
    item.children = rows.filter((child) => child.parentId === row.id).flatMap((child) => shown(child) ?? []);
    top.push(item);
  }
  return top;
}

/* ---------- Routes ---------- */

async function audit(actor: StaffSession, action: string, entityId: string, text: string, extra?: Record<string, unknown>) {
  await prisma.auditLog.create({ data: { actorId: actor.id, action, entityType: "menu", entityId, metadata: { text, ...extra } } });
}

async function uniqueKey(name: string) {
  const base = slugify(name);
  let key = base;
  for (let n = 2; await prisma.menu.findUnique({ where: { key } }); n += 1) key = `${base}-${n}`;
  return key;
}

const LOCATION_LABELS: Record<MenuLocation, string> = { HEADER: "Üst menü", FOOTER_1: "Footer sütun 1", FOOTER_2: "Footer sütun 2", FOOTER_3: "Footer sütun 3" };

async function saveItems(menuId: string, items: ItemInput[]) {
  const rows = await prepareItems(items);
  await prisma.$transaction(async (tx) => {
    await tx.menuItem.updateMany({ where: { menuId }, data: { parentId: null } });
    await tx.menuItem.deleteMany({ where: { menuId } });
    const idOf = new Map<string, string>();
    const order = new Map<string | null, number>();
    for (const row of rows) {
      const parentId = row.parentKey ? idOf.get(row.parentKey) ?? null : null;
      const sortOrder = order.get(parentId) ?? 0;
      order.set(parentId, sortOrder + 1);
      const created = await tx.menuItem.create({
        data: {
          menuId,
          parentId,
          sortOrder,
          type: row.type,
          label: row.label,
          href: row.href,
          categoryId: row.categoryId,
          collectionId: row.collectionId,
          pageId: row.pageId,
          pageKey: row.pageKey,
          openInNewTab: row.openInNewTab,
          isHidden: row.isHidden,
        },
      });
      idOf.set(row.key, created.id);
    }
  });
  return rows.length;
}

async function claimLocation(menuId: string, location: MenuLocation | null | undefined) {
  if (location === undefined) return;
  if (location) await prisma.menu.updateMany({ where: { location, id: { not: menuId } }, data: { location: null } });
  await prisma.menu.update({ where: { id: menuId }, data: { location } });
}

export function registerMenuRoutes(app: FastifyInstance, env: Env) {
  app.get("/api/v1/content/menus", async () => {
    const menus = await prisma.menu.findMany({ where: { location: { not: null } } });
    const data: Record<string, { name: string; items: StoreMenuItem[] } | null> = { HEADER: null, FOOTER_1: null, FOOTER_2: null, FOOTER_3: null };
    for (const menu of menus) data[menu.location!] = { name: menu.name, items: await storeMenu(menu.id) };
    return { data };
  });

  app.get("/api/v1/content/menus/:key", async (request) => {
    const { key } = parse(z.object({ key: z.string() }), request.params);
    const menu = await prisma.menu.findUnique({ where: { key } });
    if (!menu) throw notFound("Menü bulunamadı.");
    return { data: { key: menu.key, name: menu.name, items: await storeMenu(menu.id) } };
  });

  app.get("/api/v1/admin/menus", async (request) => {
    const staff = await requireStaff(request, env);
    const [menus, categories, collections, pages] = await Promise.all([
      prisma.menu.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { items: true } } } }),
      prisma.category.findMany({ where: { deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, parentId: true, isVisible: true } }),
      prisma.collection.findMany({ where: { deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, isVisible: true } }),
      prisma.page.findMany({ where: { deletedAt: null, slug: { not: HOME_EDITOR_SLUG } }, orderBy: { title: "asc" }, select: { id: true, title: true, status: true, publishedRevisionId: true } }),
    ]);
    return {
      data: menus.map((menu) => ({ id: menu.id, name: menu.name, location: menu.location, itemCount: menu._count.items })),
      meta: {
        canEdit: MENU_EDIT_ROLES.includes(staff.role),
        maxDepth: MAX_MENU_DEPTH,
        locations: MENU_LOCATIONS.map((value) => ({ value, label: LOCATION_LABELS[value] })),
        sources: {
          categories,
          collections,
          pages: [
            ...SYSTEM_PAGES.map((page) => ({ pageKey: page.key, pageId: null, title: page.label, live: true })),
            ...pages.map((page) => ({ pageKey: null, pageId: page.id, title: page.title, live: page.status === "PUBLISHED" && Boolean(page.publishedRevisionId) })),
          ],
        },
      },
    };
  });

  app.get("/api/v1/admin/menus/:id", async (request) => {
    await requireStaff(request, env);
    const { id } = parse(z.object({ id: z.string().min(1) }), request.params);
    const menu = await prisma.menu.findUnique({ where: { id } });
    if (!menu) throw notFound("Menü bulunamadı.");
    const [rows, visibleCategories] = await Promise.all([
      prisma.menuItem.findMany({ where: { menuId: id }, include: itemInclude, orderBy: { sortOrder: "asc" } }),
      visibleCategorySet(),
    ]);
    const tops = rows.filter((row) => !row.parentId);
    const ordered = tops.flatMap((top) => [top, ...rows.filter((row) => row.parentId === top.id)]);
    return {
      data: {
        id: menu.id,
        name: menu.name,
        location: menu.location,
        items: ordered.map((row) => {
          const resolved = resolveItem(row, visibleCategories);
          return {
            key: row.id,
            parentKey: row.parentId,
            type: row.type,
            categoryId: row.categoryId,
            collectionId: row.collectionId,
            pageId: row.pageId,
            pageKey: row.pageKey,
            url: row.type === "CUSTOM" ? row.href : null,
            label: row.label,
            defaultLabel: resolved.name,
            openInNewTab: row.openInNewTab,
            isHidden: row.isHidden,
            problem: resolved.problem,
          };
        }),
      },
    };
  });

  app.post("/api/v1/admin/menus", async (request) => {
    const staff = await requireStaff(request, env, MENU_EDIT_ROLES);
    const body = parse(menuBody, request.body);
    const menu = await prisma.menu.create({ data: { key: await uniqueKey(body.name), name: body.name } });
    await claimLocation(menu.id, body.location);
    if (body.items?.length) await saveItems(menu.id, body.items);
    await audit(staff, "menu.create", menu.id, `Menü oluşturuldu: ${menu.name}.`, { location: body.location ?? null });
    return { data: { id: menu.id } };
  });

  app.put("/api/v1/admin/menus/:id", async (request) => {
    const staff = await requireStaff(request, env, MENU_EDIT_ROLES);
    const { id } = parse(z.object({ id: z.string().min(1) }), request.params);
    const menu = await prisma.menu.findUnique({ where: { id } });
    if (!menu) throw notFound("Menü bulunamadı.");
    const body = parse(menuBody, request.body);
    const count = body.items ? await saveItems(id, body.items) : undefined;
    await prisma.menu.update({ where: { id }, data: { name: body.name } });
    await claimLocation(id, body.location);
    await audit(staff, "menu.update", id, `Menü güncellendi: ${body.name}.`, {
      previousName: menu.name,
      previousLocation: menu.location,
      location: body.location === undefined ? menu.location : body.location,
      itemCount: count,
    });
    return { data: { id } };
  });

  app.delete("/api/v1/admin/menus/:id", async (request) => {
    const staff = await requireStaff(request, env, MENU_EDIT_ROLES);
    const { id } = parse(z.object({ id: z.string().min(1) }), request.params);
    const menu = await prisma.menu.findUnique({ where: { id } });
    if (!menu) throw notFound("Menü bulunamadı.");
    await prisma.$transaction([
      prisma.menuItem.updateMany({ where: { menuId: id }, data: { parentId: null } }),
      prisma.menuItem.deleteMany({ where: { menuId: id } }),
      prisma.menu.delete({ where: { id } }),
    ]);
    await audit(staff, "menu.delete", id, `Menü silindi: ${menu.name}.`, { location: menu.location });
    return { data: { ok: true } };
  });
}
