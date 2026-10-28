import type { CollectionSort, Prisma, StaffRole } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireStaff, type StaffSession } from "../auth/staff";
import { AppError, notFound } from "../common/errors";
import { parse } from "../common/parse";
import type { Env } from "../config/env";
import { prisma } from "../db";
import { slugify } from "./admin";

export const TAXONOMY_EDIT_ROLES: StaffRole[] = ["OWNER", "ADMIN", "EDITOR"];
export const MAX_CATEGORY_DEPTH = 3;
const SAMPLE_SIZE = 5;
const PREVIEW_SIZE = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

function mediaUrl(id: string | null | undefined) {
  return id ? `/api/v1/media/${id}/file` : null;
}

/* ---------- Category tree rules ---------- */

export type TreeNode = { id: string; parentId: string | null };

/** Throws when the tree has a loop or a branch deeper than MAX_CATEGORY_DEPTH. */
export function assertValidTree(nodes: TreeNode[]) {
  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
  for (const node of nodes) {
    let depth = 1;
    let current = node.parentId;
    const seen = new Set([node.id]);
    while (current) {
      if (seen.has(current)) {
        throw new AppError(400, "CATEGORY_CYCLE", "Bir kategori kendi altına veya kendi alt kategorisinin altına taşınamaz.");
      }
      if (!parentOf.has(current)) throw new AppError(400, "PARENT_NOT_FOUND", "Üst kategori bulunamadı.");
      seen.add(current);
      depth += 1;
      current = parentOf.get(current) ?? null;
    }
    if (depth > MAX_CATEGORY_DEPTH) {
      throw new AppError(400, "CATEGORY_DEPTH", `Kategoriler en fazla ${MAX_CATEGORY_DEPTH} seviye olabilir.`);
    }
  }
}

export function descendantIds(nodes: TreeNode[], rootId: string) {
  const result = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (node.parentId && result.has(node.parentId) && !result.has(node.id)) {
        result.add(node.id);
        grew = true;
      }
    }
  }
  return [...result];
}

/** A category is visible only when it and all of its parents are visible. */
export function visibleCategoryIds(nodes: Array<TreeNode & { isVisible: boolean }>) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visible = new Set<string>();
  for (const node of nodes) {
    let current: (TreeNode & { isVisible: boolean }) | undefined = node;
    let ok = true;
    let guard = 0;
    while (current && guard++ <= MAX_CATEGORY_DEPTH + 1) {
      if (!current.isVisible) {
        ok = false;
        break;
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (ok) visible.add(node.id);
  }
  return visible;
}

async function liveCategories() {
  return prisma.category.findMany({
    where: { deletedAt: null },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

/* ---------- Automatic collection rules ---------- */

const ruleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("category"), categoryId: z.string({ required_error: "Kategori seçin." }).min(1, "Kategori seçin.") }),
  z.object({
    type: z.literal("price"),
    min: z.number().int().min(0, "Fiyat negatif olamaz.").nullable().optional(),
    max: z.number().int().min(0, "Fiyat negatif olamaz.").nullable().optional(),
  }),
  z.object({ type: z.literal("featured") }),
  z.object({ type: z.literal("onSale") }),
  z.object({ type: z.literal("newWithinDays"), days: z.number({ invalid_type_error: "Gün sayısı girin." }).int().min(1, "En az 1 gün olmalı.").max(3650, "En fazla 3650 gün olabilir.") }),
], { errorMap: () => ({ message: "Geçersiz kural." }) });

export const rulesSchema = z.array(ruleSchema).max(10, "En fazla 10 kural eklenebilir.").superRefine((rules, ctx) => {
  rules.forEach((rule, index) => {
    if (rule.type !== "price") return;
    if (rule.min == null && rule.max == null) ctx.addIssue({ code: "custom", path: [index], message: "Fiyat aralığı için en az bir sınır girin." });
    if (rule.min != null && rule.max != null && rule.min > rule.max) ctx.addIssue({ code: "custom", path: [index], message: "En düşük fiyat en yüksek fiyattan büyük olamaz." });
  });
});

export type CollectionRule = z.infer<typeof ruleSchema>;

export function readRules(value: Prisma.JsonValue | null | undefined): CollectionRule[] {
  const result = rulesSchema.safeParse(value ?? []);
  return result.success ? result.data : [];
}

/** All rules must match ("hepsi"). Category rules include the chosen category's sub-categories. */
export async function automaticProductWhere(rules: CollectionRule[], now = new Date()): Promise<Prisma.ProductWhereInput> {
  const nodes = rules.some((rule) => rule.type === "category") ? await liveCategories() : [];
  const parts: Prisma.ProductWhereInput[] = rules.map((rule) => {
    switch (rule.type) {
      case "category":
        return { categories: { some: { categoryId: { in: descendantIds(nodes, rule.categoryId) } } } };
      case "price":
        return {
          variants: {
            some: {
              deletedAt: null,
              isDefault: true,
              priceAmount: { ...(rule.min != null ? { gte: rule.min } : {}), ...(rule.max != null ? { lte: rule.max } : {}) },
            },
          },
        };
      case "featured":
        return { featured: true };
      case "onSale":
        return { variants: { some: { deletedAt: null, disabledAt: null, compareAtAmount: { gt: prisma.productVariant.fields.priceAmount } } } };
      case "newWithinDays":
        return { createdAt: { gte: new Date(now.getTime() - rule.days * DAY_MS) } };
    }
  });
  return parts.length ? { AND: parts } : { id: { in: [] } };
}

export async function collectionProductWhere(collection: { id: string; type: string; rules: Prisma.JsonValue | null }) {
  if (collection.type === "AUTOMATIC") return automaticProductWhere(readRules(collection.rules));
  return { collections: { some: { collectionId: collection.id } } } satisfies Prisma.ProductWhereInput;
}

export const STORE_PRODUCT_WHERE = { deletedAt: null, status: "ACTIVE" as const };

export function storeSortFor(collection: { type: string; productSort: CollectionSort }) {
  if (collection.productSort === "MANUAL") return collection.type === "MANUAL" ? "manual" : "newest";
  return ({ NEWEST: "newest", PRICE_ASC: "price_asc", PRICE_DESC: "price_desc" } as const)[collection.productSort];
}

/** Product ids in display order; used when the order cannot be expressed as a simple orderBy. */
export async function orderedProductIds(where: Prisma.ProductWhereInput, sort: "manual" | "price_asc" | "price_desc", collectionId?: string) {
  if (sort === "manual" && collectionId) {
    const rows = await prisma.productCollection.findMany({
      where: { collectionId, product: where },
      orderBy: [{ sortOrder: "asc" }, { product: { createdAt: "desc" } }],
      select: { productId: true },
    });
    return rows.map((row) => row.productId);
  }
  const priced = await prisma.product.findMany({
    where,
    select: { id: true, createdAt: true, variants: { where: { deletedAt: null, isDefault: true }, select: { priceAmount: true }, take: 1 } },
  });
  priced.sort((a, b) => {
    const ap = a.variants[0]?.priceAmount ?? 0;
    const bp = b.variants[0]?.priceAmount ?? 0;
    return sort === "price_desc" ? bp - ap : ap - bp;
  });
  return priced.map((row) => row.id);
}

/* ---------- Shared helpers ---------- */

const seoSchema = z.object({
  title: z.string().trim().max(70, "Google başlığı en fazla 70 karakter olabilir.").nullable().optional(),
  description: z.string().trim().max(180, "Google açıklaması en fazla 180 karakter olabilir.").nullable().optional(),
}).optional();

const baseBody = {
  name: z.string({ required_error: "Ad girin." }).trim().min(2, "Ad en az 2 karakter olmalı.").max(80, "Ad en fazla 80 karakter olabilir."),
  slug: z.string().trim().max(80, "Sayfa adresi en fazla 80 karakter olabilir.").optional(),
  description: z.string().trim().max(2000, "Açıklama en fazla 2000 karakter olabilir.").optional(),
  imageMediaId: z.string().min(1).nullable().optional(),
  isVisible: z.boolean().optional(),
  seo: seoSchema,
};

const categoryBody = z.object({ ...baseBody, parentId: z.string().min(1).nullable().optional() });

const collectionBody = z.object({
  ...baseBody,
  type: z.enum(["MANUAL", "AUTOMATIC"]).optional(),
  productSort: z.enum(["MANUAL", "NEWEST", "PRICE_ASC", "PRICE_DESC"]).optional(),
  rules: rulesSchema.optional(),
  productIds: z.array(z.string().min(1)).max(500, "Bir koleksiyona en fazla 500 ürün eklenebilir.").optional(),
});

type Kind = "category" | "collection";
const LABEL: Record<Kind, string> = { category: "kategori", collection: "koleksiyon" };

async function slugTaken(kind: Kind, slug: string, ignoreId?: string) {
  const where = { slug, ...(ignoreId ? { id: { not: ignoreId } } : {}) };
  return kind === "category" ? Boolean(await prisma.category.findFirst({ where })) : Boolean(await prisma.collection.findFirst({ where }));
}

async function resolveSlug(kind: Kind, raw: string | undefined, name: string, ignoreId?: string) {
  if (raw) {
    const slug = slugify(raw);
    if (await slugTaken(kind, slug, ignoreId)) {
      throw new AppError(409, "SLUG_TAKEN", `Bu sayfa adresi başka bir ${LABEL[kind]}da kullanılıyor.`, [{ path: "slug", message: "Bu sayfa adresi kullanılıyor." }]);
    }
    return slug;
  }
  const base = slugify(name);
  let slug = base;
  for (let n = 2; await slugTaken(kind, slug, ignoreId); n += 1) slug = `${base}-${n}`;
  return slug;
}

async function assertMedia(id: string | null | undefined) {
  if (!id) return;
  const found = await prisma.media.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!found) throw new AppError(400, "MEDIA_NOT_FOUND", "Seçilen görsel Medya Kütüphanesinde bulunamadı.");
}

async function saveSeo(kind: Kind, entityId: string, seo: z.infer<typeof seoSchema>) {
  if (!seo) return;
  const data = { title: seo.title || null, description: seo.description || null };
  await prisma.seoMetadata.upsert({
    where: { entityType_entityId: { entityType: kind, entityId } },
    update: data,
    create: { entityType: kind, entityId, ...data },
  });
}

async function seoMap(kind: Kind, ids: string[]) {
  if (!ids.length) return new Map<string, { title: string | null; description: string | null }>();
  const rows = await prisma.seoMetadata.findMany({ where: { entityType: kind, entityId: { in: ids } } });
  return new Map(rows.map((row) => [row.entityId, { title: row.title, description: row.description }]));
}

async function audit(actor: StaffSession, action: string, entityType: Kind, entityId: string, text: string, extra?: Record<string, unknown>) {
  await prisma.auditLog.create({ data: { actorId: actor.id, action, entityType, entityId, metadata: { text, ...extra } } });
}

function changedFields<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  return Object.keys(after).filter((key) => after[key] !== undefined && JSON.stringify(after[key]) !== JSON.stringify(before[key]));
}

const productSample = {
  id: true,
  name: true,
  status: true,
  images: { orderBy: { sortOrder: "asc" as const }, take: 1, select: { mediaId: true } },
  variants: { where: { deletedAt: null, isDefault: true }, take: 1, select: { priceAmount: true } },
} satisfies Prisma.ProductSelect;

function sampleRow(row: Prisma.ProductGetPayload<{ select: typeof productSample }>) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    priceAmount: row.variants[0]?.priceAmount ?? null,
    imageUrl: mediaUrl(row.images[0]?.mediaId),
  };
}

/* ---------- Routes ---------- */

const idParams = z.object({ id: z.string().min(1) });

export function registerTaxonomyRoutes(app: FastifyInstance, env: Env) {
  /* Store */

  app.get("/api/v1/catalog/categories", async () => {
    const rows = await liveCategories();
    const visible = visibleCategoryIds(rows);
    return {
      data: rows.filter((row) => visible.has(row.id)).map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        parentId: row.parentId,
        imageUrl: mediaUrl(row.imageMediaId),
      })),
    };
  });

  app.get("/api/v1/catalog/categories/:slug", async (request) => {
    const { slug } = parse(z.object({ slug: z.string() }), request.params);
    const rows = await liveCategories();
    const category = rows.find((row) => row.slug === slug);
    if (!category || !visibleCategoryIds(rows).has(category.id)) throw notFound("Kategori bulunamadı.");
    const seo = await prisma.seoMetadata.findUnique({ where: { entityType_entityId: { entityType: "category", entityId: category.id } } });
    return {
      data: { id: category.id, slug: category.slug, name: category.name, description: category.description, imageUrl: mediaUrl(category.imageMediaId), seo },
    };
  });

  app.get("/api/v1/catalog/collections", async () => {
    const rows = await prisma.collection.findMany({ where: { deletedAt: null, isVisible: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
    return {
      data: rows.map((row) => ({ id: row.id, slug: row.slug, name: row.name, description: row.description, imageUrl: mediaUrl(row.imageMediaId) })),
    };
  });

  app.get("/api/v1/catalog/collections/:slug", async (request) => {
    const { slug } = parse(z.object({ slug: z.string() }), request.params);
    const collection = await prisma.collection.findFirst({ where: { slug, deletedAt: null, isVisible: true } });
    if (!collection) throw notFound("Koleksiyon bulunamadı.");
    const seo = await prisma.seoMetadata.findUnique({ where: { entityType_entityId: { entityType: "collection", entityId: collection.id } } });
    return {
      data: {
        id: collection.id,
        slug: collection.slug,
        name: collection.name,
        description: collection.description,
        imageUrl: mediaUrl(collection.imageMediaId),
        sort: storeSortFor(collection),
        seo,
      },
    };
  });

  /* Admin: categories */

  app.get("/api/v1/admin/categories", async (request) => {
    const staff = await requireStaff(request, env);
    const rows = await liveCategories();
    const [counts, seo] = await Promise.all([
      prisma.productCategory.groupBy({ by: ["categoryId"], where: { product: { deletedAt: null } }, _count: { _all: true } }),
      seoMap("category", rows.map((row) => row.id)),
    ]);
    const countOf = new Map(counts.map((row) => [row.categoryId, row._count._all]));
    return {
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        parentId: row.parentId,
        sortOrder: row.sortOrder,
        isVisible: row.isVisible,
        imageMediaId: row.imageMediaId,
        imageUrl: mediaUrl(row.imageMediaId),
        productCount: countOf.get(row.id) ?? 0,
        seo: seo.get(row.id) ?? { title: null, description: null },
      })),
      meta: { canEdit: TAXONOMY_EDIT_ROLES.includes(staff.role), maxDepth: MAX_CATEGORY_DEPTH },
    };
  });

  app.get("/api/v1/admin/categories/:id/products", async (request) => {
    await requireStaff(request, env);
    const { id } = parse(idParams, request.params);
    const where = { deletedAt: null, categories: { some: { categoryId: id } } };
    const [total, rows] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({ where, orderBy: { name: "asc" }, take: SAMPLE_SIZE, select: productSample }),
    ]);
    return { data: rows.map(sampleRow), meta: { total } };
  });

  app.post("/api/v1/admin/categories", async (request) => {
    const staff = await requireStaff(request, env, TAXONOMY_EDIT_ROLES);
    const body = parse(categoryBody, request.body);
    await assertMedia(body.imageMediaId);
    const nodes = await liveCategories();
    const parentId = body.parentId ?? null;
    if (parentId && !nodes.some((node) => node.id === parentId)) throw new AppError(400, "PARENT_NOT_FOUND", "Üst kategori bulunamadı.");
    assertValidTree([...nodes, { id: "__new__", parentId }]);
    const slug = await resolveSlug("category", body.slug, body.name);
    const last = await prisma.category.aggregate({ where: { parentId, deletedAt: null }, _max: { sortOrder: true } });
    const category = await prisma.category.create({
      data: {
        name: body.name,
        slug,
        description: body.description ?? "",
        parentId,
        imageMediaId: body.imageMediaId ?? null,
        isVisible: body.isVisible ?? true,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
    });
    await saveSeo("category", category.id, body.seo);
    await audit(staff, "category.create", "category", category.id, `Kategori oluşturuldu: ${category.name}.`);
    return { data: { id: category.id, slug: category.slug } };
  });

  app.patch("/api/v1/admin/categories/:id", async (request) => {
    const staff = await requireStaff(request, env, TAXONOMY_EDIT_ROLES);
    const { id } = parse(idParams, request.params);
    const body = parse(categoryBody, request.body);
    const nodes = await liveCategories();
    const current = nodes.find((node) => node.id === id);
    if (!current) throw notFound("Kategori bulunamadı.");
    await assertMedia(body.imageMediaId);
    const parentId = body.parentId === undefined ? current.parentId : body.parentId;
    if (parentId !== current.parentId) {
      assertValidTree(nodes.map((node) => (node.id === id ? { id, parentId } : node)));
    }
    const slug = body.slug !== undefined && body.slug !== current.slug ? await resolveSlug("category", body.slug, body.name, id) : current.slug;
    const next = {
      name: body.name,
      slug,
      description: body.description ?? current.description,
      parentId,
      imageMediaId: body.imageMediaId === undefined ? current.imageMediaId : body.imageMediaId,
      isVisible: body.isVisible ?? current.isVisible,
    };
    const changes = changedFields(current as unknown as Record<string, unknown>, next);
    let sortOrder = current.sortOrder;
    if (parentId !== current.parentId) {
      const last = await prisma.category.aggregate({ where: { parentId, deletedAt: null }, _max: { sortOrder: true } });
      sortOrder = (last._max.sortOrder ?? -1) + 1;
    }
    await prisma.category.update({ where: { id }, data: { ...next, sortOrder } });
    await saveSeo("category", id, body.seo);
    await audit(staff, "category.update", "category", id, `Kategori güncellendi: ${next.name}.`, { changes: [...changes, ...(body.seo ? ["seo"] : [])] });
    return { data: { id, slug } };
  });

  app.put("/api/v1/admin/categories/tree", async (request) => {
    const staff = await requireStaff(request, env, TAXONOMY_EDIT_ROLES);
    const body = parse(
      z.object({ items: z.array(z.object({ id: z.string().min(1), parentId: z.string().min(1).nullable(), sortOrder: z.number().int().min(0) })).max(1000) }),
      request.body,
    );
    const nodes = await liveCategories();
    const known = new Set(nodes.map((node) => node.id));
    if (body.items.some((item) => !known.has(item.id))) throw notFound("Kategori bulunamadı.");
    const moved = new Map(body.items.map((item) => [item.id, item]));
    assertValidTree(nodes.map((node) => ({ id: node.id, parentId: moved.has(node.id) ? moved.get(node.id)!.parentId : node.parentId })));
    await prisma.$transaction(body.items.map((item) => prisma.category.update({ where: { id: item.id }, data: { parentId: item.parentId, sortOrder: item.sortOrder } })));
    await audit(staff, "category.reorder", "category", "tree", "Kategori sıralaması güncellendi.", {
      moved: body.items.filter((item) => nodes.find((node) => node.id === item.id)?.parentId !== item.parentId).map((item) => item.id),
    });
    return { data: { ok: true } };
  });

  app.delete("/api/v1/admin/categories/:id", async (request) => {
    const staff = await requireStaff(request, env, TAXONOMY_EDIT_ROLES);
    const { id } = parse(idParams, request.params);
    const category = await prisma.category.findFirst({ where: { id, deletedAt: null } });
    if (!category) throw notFound("Kategori bulunamadı.");
    const [products, children] = await Promise.all([
      prisma.product.count({ where: { deletedAt: null, categories: { some: { categoryId: id } } } }),
      prisma.category.count({ where: { parentId: id, deletedAt: null } }),
    ]);
    if (products || children) {
      const reasons = [
        products ? `${products} ürün` : "",
        children ? `${children} alt kategori` : "",
      ].filter(Boolean).join(" ve ");
      throw new AppError(409, "CATEGORY_NOT_EMPTY", `Bu kategoride ${reasons} var. Önce bunları başka bir kategoriye taşıyın.`);
    }
    await prisma.$transaction([
      prisma.category.updateMany({ where: { parentId: id }, data: { parentId: null } }),
      prisma.seoMetadata.deleteMany({ where: { entityType: "category", entityId: id } }),
      prisma.category.delete({ where: { id } }),
    ]);
    await audit(staff, "category.delete", "category", id, `Kategori silindi: ${category.name}.`, { slug: category.slug });
    return { data: { ok: true } };
  });

  /* Admin: collections */

  app.get("/api/v1/admin/collections", async (request) => {
    const staff = await requireStaff(request, env);
    const rows = await prisma.collection.findMany({ where: { deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
    const seo = await seoMap("collection", rows.map((row) => row.id));
    const data = [];
    for (const row of rows) {
      const where = { ...STORE_PRODUCT_WHERE, ...(await collectionProductWhere(row)) };
      data.push({
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        sortOrder: row.sortOrder,
        isVisible: row.isVisible,
        type: row.type,
        productSort: row.productSort,
        rules: readRules(row.rules),
        imageMediaId: row.imageMediaId,
        imageUrl: mediaUrl(row.imageMediaId),
        productCount: await prisma.product.count({ where }),
        seo: seo.get(row.id) ?? { title: null, description: null },
      });
    }
    return { data, meta: { canEdit: TAXONOMY_EDIT_ROLES.includes(staff.role) } };
  });

  app.get("/api/v1/admin/collections/:id/products", async (request) => {
    await requireStaff(request, env);
    const { id } = parse(idParams, request.params);
    const rows = await prisma.productCollection.findMany({
      where: { collectionId: id, product: { deletedAt: null } },
      orderBy: [{ sortOrder: "asc" }, { product: { createdAt: "desc" } }],
      select: { product: { select: productSample } },
    });
    return { data: rows.map((row) => sampleRow(row.product)) };
  });

  app.post("/api/v1/admin/collections/preview", async (request) => {
    await requireStaff(request, env);
    const body = parse(z.object({ rules: rulesSchema, productSort: z.enum(["MANUAL", "NEWEST", "PRICE_ASC", "PRICE_DESC"]).optional() }), request.body);
    const where = { ...STORE_PRODUCT_WHERE, ...(await automaticProductWhere(body.rules)) };
    const sort = storeSortFor({ type: "AUTOMATIC", productSort: body.productSort ?? "NEWEST" });
    const total = await prisma.product.count({ where });
    let rows;
    if (sort === "newest") {
      rows = await prisma.product.findMany({ where, orderBy: { createdAt: "desc" }, take: PREVIEW_SIZE, select: productSample });
    } else {
      const ids = (await orderedProductIds(where, sort)).slice(0, PREVIEW_SIZE);
      const found = await prisma.product.findMany({ where: { id: { in: ids } }, select: productSample });
      rows = ids.flatMap((pid) => found.filter((row) => row.id === pid));
    }
    return { data: rows.map(sampleRow), meta: { total } };
  });

  app.post("/api/v1/admin/collections", async (request) => {
    const staff = await requireStaff(request, env, TAXONOMY_EDIT_ROLES);
    const body = parse(collectionBody, request.body);
    const fields = await collectionFields(body, null);
    const slug = await resolveSlug("collection", body.slug, body.name);
    const last = await prisma.collection.aggregate({ where: { deletedAt: null }, _max: { sortOrder: true } });
    const collection = await prisma.collection.create({ data: { ...fields, slug, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
    if (fields.type === "MANUAL" && body.productIds) await replaceProducts(collection.id, body.productIds);
    await saveSeo("collection", collection.id, body.seo);
    await audit(staff, "collection.create", "collection", collection.id, `Koleksiyon oluşturuldu: ${collection.name}.`);
    return { data: { id: collection.id, slug } };
  });

  app.patch("/api/v1/admin/collections/:id", async (request) => {
    const staff = await requireStaff(request, env, TAXONOMY_EDIT_ROLES);
    const { id } = parse(idParams, request.params);
    const current = await prisma.collection.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw notFound("Koleksiyon bulunamadı.");
    const body = parse(collectionBody, request.body);
    const fields = await collectionFields(body, current);
    const slug = body.slug !== undefined && body.slug !== current.slug ? await resolveSlug("collection", body.slug, body.name, id) : current.slug;
    const changes = changedFields(current as unknown as Record<string, unknown>, { ...fields, slug });
    await prisma.collection.update({ where: { id }, data: { ...fields, slug } });
    if (fields.type === "MANUAL" && body.productIds) {
      await replaceProducts(id, body.productIds);
      changes.push("products");
    }
    await saveSeo("collection", id, body.seo);
    await audit(staff, "collection.update", "collection", id, `Koleksiyon güncellendi: ${fields.name}.`, { changes: [...changes, ...(body.seo ? ["seo"] : [])] });
    return { data: { id, slug } };
  });

  app.put("/api/v1/admin/collections/order", async (request) => {
    const staff = await requireStaff(request, env, TAXONOMY_EDIT_ROLES);
    const { ids } = parse(z.object({ ids: z.array(z.string().min(1)).max(1000) }), request.body);
    const found = await prisma.collection.count({ where: { id: { in: ids }, deletedAt: null } });
    if (found !== new Set(ids).size) throw notFound("Koleksiyon bulunamadı.");
    await prisma.$transaction(ids.map((cid, sortOrder) => prisma.collection.update({ where: { id: cid }, data: { sortOrder } })));
    await audit(staff, "collection.reorder", "collection", "order", "Koleksiyon sıralaması güncellendi.");
    return { data: { ok: true } };
  });

  app.delete("/api/v1/admin/collections/:id", async (request) => {
    const staff = await requireStaff(request, env, TAXONOMY_EDIT_ROLES);
    const { id } = parse(idParams, request.params);
    const collection = await prisma.collection.findFirst({ where: { id, deletedAt: null } });
    if (!collection) throw notFound("Koleksiyon bulunamadı.");
    await prisma.$transaction([
      prisma.productCollection.deleteMany({ where: { collectionId: id } }),
      prisma.seoMetadata.deleteMany({ where: { entityType: "collection", entityId: id } }),
      prisma.collection.delete({ where: { id } }),
    ]);
    await audit(staff, "collection.delete", "collection", id, `Koleksiyon silindi: ${collection.name}.`, { slug: collection.slug });
    return { data: { ok: true } };
  });
}

async function collectionFields(
  body: z.infer<typeof collectionBody>,
  current: { type: "MANUAL" | "AUTOMATIC"; productSort: CollectionSort; rules: Prisma.JsonValue | null; description: string; imageMediaId: string | null; isVisible: boolean } | null,
) {
  await assertMedia(body.imageMediaId);
  const type = body.type ?? current?.type ?? "MANUAL";
  const rules = body.rules ?? (current ? readRules(current.rules) : []);
  if (type === "AUTOMATIC" && rules.length === 0) {
    throw new AppError(400, "RULES_REQUIRED", "Otomatik koleksiyon için en az bir kural ekleyin.", [{ path: "rules", message: "En az bir kural ekleyin." }]);
  }
  const categoryIds = rules.flatMap((rule) => (rule.type === "category" ? [rule.categoryId] : []));
  if (categoryIds.length) {
    const found = await prisma.category.count({ where: { id: { in: categoryIds }, deletedAt: null } });
    if (found !== new Set(categoryIds).size) throw new AppError(400, "CATEGORY_NOT_FOUND", "Kuraldaki kategori bulunamadı.");
  }
  let productSort = body.productSort ?? current?.productSort ?? "MANUAL";
  if (type === "AUTOMATIC" && productSort === "MANUAL") productSort = "NEWEST";
  return {
    name: body.name,
    description: body.description ?? current?.description ?? "",
    imageMediaId: body.imageMediaId === undefined ? current?.imageMediaId ?? null : body.imageMediaId,
    isVisible: body.isVisible ?? current?.isVisible ?? true,
    type,
    productSort,
    rules: (type === "AUTOMATIC" ? rules : rules.length ? rules : undefined) as Prisma.InputJsonValue | undefined,
  };
}

async function replaceProducts(collectionId: string, productIds: string[]) {
  const ids = [...new Set(productIds)];
  const found = await prisma.product.count({ where: { id: { in: ids }, deletedAt: null } });
  if (found !== ids.length) throw new AppError(400, "PRODUCT_NOT_FOUND", "Seçilen ürünlerden biri bulunamadı.");
  await prisma.$transaction([
    prisma.productCollection.deleteMany({ where: { collectionId } }),
    prisma.productCollection.createMany({ data: ids.map((productId, sortOrder) => ({ productId, collectionId, sortOrder })) }),
  ]);
}
