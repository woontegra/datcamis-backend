import type { Prisma, ProductStatus } from "@prisma/client";
import { Prisma as PrismaNs } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireStaff, type StaffSession } from "../auth/staff";
import { AppError, notFound } from "../common/errors";
import { parse } from "../common/parse";
import type { Env } from "../config/env";
import { prisma } from "../db";
import {
  PRODUCT_CONTENT_ROLES,
  PRODUCT_VIEW_ROLES,
  canArchiveProduct,
  canEditProductContent,
  canEditProductPrice,
  canEditProductStock,
} from "./roles";
import { publicProductInclude, serializeProduct } from "./serialize";

const PRODUCT_STATUSES = ["DRAFT", "ACTIVE", "DISABLED", "ARCHIVED"] as const;

function slugify(value: string) {
  return value
    .toLocaleLowerCase("tr-TR")
    .replaceAll("ı", "i")
    .replaceAll("ğ", "g")
    .replaceAll("ü", "u")
    .replaceAll("ş", "s")
    .replaceAll("ö", "o")
    .replaceAll("ç", "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "urun";
}

async function uniqueSlug(base: string, ignoreId?: string) {
  let slug = slugify(base);
  let n = 2;
  while (await prisma.product.findFirst({ where: { slug, ...(ignoreId ? { id: { not: ignoreId } } : {}) } })) {
    slug = `${slugify(base)}-${n}`;
    n += 1;
  }
  return slug;
}

async function uniqueSku(base: string, ignoreId?: string) {
  let sku = base.trim().toUpperCase().replace(/[^A-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "SKU";
  const root = sku;
  let n = 2;
  while (await prisma.productVariant.findFirst({ where: { sku, ...(ignoreId ? { id: { not: ignoreId } } : {}) } })) {
    sku = `${root}-${n}`;
    n += 1;
  }
  return sku;
}

function assertCompareAt(priceAmount: number, compareAtAmount: number | null | undefined) {
  if (compareAtAmount == null) return;
  if (!Number.isInteger(compareAtAmount) || compareAtAmount <= priceAmount) {
    throw new AppError(400, "COMPARE_AT_INVALID", "İndirim öncesi fiyat, satış fiyatından yüksek olmalıdır.");
  }
}

function parseDesi(value: unknown) {
  if (value == null || value === "") return null;
  const raw = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  if (!Number.isFinite(raw) || raw < 0) throw new AppError(400, "DESI_INVALID", "Desi sıfır veya pozitif bir sayı olmalıdır.");
  return new PrismaNs.Decimal(raw.toFixed(2));
}

const imageInput = z.object({
  mediaId: z.string().min(1),
  alt: z.string().trim().max(200).optional().nullable(),
  sortOrder: z.number().int().min(0).optional(),
});

const variantInput = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(80),
  sku: z.string().trim().min(1).max(80),
  barcode: z.string().trim().max(80).optional().nullable(),
  priceAmount: z.number().int().min(0),
  compareAtAmount: z.number().int().positive().optional().nullable(),
  weightGrams: z.number().int().min(0).optional().nullable(),
  desi: z.union([z.number(), z.string(), z.null()]).optional(),
  position: z.number().int().min(0).optional(),
  mediaId: z.string().min(1).optional().nullable(),
  isDefault: z.boolean().optional(),
  disabled: z.boolean().optional(),
  lowThreshold: z.number().int().min(0).optional(),
});

const productBody = z.object({
  name: z.string().trim().min(2).max(160),
  slug: z.string().trim().max(80).optional(),
  summary: z.string().trim().max(400).optional().default(""),
  description: z.string().trim().max(8000).optional().default(""),
  content: z.string().trim().max(20000).optional().default(""),
  usageNotes: z.string().trim().max(8000).optional().default(""),
  warningNotes: z.string().trim().max(8000).optional().default(""),
  featured: z.boolean().optional(),
  vatRate: z.number().int().min(0).max(100).optional().nullable(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  categoryIds: z.array(z.string().min(1)).optional(),
  collectionIds: z.array(z.string().min(1)).optional(),
  images: z.array(imageInput).optional(),
  variants: z.array(variantInput).optional(),
  seo: z
    .object({
      title: z.string().trim().max(70).optional().nullable(),
      description: z.string().trim().max(180).optional().nullable(),
      robotsIndex: z.boolean().optional(),
      ogMediaId: z.string().min(1).optional().nullable(),
    })
    .optional(),
});

async function writeAudit(actor: StaffSession, action: string, entityId: string, text: string, extra?: Record<string, unknown>) {
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action,
      entityType: "product",
      entityId,
      metadata: { text, ...extra },
    },
  });
}

async function loadProduct(id: string) {
  const product = await prisma.product.findFirst({
    where: { id, deletedAt: null },
    include: publicProductInclude,
  });
  if (!product) throw notFound("Ürün bulunamadı.");
  return product;
}

async function history(productId: string) {
  const rows = await prisma.auditLog.findMany({
    where: { entityType: "product", entityId: productId },
    orderBy: { createdAt: "desc" },
    take: 40,
    include: { actor: { select: { name: true } } },
  });
  return rows.map((row) => {
    const meta = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? (row.metadata as Record<string, unknown>) : {};
    return {
      action: row.action,
      text: typeof meta.text === "string" ? meta.text : row.action,
      actorName: row.actor?.name ?? "Sistem",
      createdAt: row.createdAt,
    };
  });
}

function listWhere(query: { q?: string; category?: string; status?: string; stock?: string }) {
  const where: Prisma.ProductWhereInput = { deletedAt: null };
  if (query.status && PRODUCT_STATUSES.includes(query.status as ProductStatus)) where.status = query.status as ProductStatus;
  else where.status = { not: "ARCHIVED" };
  if (query.q) {
    where.OR = [
      { name: { contains: query.q, mode: "insensitive" } },
      { variants: { some: { sku: { contains: query.q, mode: "insensitive" } } } },
    ];
  }
  if (query.category) where.categories = { some: { categoryId: query.category } };
  return where;
}

function stockFlag(onHand: number, reserved: number, lowThreshold: number) {
  const available = onHand - reserved;
  if (available <= 0) return "out";
  if (available <= lowThreshold) return "low";
  return "ok";
}

async function syncRelations(productId: string, body: z.infer<typeof productBody>, role: StaffSession["role"]) {
  if (body.categoryIds) {
    await prisma.productCategory.deleteMany({ where: { productId } });
    if (body.categoryIds.length) {
      await prisma.productCategory.createMany({ data: body.categoryIds.map((categoryId) => ({ productId, categoryId })) });
    }
  }
  if (body.collectionIds) {
    await prisma.productCollection.deleteMany({ where: { productId } });
    if (body.collectionIds.length) {
      await prisma.productCollection.createMany({
        data: body.collectionIds.map((collectionId, sortOrder) => ({ productId, collectionId, sortOrder })),
      });
    }
  }
  if (body.images) {
    await prisma.productImage.deleteMany({ where: { productId } });
    for (const [index, image] of body.images.entries()) {
      await prisma.productImage.create({
        data: { productId, mediaId: image.mediaId, alt: image.alt ?? null, sortOrder: image.sortOrder ?? index },
      });
    }
  }
  if (body.seo) {
    await prisma.seoMetadata.upsert({
      where: { entityType_entityId: { entityType: "product", entityId: productId } },
      update: {
        title: body.seo.title ?? null,
        description: body.seo.description ?? null,
        robotsIndex: body.seo.robotsIndex ?? true,
        ogMediaId: body.seo.ogMediaId ?? null,
        canonicalPath: `/urunler/${(await prisma.product.findUniqueOrThrow({ where: { id: productId } })).slug}`,
      },
      create: {
        entityType: "product",
        entityId: productId,
        title: body.seo.title ?? null,
        description: body.seo.description ?? null,
        robotsIndex: body.seo.robotsIndex ?? true,
        ogMediaId: body.seo.ogMediaId ?? null,
      },
    });
  }
  if (body.variants && canEditProductPrice(role)) {
    const keep: string[] = [];
    for (const [index, variant] of body.variants.entries()) {
      assertCompareAt(variant.priceAmount, variant.compareAtAmount);
      const sku = await uniqueSku(variant.sku, variant.id);
      const data = {
        name: variant.name,
        sku,
        barcode: variant.barcode ?? null,
        priceAmount: variant.priceAmount,
        compareAtAmount: variant.compareAtAmount ?? null,
        weightGrams: variant.weightGrams ?? null,
        desi: parseDesi(variant.desi),
        position: variant.position ?? index,
        mediaId: variant.mediaId ?? null,
        isDefault: variant.isDefault ?? index === 0,
        disabledAt: variant.disabled ? new Date() : null,
      };
      if (variant.id) {
        const existing = await prisma.productVariant.findFirst({ where: { id: variant.id, productId } });
        if (!existing) throw new AppError(400, "VARIANT_UNKNOWN", "Varyant bu ürüne ait değil.");
        await prisma.productVariant.update({ where: { id: variant.id }, data });
        if (variant.lowThreshold != null) {
          await prisma.inventoryItem.updateMany({ where: { variantId: variant.id }, data: { lowThreshold: variant.lowThreshold } });
        }
        keep.push(variant.id);
      } else {
        const created = await prisma.productVariant.create({
          data: { ...data, productId, inventory: { create: { onHand: 0, lowThreshold: variant.lowThreshold ?? 5 } } },
        });
        keep.push(created.id);
      }
    }
    const extras = await prisma.productVariant.findMany({ where: { productId, deletedAt: null, id: { notIn: keep } } });
    for (const extra of extras) {
      const ordered = await prisma.orderItem.count({ where: { variantId: extra.id } });
      if (ordered > 0) await prisma.productVariant.update({ where: { id: extra.id }, data: { deletedAt: new Date(), disabledAt: new Date() } });
      else await prisma.productVariant.delete({ where: { id: extra.id } });
    }
  }
}

export function registerProductAdminRoutes(app: FastifyInstance, env: Env) {
  app.get("/api/v1/admin/products", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_VIEW_ROLES);
    const query = parse(
      z.object({
        q: z.string().trim().max(120).optional(),
        category: z.string().trim().max(80).optional(),
        status: z.enum([...PRODUCT_STATUSES, ""]).optional(),
        stock: z.enum(["out", "low", ""]).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(20),
        sort: z.enum(["name", "newest", "price", "stock"]).default("name"),
      }),
      request.query,
    );
    const where = listWhere(query);
    const rows = await prisma.product.findMany({ where, include: publicProductInclude });
    const mapped = rows.map((row) => {
      const serialized = serializeProduct(row, true);
      const stocks = row.variants.map((variant) => stockFlag(variant.inventory?.onHand ?? 0, variant.inventory?.reserved ?? 0, variant.inventory?.lowThreshold ?? 0));
      const prices = row.variants.filter((variant) => !variant.disabledAt).map((variant) => variant.priceAmount);
      const totalStock = row.variants.reduce((sum, variant) => sum + Math.max(0, (variant.inventory?.onHand ?? 0) - (variant.inventory?.reserved ?? 0)), 0);
      return {
        ...serialized,
        variantCount: row.variants.filter((variant) => !variant.disabledAt).length,
        priceMin: prices.length ? Math.min(...prices) : 0,
        priceMax: prices.length ? Math.max(...prices) : 0,
        totalStock,
        stockFlag: stocks.includes("out") ? "out" : stocks.includes("low") ? "low" : "ok",
        categoryName: serialized.categories.map((item) => item.name).join(", "),
        image: serialized.images[0] ?? null,
      };
    });
    const filtered = query.stock ? mapped.filter((row) => row.stockFlag === query.stock) : mapped;
    filtered.sort((a, b) => {
      if (query.sort === "newest") return 0;
      if (query.sort === "price") return a.priceMin - b.priceMin;
      if (query.sort === "stock") return a.totalStock - b.totalStock;
      return a.name.localeCompare(b.name, "tr");
    });
    if (query.sort === "newest") {
      filtered.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    }
    const total = filtered.length;
    const pageRows = filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
    return {
      data: pageRows,
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        canEdit: canEditProductContent(staff.role),
        canPrice: canEditProductPrice(staff.role),
        canStock: canEditProductStock(staff.role),
        canArchive: canArchiveProduct(staff.role),
      },
    };
  });

  app.get("/api/v1/admin/products/:id", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_VIEW_ROLES);
    const { id } = parse(z.object({ id: z.string().min(1) }), request.params);
    const product = await loadProduct(id);
    const seo = await prisma.seoMetadata.findUnique({ where: { entityType_entityId: { entityType: "product", entityId: id } } });
    return {
      data: {
        ...serializeProduct(product, true),
        seo,
        history: await history(id),
        permissions: {
          canEdit: canEditProductContent(staff.role),
          canPrice: canEditProductPrice(staff.role),
          canStock: canEditProductStock(staff.role),
          canArchive: canArchiveProduct(staff.role),
        },
      },
    };
  });

  app.post("/api/v1/admin/products", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_CONTENT_ROLES);
    if (!canEditProductPrice(staff.role)) throw new AppError(403, "FORBIDDEN", "Yeni ürün oluşturma yetkiniz yok.");
    const body = parse(productBody, request.body);
    if (!body.variants?.length) throw new AppError(400, "VARIANT_REQUIRED", "En az bir varyant gerekli.");
    const slug = await uniqueSlug(body.slug || body.name);
    const product = await prisma.product.create({
      data: {
        name: body.name,
        slug,
        summary: body.summary,
        description: body.description,
        content: body.content,
        usageNotes: body.usageNotes,
        warningNotes: body.warningNotes,
        featured: body.featured ?? false,
        vatRate: body.vatRate ?? null,
        status: body.status === "ARCHIVED" && !canArchiveProduct(staff.role) ? "DRAFT" : body.status ?? "DRAFT",
      },
    });
    await syncRelations(product.id, body, staff.role);
    await writeAudit(staff, "product.create", product.id, `Ürün oluşturuldu: ${body.name}.`);
    const loaded = await loadProduct(product.id);
    return { data: serializeProduct(loaded, true) };
  });

  app.patch("/api/v1/admin/products/:id", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_CONTENT_ROLES);
    const { id } = parse(z.object({ id: z.string().min(1) }), request.params);
    const body = parse(productBody, request.body);
    const current = await loadProduct(id);
    if (body.status === "ARCHIVED" && !canArchiveProduct(staff.role)) {
      throw new AppError(403, "FORBIDDEN", "Arşivleme yetkiniz yok.");
    }
    const slug = body.slug ? await uniqueSlug(body.slug, id) : current.slug;
    const pricePatch = canEditProductPrice(staff.role)
      ? { featured: body.featured ?? current.featured, vatRate: body.vatRate === undefined ? current.vatRate : body.vatRate }
      : {};
    await prisma.product.update({
      where: { id },
      data: {
        name: body.name,
        slug,
        summary: body.summary,
        description: body.description,
        content: body.content,
        usageNotes: body.usageNotes,
        warningNotes: body.warningNotes,
        status: body.status ?? current.status,
        ...pricePatch,
      },
    });
    await syncRelations(id, { ...body, variants: canEditProductPrice(staff.role) ? body.variants : undefined }, staff.role);
    await writeAudit(staff, "product.update", id, `Ürün güncellendi: ${body.name}.`, { status: body.status ?? current.status });
    return { data: serializeProduct(await loadProduct(id), true), history: await history(id) };
  });

  app.post("/api/v1/admin/products/:id/stock", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_VIEW_ROLES);
    if (!canEditProductStock(staff.role)) throw new AppError(403, "FORBIDDEN", "Stok değiştirme yetkiniz yok.");
    const { id } = parse(z.object({ id: z.string().min(1) }), request.params);
    const body = parse(
      z.object({
        variantId: z.string().min(1),
        action: z.enum(["in", "out", "adjust"]),
        quantity: z.number().int().min(0),
        reason: z.string().trim().min(2).max(200),
      }),
      request.body,
    );
    const variant = await prisma.productVariant.findFirst({
      where: { id: body.variantId, productId: id, deletedAt: null },
      include: { inventory: true },
    });
    if (!variant?.inventory) throw notFound("Varyant bulunamadı.");
    const inventory = variant.inventory;
    await prisma.$transaction(async (tx) => {
      if (body.action === "in") {
        if (body.quantity < 1) throw new AppError(400, "STOCK_QTY", "Eklenecek adet 1 veya daha büyük olmalı.");
        await tx.inventoryItem.update({ where: { id: inventory.id }, data: { onHand: { increment: body.quantity } } });
        await tx.stockMovement.create({
          data: { inventoryItemId: inventory.id, type: "IN", quantity: body.quantity, reason: body.reason, referenceType: "product", referenceId: id, createdById: staff.id },
        });
      } else if (body.action === "out") {
        if (body.quantity < 1) throw new AppError(400, "STOCK_QTY", "Düşülecek adet 1 veya daha büyük olmalı.");
        const updated = await tx.$executeRaw`
          UPDATE "inventory_items" SET "onHand" = "onHand" - ${body.quantity}, "updatedAt" = NOW()
          WHERE "id" = ${inventory.id} AND "onHand" >= ${body.quantity}
        `;
        if (Number(updated) !== 1) throw new AppError(409, "INSUFFICIENT_STOCK", "Stok bu düşüş için yetersiz.");
        await tx.stockMovement.create({
          data: { inventoryItemId: inventory.id, type: "OUT", quantity: body.quantity, reason: body.reason, referenceType: "product", referenceId: id, createdById: staff.id },
        });
      } else {
        const diff = body.quantity - inventory.onHand;
        await tx.inventoryItem.update({ where: { id: inventory.id }, data: { onHand: body.quantity } });
        await tx.stockMovement.create({
          data: {
            inventoryItemId: inventory.id,
            type: "ADJUSTMENT",
            quantity: Math.abs(diff),
            reason: body.reason,
            referenceType: "product",
            referenceId: id,
            createdById: staff.id,
          },
        });
      }
    });
    await writeAudit(staff, "product.stock", id, `Stok ${body.action}: ${variant.sku} / ${body.quantity}. ${body.reason}`);
    return { data: serializeProduct(await loadProduct(id), true) };
  });

  app.post("/api/v1/admin/products/:id/copy", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_CONTENT_ROLES);
    if (!canEditProductPrice(staff.role)) throw new AppError(403, "FORBIDDEN", "Ürün kopyalama yetkiniz yok.");
    const { id } = parse(z.object({ id: z.string().min(1) }), request.params);
    const source = await loadProduct(id);
    const slug = await uniqueSlug(`${source.slug}-kopya`);
    const copy = await prisma.product.create({
      data: {
        name: `${source.name} (kopya)`,
        slug,
        summary: source.summary,
        description: source.description,
        content: source.content,
        usageNotes: source.usageNotes,
        warningNotes: source.warningNotes,
        featured: false,
        vatRate: source.vatRate,
        status: "DRAFT",
        categories: { create: source.categories.map((row) => ({ categoryId: row.categoryId })) },
        collections: { create: source.collections.map((row) => ({ collectionId: row.collectionId, sortOrder: row.sortOrder })) },
        images: { create: source.images.map((image) => ({ mediaId: image.mediaId, alt: image.alt, sortOrder: image.sortOrder })) },
      },
    });
    for (const variant of source.variants) {
      const sku = await uniqueSku(`${variant.sku}-KOPYA`);
      await prisma.productVariant.create({
        data: {
          productId: copy.id,
          name: variant.name,
          sku,
          barcode: variant.barcode,
          priceAmount: variant.priceAmount,
          compareAtAmount: variant.compareAtAmount,
          weightGrams: variant.weightGrams,
          desi: variant.desi,
          position: variant.position,
          mediaId: variant.mediaId,
          isDefault: variant.isDefault,
          disabledAt: variant.disabledAt,
          inventory: { create: { onHand: 0, lowThreshold: variant.inventory?.lowThreshold ?? 5 } },
        },
      });
    }
    await writeAudit(staff, "product.copy", copy.id, `Ürün kopyalandı: ${source.name} → ${copy.name}.`, { sourceId: source.id });
    return { data: serializeProduct(await loadProduct(copy.id), true) };
  });

  app.post("/api/v1/admin/products/bulk", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_CONTENT_ROLES);
    const body = parse(
      z.object({
        ids: z.array(z.string().min(1)).min(1).max(50),
        status: z.enum(["ACTIVE", "DISABLED", "ARCHIVED"]),
      }),
      request.body,
    );
    if (body.status === "ARCHIVED" && !canArchiveProduct(staff.role)) {
      throw new AppError(403, "FORBIDDEN", "Arşivleme yetkiniz yok.");
    }
    const result = await prisma.product.updateMany({
      where: { id: { in: body.ids }, deletedAt: null },
      data: { status: body.status },
    });
    for (const id of body.ids) {
      await writeAudit(staff, "product.bulk", id, `Toplu durum: ${body.status}.`);
    }
    return { data: { updated: result.count } };
  });

  app.delete("/api/v1/admin/products/:id", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_CONTENT_ROLES);
    if (!canArchiveProduct(staff.role)) throw new AppError(403, "FORBIDDEN", "Arşivleme yetkiniz yok.");
    const { id } = parse(z.object({ id: z.string().min(1) }), request.params);
    const product = await loadProduct(id);
    const ordered = await prisma.orderItem.count({ where: { variant: { productId: id } } });
    if (ordered > 0) {
      await prisma.product.update({ where: { id }, data: { status: "ARCHIVED" } });
      await writeAudit(staff, "product.archive", id, "Siparişi olan ürün arşivlendi; kalıcı silinmedi.");
      throw new AppError(409, "PRODUCT_HAS_ORDERS", "Siparişi bulunan ürün kalıcı silinemez; arşivlendi.");
    }
    await prisma.product.update({ where: { id }, data: { status: "ARCHIVED" } });
    await writeAudit(staff, "product.archive", id, `Ürün arşivlendi: ${product.name}.`);
    return { data: { archived: true } };
  });
}
