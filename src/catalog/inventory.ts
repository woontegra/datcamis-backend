import { createHash } from "node:crypto";
import type { Prisma, ProductStatus } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireStaff, type StaffSession } from "../auth/staff";
import { AppError } from "../common/errors";
import { parse } from "../common/parse";
import type { Env } from "../config/env";
import { prisma } from "../db";
import { HAVALE_STOCK_REASON, STOCK_CAPTURE_REASON } from "../orders/stock";
import { canEditProductPrice, canEditProductStock, PRODUCT_PRICE_ROLES, PRODUCT_STOCK_ROLES, PRODUCT_VIEW_ROLES } from "./roles";

type Tx = Prisma.TransactionClient;

/* ---------- Stock changes (shared with the product form) ---------- */

export type StockAction = "in" | "out" | "adjust";

/**
 * Applies one stock change and records it. "out" never takes stock below zero.
 * When expectedOnHand is given, the change only happens if nobody else changed the stock meanwhile.
 */
export async function applyStockChange(
  tx: Tx,
  input: {
    inventoryId: string;
    action: StockAction;
    quantity: number;
    reason: string;
    expectedOnHand?: number;
    referenceType?: string;
    referenceId?: string;
    createdById?: string;
  },
) {
  const rows = await tx.$queryRaw<Array<{ onHand: number }>>`SELECT "onHand" FROM "inventory_items" WHERE "id" = ${input.inventoryId} FOR UPDATE`;
  if (!rows.length) throw new AppError(404, "NOT_FOUND", "Stok kaydı bulunamadı.");
  const before = rows[0].onHand;
  if (input.expectedOnHand !== undefined && before !== input.expectedOnHand) {
    throw new AppError(409, "STOCK_CHANGED", "Stok bu arada değişti.", [{ path: input.inventoryId, message: String(before) }]);
  }
  if (input.action !== "adjust" && input.quantity < 1) {
    throw new AppError(400, "STOCK_QTY", input.action === "in" ? "Eklenecek adet 1 veya daha büyük olmalı." : "Düşülecek adet 1 veya daha büyük olmalı.");
  }
  if (input.quantity < 0) throw new AppError(400, "STOCK_QTY", "Adet negatif olamaz.");
  const after = input.action === "in" ? before + input.quantity : input.action === "out" ? before - input.quantity : input.quantity;
  if (after < 0) throw new AppError(409, "INSUFFICIENT_STOCK", "Stok sıfırın altına düşemez.");
  await tx.inventoryItem.update({ where: { id: input.inventoryId }, data: { onHand: after } });
  const delta = after - before;
  await tx.stockMovement.create({
    data: {
      inventoryItemId: input.inventoryId,
      type: input.action === "in" ? "IN" : input.action === "out" ? "OUT" : "ADJUSTMENT",
      quantity: Math.abs(input.action === "adjust" ? delta : input.quantity),
      delta,
      balanceAfter: after,
      reason: input.reason,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      createdById: input.createdById ?? null,
    },
  });
  return { before, after, delta };
}

/* ---------- Reasons ---------- */

export const STOCK_REASONS = {
  production: "Yeni üretim",
  count: "Sayım düzeltmesi",
  damage: "Hasarlı/fire",
  return: "İade",
  other: "Diğer",
} as const;
type ReasonCode = keyof typeof STOCK_REASONS;

const ORDER_REASON_LABELS: Record<string, string> = {
  [STOCK_CAPTURE_REASON]: "Sipariş (online ödeme)",
  [HAVALE_STOCK_REASON]: "Sipariş (havale)",
  order_cancel: "Sipariş iptali",
  order_return: "Sipariş iadesi",
};

function reasonText(code: ReasonCode, note: string) {
  const label = STOCK_REASONS[code];
  return note ? `${label} — ${note}` : label;
}

function reasonWhere(code: string): Prisma.StockMovementWhereInput {
  if (code === "order") return { referenceType: "order" };
  if (code === "other") {
    return {
      referenceType: { not: "order" },
      NOT: (["production", "count", "damage", "return"] as const).map((key) => ({ reason: { startsWith: STOCK_REASONS[key] } })),
    };
  }
  const label = STOCK_REASONS[code as ReasonCode];
  return label ? { reason: { startsWith: label } } : {};
}

/* ---------- Prices ---------- */

const MAX_PRICE = 100_000_000;

export function priceProblem(priceAmount: number, compareAtAmount: number | null) {
  if (!Number.isInteger(priceAmount) || priceAmount <= 0) return "Satış fiyatı sıfırdan büyük olmalı.";
  if (priceAmount > MAX_PRICE) return "Satış fiyatı çok yüksek.";
  if (compareAtAmount != null && (!Number.isInteger(compareAtAmount) || compareAtAmount <= priceAmount)) {
    return "İndirim öncesi fiyat, satış fiyatından yüksek olmalı.";
  }
  return null;
}

export type BulkPriceInput = { mode: "percent" | "amount"; direction: "increase" | "decrease"; value: number; includeCompareAt: boolean };

/** Rounded to whole kuruş. */
export function bulkPrice(amount: number, input: BulkPriceInput) {
  const sign = input.direction === "increase" ? 1 : -1;
  if (input.mode === "percent") return Math.round(amount * (1 + (sign * input.value) / 100));
  return Math.round(amount + sign * input.value);
}

/* ---------- Shared shapes ---------- */

const variantInclude = {
  inventory: true,
  media: { select: { id: true, deletedAt: true } },
  product: {
    select: {
      id: true,
      name: true,
      status: true,
      images: { orderBy: { sortOrder: "asc" as const }, take: 1, select: { mediaId: true, media: { select: { deletedAt: true } } } },
    },
  },
} satisfies Prisma.ProductVariantInclude;

type VariantRow = Prisma.ProductVariantGetPayload<{ include: typeof variantInclude }>;

function imageUrl(row: VariantRow) {
  if (row.media && !row.media.deletedAt) return `/api/v1/media/${row.media.id}/file`;
  const first = row.product.images[0];
  return first && !first.media.deletedAt ? `/api/v1/media/${first.mediaId}/file` : null;
}

function stockState(onHand: number, reserved: number, lowThreshold: number) {
  const available = onHand - reserved;
  if (available <= 0) return "out" as const;
  if (available <= lowThreshold) return "low" as const;
  return "ok" as const;
}

const PRODUCT_STATUSES: ProductStatus[] = ["DRAFT", "ACTIVE", "DISABLED", "ARCHIVED"];

/** The category and all of its subcategories. */
async function categoryTree(categoryId: string) {
  const all = await prisma.category.findMany({ where: { deletedAt: null }, select: { id: true, parentId: true } });
  const ids = new Set([categoryId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of all) {
      if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) {
        ids.add(row.id);
        grew = true;
      }
    }
  }
  return [...ids];
}

async function variantWhere(query: { q?: string; category?: string; status?: string }): Promise<Prisma.ProductVariantWhereInput> {
  const product: Prisma.ProductWhereInput = { deletedAt: null };
  const where: Prisma.ProductVariantWhereInput = { deletedAt: null, product };
  if (query.status === "VARIANT_OFF") where.disabledAt = { not: null };
  else if (query.status && PRODUCT_STATUSES.includes(query.status as ProductStatus)) product.status = query.status as ProductStatus;
  else product.status = { not: "ARCHIVED" };
  if (query.category) product.categories = { some: { categoryId: { in: await categoryTree(query.category) } } };
  if (query.q) {
    where.OR = [
      { product: { name: { contains: query.q, mode: "insensitive" } } },
      { name: { contains: query.q, mode: "insensitive" } },
      { sku: { contains: query.q, mode: "insensitive" } },
      { barcode: { contains: query.q, mode: "insensitive" } },
    ];
  }
  return where;
}

const variantOrder: Prisma.ProductVariantOrderByWithRelationInput[] = [{ product: { name: "asc" } }, { position: "asc" }, { name: "asc" }];

async function audit(actor: StaffSession, action: string, entityType: string, text: string, extra: Record<string, unknown>) {
  await prisma.auditLog.create({ data: { actorId: actor.id, action, entityType, entityId: null, metadata: { text, ...extra } as Prisma.InputJsonValue } });
}

/** Rows covered by a "select everything matching the filter" action. */
const MAX_FILTER_ROWS = 5000;

function fingerprint(parts: string[]) {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

const stockFilter = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  state: z.enum(["all", "out", "low"]).optional(),
});
type StockFilter = z.infer<typeof stockFilter>;

type StockIndexRow = { id: string; sku: string; label: string; inventoryId: string | null; onHand: number; lowThreshold: number; state: ReturnType<typeof stockState> };

/** Every matching variant, lightest columns only, ordered: out of stock, then low, then the rest. */
async function stockIndex(filter: StockFilter): Promise<StockIndexRow[]> {
  const rows = await prisma.productVariant.findMany({
    where: await variantWhere({ q: filter.q, category: filter.category }),
    select: {
      id: true,
      sku: true,
      name: true,
      product: { select: { name: true } },
      inventory: { select: { id: true, onHand: true, reserved: true, lowThreshold: true } },
    },
    orderBy: variantOrder,
  });
  const rank = { out: 0, low: 1, ok: 2 } as const;
  const items = rows
    .map((row) => {
      const onHand = row.inventory?.onHand ?? 0;
      const lowThreshold = row.inventory?.lowThreshold ?? 0;
      return {
        id: row.id,
        sku: row.sku,
        label: `${row.product.name} · ${row.name}`,
        inventoryId: row.inventory?.id ?? null,
        onHand,
        lowThreshold,
        state: stockState(onHand, row.inventory?.reserved ?? 0, lowThreshold),
      };
    })
    .sort((a, b) => rank[a.state] - rank[b.state]);
  return filter.state && filter.state !== "all" ? items.filter((item) => item.state === filter.state) : items;
}

/* ---------- Routes ---------- */

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  status: z.string().trim().max(20).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const bulkBody = z.object({
  ids: z.array(z.string().min(1)).min(1, "En az bir varyant seçin.").max(500).optional(),
  filter: z.object({
    q: z.string().trim().max(120).optional(),
    category: z.string().trim().max(80).optional(),
    status: z.string().trim().max(20).optional(),
  }).optional(),
  mode: z.enum(["percent", "amount"]),
  direction: z.enum(["increase", "decrease"]),
  value: z.number({ invalid_type_error: "Değer girin." }).positive("Değer sıfırdan büyük olmalı."),
  includeCompareAt: z.boolean().default(true),
  apply: z.boolean().default(false),
  fingerprint: z.string().max(64).optional(),
}).refine((body) => Boolean(body.ids) !== Boolean(body.filter), { message: "Varyant listesi veya filtre gönderin.", path: ["ids"] });

const stockOperation = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stock"),
    action: z.enum(["in", "out", "count"]),
    quantity: z.number({ invalid_type_error: "Adet girin." }).int("Adet tam sayı olmalı.").min(0, "Adet negatif olamaz.").max(1_000_000),
    reason: z.enum(["production", "count", "damage", "return", "other"]),
    note: z.string().trim().max(160).default(""),
  }),
  z.object({ type: z.literal("threshold"), lowThreshold: z.number().int().min(0).max(1_000_000) }),
]);

const bulkStockBody = z.object({
  filter: stockFilter.default({}),
  operation: stockOperation,
  apply: z.boolean().default(false),
  fingerprint: z.string().max(64).optional(),
});

type StockPlanRow = StockIndexRow & { status: "apply" | "skip" | "same" | "missing"; after: number };

function planStock(rows: StockIndexRow[], operation: z.infer<typeof stockOperation>): StockPlanRow[] {
  return rows.map((row) => {
    if (!row.inventoryId) return { ...row, status: "missing", after: row.onHand };
    if (operation.type === "threshold") {
      return { ...row, status: row.lowThreshold === operation.lowThreshold ? "same" : "apply", after: operation.lowThreshold };
    }
    const after = operation.action === "in" ? row.onHand + operation.quantity : operation.action === "out" ? row.onHand - operation.quantity : operation.quantity;
    if (after < 0) return { ...row, status: "skip", after };
    return { ...row, status: after === row.onHand ? "same" : "apply", after };
  });
}

function stockPlanSummary(plan: StockPlanRow[]) {
  const count = (status: StockPlanRow["status"]) => plan.filter((row) => row.status === status).length;
  return {
    matched: plan.length,
    applicable: count("apply"),
    skipped: count("skip"),
    unchanged: count("same"),
    missing: count("missing"),
    skippedRows: plan.filter((row) => row.status === "skip").slice(0, 8).map((row) => ({ id: row.id, label: row.label, sku: row.sku, onHand: row.onHand })),
  };
}

const stockFingerprint = (rows: StockIndexRow[]) => fingerprint(rows.map((row) => `${row.id}:${row.onHand}:${row.lowThreshold}`));

const stockBody = z.object({
  items: z.array(z.object({
    variantId: z.string().min(1),
    action: z.enum(["in", "out", "count"]),
    quantity: z.number({ invalid_type_error: "Adet girin." }).int("Adet tam sayı olmalı.").min(0, "Adet negatif olamaz.").max(1_000_000),
    reason: z.enum(["production", "count", "damage", "return", "other"]),
    note: z.string().trim().max(160).default(""),
    expectedOnHand: z.number().int().min(0),
  })).max(500).default([]),
  thresholds: z.array(z.object({ variantId: z.string().min(1), lowThreshold: z.number().int().min(0).max(1_000_000) })).max(500).default([]),
});

export function registerInventoryRoutes(app: FastifyInstance, env: Env) {
  /* Variants */

  app.get("/api/v1/admin/variants", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_VIEW_ROLES);
    const query = parse(listQuery, request.query);
    const where = await variantWhere(query);
    const [total, rows] = await prisma.$transaction([
      prisma.productVariant.count({ where }),
      prisma.productVariant.findMany({ where, include: variantInclude, orderBy: variantOrder, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ]);
    return {
      data: rows.map((row) => ({
        id: row.id,
        productId: row.product.id,
        productName: row.product.name,
        productStatus: row.product.status,
        name: row.name,
        sku: row.sku,
        barcode: row.barcode,
        priceAmount: row.priceAmount,
        compareAtAmount: row.compareAtAmount,
        onHand: row.inventory?.onHand ?? 0,
        stock: stockState(row.inventory?.onHand ?? 0, row.inventory?.reserved ?? 0, row.inventory?.lowThreshold ?? 0),
        disabled: Boolean(row.disabledAt),
        imageUrl: imageUrl(row),
      })),
      meta: { page: query.page, pageSize: query.pageSize, total, canEditPrice: canEditProductPrice(staff.role) },
    };
  });

  app.put("/api/v1/admin/variants/prices", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_PRICE_ROLES);
    const body = parse(
      z.object({
        items: z.array(z.object({
          id: z.string().min(1),
          priceAmount: z.number().int(),
          compareAtAmount: z.number().int().nullable(),
        })).min(1).max(500),
      }),
      request.body,
    );
    const ids = body.items.map((item) => item.id);
    const current = await prisma.productVariant.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, sku: true, priceAmount: true, compareAtAmount: true } });
    const byId = new Map(current.map((row) => [row.id, row]));
    const problems = body.items.flatMap((item) => {
      if (!byId.has(item.id)) return [{ path: item.id, message: "Varyant bulunamadı." }];
      const problem = priceProblem(item.priceAmount, item.compareAtAmount);
      return problem ? [{ path: item.id, message: problem }] : [];
    });
    if (problems.length) throw new AppError(400, "PRICE_INVALID", problems[0].message, problems);
    const changes = body.items
      .map((item) => ({ item, before: byId.get(item.id)! }))
      .filter(({ item, before }) => item.priceAmount !== before.priceAmount || item.compareAtAmount !== before.compareAtAmount);
    await prisma.$transaction(changes.map(({ item }) => prisma.productVariant.update({ where: { id: item.id }, data: { priceAmount: item.priceAmount, compareAtAmount: item.compareAtAmount } })));
    if (changes.length) {
      await audit(staff, "variant.prices", "variant", `${changes.length} varyantın fiyatı güncellendi.`, {
        changes: changes.map(({ item, before }) => ({
          sku: before.sku,
          price: [before.priceAmount, item.priceAmount],
          compareAt: [before.compareAtAmount, item.compareAtAmount],
        })),
      });
    }
    return { data: { changed: changes.length } };
  });

  app.post("/api/v1/admin/variants/bulk-price", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_PRICE_ROLES);
    const body = parse(bulkBody, request.body);
    if (body.mode === "percent" && body.direction === "decrease" && body.value >= 100) {
      throw new AppError(400, "PRICE_INVALID", "Yüzde düşüş 100'den küçük olmalı; fiyat sıfır veya negatif olamaz.");
    }
    const where = body.filter ? await variantWhere(body.filter) : { id: { in: body.ids! }, deletedAt: null };
    const rows = await prisma.productVariant.findMany({
      where,
      include: { product: { select: { name: true } } },
      orderBy: variantOrder,
      take: MAX_FILTER_ROWS + 1,
    });
    if (rows.length > MAX_FILTER_ROWS) throw new AppError(400, "TOO_MANY_ROWS", `Tek seferde en fazla ${MAX_FILTER_ROWS} varyant güncellenebilir; filtreyi daraltın.`);
    const priceFingerprint = fingerprint(rows.map((row) => `${row.id}:${row.priceAmount}:${row.compareAtAmount ?? ""}`));
    const preview = rows.map((row) => {
      const priceAmount = bulkPrice(row.priceAmount, body);
      const compareAtAmount = row.compareAtAmount != null && body.includeCompareAt ? bulkPrice(row.compareAtAmount, body) : row.compareAtAmount;
      return {
        id: row.id,
        productName: row.product.name,
        name: row.name,
        sku: row.sku,
        before: { priceAmount: row.priceAmount, compareAtAmount: row.compareAtAmount },
        after: { priceAmount, compareAtAmount },
        problem: priceProblem(priceAmount, compareAtAmount),
      };
    });
    const problems = preview.filter((row) => row.problem).map((row) => ({ path: row.id, message: `${row.productName} · ${row.name}: ${row.problem}` }));
    // A filter can match thousands of rows: send problem rows first and only a short sample.
    const shown = body.filter ? [...preview.filter((row) => row.problem), ...preview.filter((row) => !row.problem)].slice(0, 20) : preview;
    const meta = { total: preview.length, problems: problems.length, fingerprint: priceFingerprint };
    if (!body.apply) return { data: shown, meta };
    if (!preview.length) throw new AppError(400, "NOTHING_TO_SAVE", "Filtreye uyan varyant yok.");
    if (body.filter && body.fingerprint !== priceFingerprint) {
      throw new AppError(409, "PRICE_CHANGED", "Bu arada fiyatlar veya eşleşen varyantlar değişti; önizleme yenilendi, tekrar kontrol edip onaylayın.");
    }
    if (problems.length) throw new AppError(400, "PRICE_INVALID", `${problems.length} varyantta kural ihlali var; uygulanmadı.`, problems.slice(0, 50));
    await prisma.$transaction(async (tx) => {
      for (const row of preview) await tx.productVariant.update({ where: { id: row.id }, data: row.after });
    }, { timeout: 120_000, maxWait: 10_000 });
    await audit(staff, "variant.bulk-price", "variant", `Toplu fiyat güncellemesi: ${preview.length} varyant.`, {
      rows: preview.length,
      scope: body.filter ? { filter: body.filter } : "selection",
      rule: { mode: body.mode, direction: body.direction, value: body.value, includeCompareAt: body.includeCompareAt },
      changes: preview.map((row) => ({ sku: row.sku, price: [row.before.priceAmount, row.after.priceAmount], compareAt: [row.before.compareAtAmount, row.after.compareAtAmount] })),
    });
    return { data: shown, meta: { ...meta, problems: 0, applied: preview.length } };
  });

  /* Stock */

  app.get("/api/v1/admin/stock", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_VIEW_ROLES);
    const query = parse(
      stockFilter.extend({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
      }),
      request.query,
    );
    const filtered = Boolean(query.q || query.category || (query.state && query.state !== "all"));
    const index = await stockIndex(query);
    const everything = filtered ? await stockIndex({}) : index;
    const pageIds = index.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map((row) => row.id);
    const rows = await prisma.productVariant.findMany({ where: { id: { in: pageIds } }, include: variantInclude });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = pageIds.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      const onHand = row.inventory?.onHand ?? 0;
      const reserved = row.inventory?.reserved ?? 0;
      const lowThreshold = row.inventory?.lowThreshold ?? 0;
      return [{
        variantId: row.id,
        productId: row.product.id,
        productName: row.product.name,
        name: row.name,
        sku: row.sku,
        onHand,
        reserved,
        lowThreshold,
        state: stockState(onHand, reserved, lowThreshold),
        imageUrl: imageUrl(row),
      }];
    });
    return {
      data: items,
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: index.length,
        canEdit: canEditProductStock(staff.role),
        summary: {
          out: everything.filter((item) => item.state === "out").length,
          low: everything.filter((item) => item.state === "low").length,
          totalUnits: everything.reduce((sum, item) => sum + item.onHand, 0),
        },
        reasons: Object.entries(STOCK_REASONS).map(([value, label]) => ({ value, label })),
      },
    };
  });

  app.post("/api/v1/admin/stock/batch", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_STOCK_ROLES);
    const body = parse(stockBody, request.body);
    if (!body.items.length && !body.thresholds.length) throw new AppError(400, "NOTHING_TO_SAVE", "Kaydedilecek değişiklik yok.");
    const variantIds = [...new Set([...body.items.map((item) => item.variantId), ...body.thresholds.map((item) => item.variantId)])];
    if (new Set(body.items.map((item) => item.variantId)).size !== body.items.length) {
      throw new AppError(400, "DUPLICATE_ROW", "Aynı varyant için tek işlem girilebilir.");
    }
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: variantIds }, deletedAt: null },
      select: { id: true, sku: true, name: true, product: { select: { name: true } }, inventory: { select: { id: true } } },
    });
    const byId = new Map(variants.map((row) => [row.id, row]));
    const label = (id: string) => {
      const row = byId.get(id);
      return row ? `${row.product.name} · ${row.name}` : "Varyant";
    };

    const problems: Array<{ path: string; message: string }> = [];
    for (const item of body.items) {
      if (!byId.get(item.variantId)?.inventory) problems.push({ path: item.variantId, message: `${label(item.variantId)}: stok kaydı bulunamadı.` });
      else if (item.action !== "count" && item.quantity < 1) problems.push({ path: item.variantId, message: `${label(item.variantId)}: adet 1 veya daha büyük olmalı.` });
      else if (item.action === "out" && item.quantity > item.expectedOnHand) problems.push({ path: item.variantId, message: `${label(item.variantId)}: stok sıfırın altına düşemez.` });
      else if (item.reason === "other" && !item.note) problems.push({ path: item.variantId, message: `${label(item.variantId)}: “Diğer” için kısa bir not yazın.` });
    }
    for (const item of body.thresholds) {
      if (!byId.get(item.variantId)?.inventory) problems.push({ path: item.variantId, message: `${label(item.variantId)}: stok kaydı bulunamadı.` });
    }
    if (problems.length) throw new AppError(400, "STOCK_INVALID", problems[0].message, problems);

    const applied: Array<{ sku: string; action: string; before: number; after: number; reason: string }> = [];
    try {
      await prisma.$transaction(async (tx) => {
        const conflicts: Array<{ path: string; message: string }> = [];
        for (const item of body.items) {
          const inventoryId = byId.get(item.variantId)!.inventory!.id;
          const [row] = await tx.$queryRaw<Array<{ onHand: number }>>`SELECT "onHand" FROM "inventory_items" WHERE "id" = ${inventoryId} FOR UPDATE`;
          if (row.onHand !== item.expectedOnHand) {
            conflicts.push({ path: item.variantId, message: `${label(item.variantId)}: ekranda ${item.expectedOnHand} görünüyordu, şu an ${row.onHand}.` });
          }
        }
        if (conflicts.length) {
          throw new AppError(409, "STOCK_CHANGED", "Bu arada bazı stoklar değişti (örneğin sipariş geldi). Güncel değerlere bakıp tekrar kaydedin; hiçbir değişiklik uygulanmadı.", conflicts);
        }
        for (const item of body.items) {
          const reason = reasonText(item.reason, item.note);
          const result = await applyStockChange(tx, {
            inventoryId: byId.get(item.variantId)!.inventory!.id,
            action: item.action === "count" ? "adjust" : item.action,
            quantity: item.quantity,
            expectedOnHand: item.expectedOnHand,
            reason,
            referenceType: "stock",
            createdById: staff.id,
          });
          applied.push({ sku: byId.get(item.variantId)!.sku, action: item.action, before: result.before, after: result.after, reason });
        }
        for (const item of body.thresholds) {
          await tx.inventoryItem.update({ where: { variantId: item.variantId }, data: { lowThreshold: item.lowThreshold } });
        }
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "INSUFFICIENT_STOCK") {
        throw new AppError(409, "INSUFFICIENT_STOCK", "Stok sıfırın altına düşemez; hiçbir değişiklik uygulanmadı.");
      }
      throw error;
    }
    await audit(staff, "stock.batch", "stock", `Toplu stok kaydı: ${variantIds.length} satır (${applied.length} stok işlemi, ${body.thresholds.length} kritik eşik).`, {
      rows: variantIds.length,
      movements: applied,
      thresholds: body.thresholds.map((item) => ({ sku: byId.get(item.variantId)!.sku, lowThreshold: item.lowThreshold })),
    });
    return { data: { movements: applied.length, thresholds: body.thresholds.length } };
  });

  /* One operation on every variant matching the filter: summary first, then apply after confirmation. */
  app.post("/api/v1/admin/stock/bulk", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_STOCK_ROLES);
    const body = parse(bulkStockBody, request.body);
    const { operation } = body;
    if (operation.type === "stock") {
      if (operation.action !== "count" && operation.quantity < 1) throw new AppError(400, "STOCK_QTY", "Adet 1 veya daha büyük olmalı.");
      if (operation.reason === "other" && !operation.note) throw new AppError(400, "STOCK_NOTE", "“Diğer” için kısa bir not yazın.");
    }
    const index = await stockIndex(body.filter);
    if (index.length > MAX_FILTER_ROWS) throw new AppError(400, "TOO_MANY_ROWS", `Tek seferde en fazla ${MAX_FILTER_ROWS} satır güncellenebilir; filtreyi daraltın.`);
    const plan = planStock(index, operation);
    const summary = stockPlanSummary(plan);
    const currentFingerprint = stockFingerprint(index);
    if (!body.apply) return { data: summary, meta: { fingerprint: currentFingerprint } };
    if (body.fingerprint !== currentFingerprint) {
      throw new AppError(409, "STOCK_CHANGED", "Bu arada stoklar veya eşleşen ürünler değişti (örneğin sipariş geldi). Özet yenilendi; tekrar kontrol edip onaylayın.");
    }
    const targets = plan.filter((row) => row.status === "apply");
    if (!targets.length) throw new AppError(400, "NOTHING_TO_SAVE", "Uygulanacak satır yok.");

    const applied: Array<{ sku: string; before: number; after: number }> = [];
    await prisma.$transaction(async (tx) => {
      const inventoryIds = targets.map((row) => row.inventoryId!);
      const locked = await tx.$queryRaw<Array<{ id: string; onHand: number; lowThreshold: number }>>`
        SELECT "id", "onHand", "lowThreshold" FROM "inventory_items" WHERE "id" = ANY(${inventoryIds}) ORDER BY "id" FOR UPDATE`;
      const now = new Map(locked.map((row) => [row.id, row]));
      if (targets.some((row) => now.get(row.inventoryId!)?.onHand !== row.onHand || now.get(row.inventoryId!)?.lowThreshold !== row.lowThreshold)) {
        throw new AppError(409, "STOCK_CHANGED", "Bu arada stoklar değişti (örneğin sipariş geldi). Hiçbir değişiklik uygulanmadı; özeti yenileyip tekrar onaylayın.");
      }
      for (const row of targets) {
        if (operation.type === "threshold") {
          await tx.inventoryItem.update({ where: { id: row.inventoryId! }, data: { lowThreshold: operation.lowThreshold } });
          applied.push({ sku: row.sku, before: row.lowThreshold, after: operation.lowThreshold });
          continue;
        }
        const result = await applyStockChange(tx, {
          inventoryId: row.inventoryId!,
          action: operation.action === "count" ? "adjust" : operation.action,
          quantity: operation.quantity,
          expectedOnHand: row.onHand,
          reason: reasonText(operation.reason, operation.note),
          referenceType: "stock",
          createdById: staff.id,
        });
        applied.push({ sku: row.sku, before: result.before, after: result.after });
      }
    }, { timeout: 120_000, maxWait: 10_000 });

    const what = operation.type === "threshold" ? `kritik eşik ${operation.lowThreshold}` : `${operation.action === "in" ? "stok ekle" : operation.action === "out" ? "stok düş" : "sayım"} ${operation.quantity}`;
    await audit(staff, "stock.bulk", "stock", `Toplu stok işlemi (filtreye uyan tümü): ${applied.length} satır, ${what}${summary.skipped ? `, ${summary.skipped} satır atlandı` : ""}.`, {
      rows: applied.length,
      skipped: summary.skipped,
      filter: body.filter,
      operation,
      changes: applied,
    });
    return { data: { ...summary, applied: applied.length } };
  });

  app.get("/api/v1/admin/stock/movements", async (request) => {
    await requireStaff(request, env, PRODUCT_VIEW_ROLES);
    const query = parse(
      z.object({
        q: z.string().trim().max(120).optional(),
        reason: z.string().trim().max(20).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(30),
      }),
      request.query,
    );
    const where: Prisma.StockMovementWhereInput = {
      type: { in: ["IN", "OUT", "ADJUSTMENT"] },
      ...(query.reason ? reasonWhere(query.reason) : {}),
      ...(query.from || query.to
        ? { createdAt: { ...(query.from ? { gte: new Date(`${query.from}T00:00:00`) } : {}), ...(query.to ? { lt: new Date(new Date(`${query.to}T00:00:00`).getTime() + 86_400_000) } : {}) } }
        : {}),
      ...(query.q
        ? {
            inventoryItem: {
              variant: {
                OR: [
                  { product: { name: { contains: query.q, mode: "insensitive" } } },
                  { name: { contains: query.q, mode: "insensitive" } },
                  { sku: { contains: query.q, mode: "insensitive" } },
                ],
              },
            },
          }
        : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.stockMovement.count({ where }),
      prisma.stockMovement.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          createdBy: { select: { name: true } },
          inventoryItem: { select: { id: true, onHand: true, variant: { select: { name: true, sku: true, product: { select: { id: true, name: true } } } } } },
        },
      }),
    ]);

    const balances = await balancesFor(rows);
    const orderIds = [...new Set(rows.filter((row) => row.referenceType === "order" && row.referenceId).map((row) => row.referenceId!))];
    const orders = await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true } });
    const orderNumber = new Map(orders.map((order) => [order.id, order.number]));

    return {
      data: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        productId: row.inventoryItem.variant.product.id,
        productName: row.inventoryItem.variant.product.name,
        variantName: row.inventoryItem.variant.name,
        sku: row.inventoryItem.variant.sku,
        delta: signedDelta(row),
        quantity: row.quantity,
        balanceAfter: balances.get(row.id) ?? null,
        reason: ORDER_REASON_LABELS[row.reason] ?? row.reason,
        by: row.createdBy?.name ?? (row.referenceType === "order" ? "Sipariş" : "Sistem"),
        order: row.referenceType === "order" && row.referenceId ? { id: row.referenceId, number: orderNumber.get(row.referenceId) ?? null } : null,
      })),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        reasons: [...Object.entries(STOCK_REASONS).map(([value, label]) => ({ value, label })), { value: "order", label: "Sipariş kaynaklı" }],
      },
    };
  });
}

type MovementLike = { id: string; type: string; quantity: number; delta: number | null; balanceAfter: number | null; inventoryItemId: string; createdAt: Date };

function signedDelta(row: Pick<MovementLike, "type" | "quantity" | "delta">) {
  if (row.delta != null) return row.delta;
  if (row.type === "IN") return row.quantity;
  if (row.type === "OUT") return -row.quantity;
  return null;
}

/** Stock after each movement: stored value when present, otherwise walked back from today's stock. */
async function balancesFor(rows: Array<MovementLike & { inventoryItem: { id: string; onHand: number } }>) {
  const result = new Map<string, number>();
  const items = new Map<string, { onHand: number; oldest: Date }>();
  for (const row of rows) {
    if (row.balanceAfter != null) result.set(row.id, row.balanceAfter);
    const seen = items.get(row.inventoryItemId);
    if (!seen || row.createdAt < seen.oldest) items.set(row.inventoryItemId, { onHand: row.inventoryItem.onHand, oldest: row.createdAt });
  }
  const wanted = new Set(rows.filter((row) => row.balanceAfter == null).map((row) => row.id));
  for (const [inventoryItemId, info] of items) {
    if (![...wanted].some((id) => rows.find((row) => row.id === id)?.inventoryItemId === inventoryItemId)) continue;
    const history = await prisma.stockMovement.findMany({
      where: { inventoryItemId, createdAt: { gte: info.oldest } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, type: true, quantity: true, delta: true, balanceAfter: true },
    });
    let running: number | null = info.onHand;
    for (const movement of history) {
      const after: number | null = movement.balanceAfter ?? running;
      if (after != null && wanted.has(movement.id)) result.set(movement.id, after);
      const delta = movement.type === "RESERVE" || movement.type === "RELEASE" ? 0 : signedDelta(movement);
      running = after != null && delta != null ? after - delta : null;
    }
  }
  return result;
}
