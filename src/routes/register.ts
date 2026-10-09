import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireStaff, setAuthCookies, clearAuthCookies } from "../auth/staff";
import { AppError, notFound } from "../common/errors";
import { parse } from "../common/parse";
import { randomToken, sha256, verifyPassword } from "../common/password";
import { signAccessToken } from "../common/tokens";
import type { Env } from "../config/env";
import { publicProductInclude, serializeProduct } from "../catalog/serialize";
import { prisma } from "../db";
import { editorImageMimeTypes, editorMediaIds, homeEditorSlug, pageDocumentSchema, type PageDocument } from "../page-builder/schema";
import { createPaymentProvider, createShippingProvider } from "../providers/commerce";
import { assertSafeKey } from "../storage/adapter";
import type { MediaStorage } from "../storage/media-storage";
import { storageStatus } from "../storage/persistence";
import { cleanOriginalName, detectImage, matchesDeclared, safeFileName, UPLOAD_IMAGE_TYPES, UPLOAD_MAX_BYTES } from "../media/image";
import { randomBytes } from "crypto";

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(48).default(12),
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  collection: z.string().trim().max(80).optional(),
  sort: z.enum(["newest", "name", "price_asc", "price_desc"]).default("newest"),
});

const addressSchema = z.object({
  fullName: z.string().trim().min(3).max(120),
  phone: z.string().trim().min(10).max(20),
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).optional(),
  district: z.string().trim().min(2).max(80),
  city: z.string().trim().min(2).max(80),
  postalCode: z.string().trim().min(4).max(10),
  country: z.string().trim().length(2).default("TR"),
});

function cartExpiry() {
  return new Date(Date.now() + 1000 * 60 * 60 * 24 * 14);
}

async function findCart(token: string | undefined) {
  if (!token) throw new AppError(400, "CART_REQUIRED", "Sepet oturumu gerekli.");
  const cart = await prisma.cart.findUnique({
    where: { tokenHash: sha256(token) },
    include: {
      items: {
        include: {
          variant: { include: { product: true, inventory: true } },
        },
      },
    },
  });
  if (!cart || cart.expiresAt < new Date()) throw notFound("Sepet bulunamadı.");
  return cart;
}

function serializeCart(cart: Awaited<ReturnType<typeof findCart>>) {
  const items = cart.items.map((item) => ({
    id: item.id,
    quantity: item.quantity,
    unitAmount: item.unitAmount,
    lineAmount: item.unitAmount * item.quantity,
    currency: item.variant.currency,
    variantId: item.variantId,
    variantName: item.variant.name,
    sku: item.variant.sku,
    productName: item.variant.product.name,
    productSlug: item.variant.product.slug,
    isSeed: item.variant.product.isSeed,
  }));
  return {
    id: cart.id,
    currency: cart.currency,
    items,
    subtotalAmount: items.reduce((sum, item) => sum + item.lineAmount, 0),
  };
}

function isUniqueConflict(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

async function assertEditorMedia(document: PageDocument) {
  const ids = editorMediaIds(document);
  if (ids.length === 0) return;
  const found = await prisma.media.count({
    where: { id: { in: ids }, deletedAt: null, mimeType: { in: editorImageMimeTypes } },
  });
  if (found !== ids.length) {
    throw new AppError(400, "MEDIA_NOT_ALLOWED", "Seçilen görsel Medya Kütüphanesinde bulunamadı.");
  }
}

export async function registerRoutes(app: FastifyInstance, env: Env, storage: MediaStorage) {
  app.get("/api/v1/health", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { data: { status: "ok" } };
  });

  app.get("/api/v1/catalog/products", async (request) => {
    const query = parse(listQuery, request.query);
    const where = {
      deletedAt: null,
      status: "ACTIVE" as const,
      ...(query.q ? { OR: [{ name: { contains: query.q, mode: "insensitive" as const } }, { summary: { contains: query.q, mode: "insensitive" as const } }] } : {}),
      ...(query.category ? { categories: { some: { category: { slug: query.category, deletedAt: null } } } } : {}),
      ...(query.collection ? { collections: { some: { collection: { slug: query.collection, deletedAt: null } } } } : {}),
    };
    const orderBy = query.sort === "name" ? { name: "asc" as const } : { createdAt: "desc" as const };
    if (query.sort === "price_asc" || query.sort === "price_desc") {
      const priced = await prisma.product.findMany({
        where,
        select: {
          id: true,
          variants: { where: { deletedAt: null, isDefault: true }, select: { priceAmount: true }, take: 1 },
        },
      });
      priced.sort((a, b) => {
        const ap = a.variants[0]?.priceAmount ?? 0;
        const bp = b.variants[0]?.priceAmount ?? 0;
        return query.sort === "price_asc" ? ap - bp : bp - ap;
      });
      const pageIds = priced.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map((row) => row.id);
      const rows = await prisma.product.findMany({ where: { id: { in: pageIds } }, include: publicProductInclude });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return {
        data: pageIds.flatMap((id) => {
          const row = byId.get(id);
          return row ? [serializeProduct(row)] : [];
        }),
        meta: { page: query.page, pageSize: query.pageSize, total: priced.length },
      };
    }
    const [total, rows] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        include: publicProductInclude,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { data: rows.map((row) => serializeProduct(row)), meta: { page: query.page, pageSize: query.pageSize, total } };
  });

  app.get("/api/v1/catalog/products/:slug", async (request) => {
    const { slug } = parse(z.object({ slug: z.string().min(1) }), request.params);
    const product = await prisma.product.findFirst({
      where: { slug, deletedAt: null, status: "ACTIVE" },
      include: publicProductInclude,
    });
    if (!product) throw notFound("Ürün bulunamadı.");
    const seo = await prisma.seoMetadata.findUnique({ where: { entityType_entityId: { entityType: "product", entityId: product.id } } });
    return { data: { ...serializeProduct(product), seo } };
  });

  app.get("/api/v1/catalog/categories", async () => {
    const rows = await prisma.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" } });
    return { data: rows.map((row) => ({ id: row.id, slug: row.slug, name: row.name, description: row.description, parentId: row.parentId })) };
  });

  app.get("/api/v1/catalog/categories/:slug", async (request) => {
    const { slug } = parse(z.object({ slug: z.string() }), request.params);
    const category = await prisma.category.findFirst({ where: { slug, deletedAt: null } });
    if (!category) throw notFound("Kategori bulunamadı.");
    const seo = await prisma.seoMetadata.findUnique({ where: { entityType_entityId: { entityType: "category", entityId: category.id } } });
    return { data: { id: category.id, slug: category.slug, name: category.name, description: category.description, seo } };
  });

  app.get("/api/v1/catalog/collections", async () => {
    const rows = await prisma.collection.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" } });
    return {
      data: rows.map((row) => ({ id: row.id, slug: row.slug, name: row.name, description: row.description })),
    };
  });

  app.get("/api/v1/catalog/collections/:slug", async (request) => {
    const { slug } = parse(z.object({ slug: z.string() }), request.params);
    const collection = await prisma.collection.findFirst({ where: { slug, deletedAt: null } });
    if (!collection) throw notFound("Koleksiyon bulunamadı.");
    const seo = await prisma.seoMetadata.findUnique({ where: { entityType_entityId: { entityType: "collection", entityId: collection.id } } });
    return { data: { id: collection.id, slug: collection.slug, name: collection.name, description: collection.description, seo } };
  });

  app.get("/api/v1/content/posts", async () => {
    const rows = await prisma.blogPost.findMany({
      where: { deletedAt: null, status: "PUBLISHED" },
      orderBy: { publishedAt: "desc" },
    });
    return {
      data: rows.map((row) => ({
        slug: row.slug,
        title: row.title,
        excerpt: row.excerpt,
        publishedAt: row.publishedAt,
        isSeed: row.isSeed,
      })),
    };
  });

  app.get("/api/v1/content/posts/:slug", async (request) => {
    const { slug } = parse(z.object({ slug: z.string() }), request.params);
    const post = await prisma.blogPost.findFirst({ where: { slug, deletedAt: null, status: "PUBLISHED" } });
    if (!post) throw notFound("Yazı bulunamadı.");
    const seo = await prisma.seoMetadata.findUnique({ where: { entityType_entityId: { entityType: "blog_post", entityId: post.id } } });
    return { data: { ...post, seo } };
  });

  app.get("/api/v1/content/pages/:slug", async (request) => {
    const { slug } = parse(z.object({ slug: z.string() }), request.params);
    const page = await prisma.page.findFirst({
      where: { slug, deletedAt: null, status: "PUBLISHED" },
      include: { publishedRevision: true },
    });
    if (!page?.publishedRevision) throw notFound("Sayfa bulunamadı.");
    const parsed = parse(pageDocumentSchema, page.publishedRevision.document);
    const document = parsed.version === 1 ? parsed : { version: 1 as const, sections: parsed.sections };
    const seo = await prisma.seoMetadata.findUnique({ where: { entityType_entityId: { entityType: "page", entityId: page.id } } });
    return { data: { slug: page.slug, title: page.title, document, seo } };
  });

  app.get("/api/v1/content/menus/:key", async (request) => {
    const { key } = parse(z.object({ key: z.string() }), request.params);
    const menu = await prisma.menu.findUnique({ where: { key }, include: { items: { orderBy: { sortOrder: "asc" } } } });
    if (!menu) throw notFound("Menü bulunamadı.");
    return { data: { key: menu.key, name: menu.name, items: menu.items.filter((item) => !item.parentId).map((item) => ({ label: item.label, href: item.href })) } };
  });

  app.get("/api/v1/settings/public", async () => {
    const rows = await prisma.siteSetting.findMany();
    const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return { data: settings };
  });

  app.get("/api/v1/seo/paths", async () => {
    const [products, categories, collections, pages, posts] = await Promise.all([
      prisma.product.findMany({ where: { deletedAt: null, status: "ACTIVE" }, select: { slug: true } }),
      prisma.category.findMany({ where: { deletedAt: null }, select: { slug: true } }),
      prisma.collection.findMany({ where: { deletedAt: null }, select: { slug: true } }),
      prisma.page.findMany({ where: { deletedAt: null, status: "PUBLISHED" }, select: { slug: true } }),
      prisma.blogPost.findMany({ where: { deletedAt: null, status: "PUBLISHED" }, select: { slug: true } }),
    ]);
    return {
      data: {
        products: products.map((row) => row.slug),
        categories: categories.map((row) => row.slug),
        collections: collections.map((row) => row.slug),
        pages: pages.map((row) => row.slug),
        posts: posts.map((row) => row.slug),
      },
    };
  });

  app.get("/api/v1/media/:id/file", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const media = await prisma.media.findFirst({ where: { id, deletedAt: null } });
    if (!media) throw notFound("Medya bulunamadı.");
    const file = await storage.read(media);
    if (!file) throw notFound("Dosya bulunamadı.");
    if (file.kind === "redirect") {
      return reply.header("cache-control", "public, max-age=3600").redirect(file.url, 302);
    }
    return reply.type(media.mimeType).send(file.body);
  });

  app.post("/api/v1/carts", async () => {
    const token = randomToken();
    const cart = await prisma.cart.create({
      data: { tokenHash: sha256(token), currency: "TRY", expiresAt: cartExpiry() },
    });
    return { data: { id: cart.id, token } };
  });

  app.get("/api/v1/carts/current", async (request) => {
    const token = request.headers["x-cart-token"];
    const cart = await findCart(typeof token === "string" ? token : undefined);
    return { data: serializeCart(cart) };
  });

  app.post("/api/v1/carts/current/items", async (request) => {
    const token = request.headers["x-cart-token"];
    const body = parse(z.object({ variantId: z.string().min(1), quantity: z.number().int().min(1).max(20) }), request.body);
    const cart = await findCart(typeof token === "string" ? token : undefined);
    const variant = await prisma.productVariant.findFirst({
      where: { id: body.variantId, deletedAt: null, product: { deletedAt: null, status: "ACTIVE" } },
      include: { inventory: true },
    });
    if (!variant) throw notFound("Varyant bulunamadı.");
    const available = (variant.inventory?.onHand ?? 0) - (variant.inventory?.reserved ?? 0);
    const existing = cart.items.find((item) => item.variantId === variant.id);
    const nextQty = (existing?.quantity ?? 0) + body.quantity;
    if (nextQty > available) throw new AppError(409, "INSUFFICIENT_STOCK", "İstenen adet stokta yok.");
    if (existing) {
      await prisma.cartItem.update({ where: { id: existing.id }, data: { quantity: nextQty, unitAmount: variant.priceAmount } });
    } else {
      await prisma.cartItem.create({
        data: { cartId: cart.id, variantId: variant.id, quantity: body.quantity, unitAmount: variant.priceAmount },
      });
    }
    await prisma.cart.update({ where: { id: cart.id }, data: { expiresAt: cartExpiry() } });
    return { data: serializeCart(await findCart(typeof token === "string" ? token : undefined)) };
  });

  app.patch("/api/v1/carts/current/items/:itemId", async (request) => {
    const token = request.headers["x-cart-token"];
    const params = parse(z.object({ itemId: z.string() }), request.params);
    const body = parse(z.object({ quantity: z.number().int().min(1).max(20) }), request.body);
    const cart = await findCart(typeof token === "string" ? token : undefined);
    const item = cart.items.find((entry) => entry.id === params.itemId);
    if (!item) throw notFound("Sepet satırı bulunamadı.");
    const available = (item.variant.inventory?.onHand ?? 0) - (item.variant.inventory?.reserved ?? 0);
    if (body.quantity > available) throw new AppError(409, "INSUFFICIENT_STOCK", "İstenen adet stokta yok.");
    await prisma.cartItem.update({ where: { id: item.id }, data: { quantity: body.quantity } });
    return { data: serializeCart(await findCart(typeof token === "string" ? token : undefined)) };
  });

  app.delete("/api/v1/carts/current/items/:itemId", async (request) => {
    const token = request.headers["x-cart-token"];
    const params = parse(z.object({ itemId: z.string() }), request.params);
    const cart = await findCart(typeof token === "string" ? token : undefined);
    const item = cart.items.find((entry) => entry.id === params.itemId);
    if (!item) throw notFound("Sepet satırı bulunamadı.");
    await prisma.cartItem.delete({ where: { id: item.id } });
    return { data: serializeCart(await findCart(typeof token === "string" ? token : undefined)) };
  });

  app.post("/api/v1/checkout", async (request) => {
    const token = request.headers["x-cart-token"];
    const body = parse(
      z.object({
        email: z.string().trim().email(),
        shippingAddress: addressSchema,
        billingAddress: addressSchema.optional(),
        customerNote: z.string().trim().max(500).optional(),
      }),
      request.body,
    );
    const cart = await findCart(typeof token === "string" ? token : undefined);
    if (cart.items.length === 0) throw new AppError(400, "CART_EMPTY", "Sepet boş.");

    const payment = createPaymentProvider(env).createPayment({
      orderNumber: "pending",
      amount: cart.items.reduce((sum, item) => sum + item.unitAmount * item.quantity, 0),
      currency: cart.currency,
    });
    const shipment = createShippingProvider(env).createShipment({ orderNumber: "pending" });
    const subtotal = cart.items.reduce((sum, item) => sum + item.unitAmount * item.quantity, 0);

    const order = await prisma.$transaction(async (tx) => {
      const sequence = await tx.$queryRaw<Array<{ last: number }>>`
        UPDATE "order_sequences" SET "last" = "last" + 1 WHERE "id" = 1 RETURNING "last"
      `;
      const last = sequence[0]?.last;
      if (!last) throw new AppError(500, "SEQUENCE_MISSING", "Sipariş sırası hazır değil.");
      const number = `DM-${last}`;
      for (const item of cart.items) {
        const updated = await tx.$executeRaw`
          UPDATE "inventory_items"
          SET "onHand" = "onHand" - ${item.quantity}, "updatedAt" = NOW()
          WHERE "variantId" = ${item.variantId} AND ("onHand" - "reserved") >= ${item.quantity}
        `;
        if (Number(updated) !== 1) throw new AppError(409, "INSUFFICIENT_STOCK", "Stok bu sipariş için yetersiz.");
        const inventory = await tx.inventoryItem.findUniqueOrThrow({ where: { variantId: item.variantId } });
        await tx.stockMovement.create({
          data: {
            inventoryItemId: inventory.id,
            type: "OUT",
            quantity: item.quantity,
            reason: "checkout",
            referenceType: "order",
          },
        });
      }
      const created = await tx.order.create({
        data: {
          number,
          email: body.email,
          status: "PENDING",
          currency: cart.currency,
          subtotalAmount: subtotal,
          discountAmount: 0,
          shippingAmount: 0,
          taxAmount: 0,
          totalAmount: subtotal,
          shippingAddress: body.shippingAddress,
          billingAddress: body.billingAddress ?? body.shippingAddress,
          customerNote: body.customerNote,
          items: {
            create: cart.items.map((item) => ({
              variantId: item.variantId,
              productName: item.variant.product.name,
              variantName: item.variant.name,
              sku: item.variant.sku,
              quantity: item.quantity,
              unitAmount: item.unitAmount,
              totalAmount: item.unitAmount * item.quantity,
            })),
          },
          payments: {
            create: {
              provider: payment.provider,
              status: payment.status,
              amount: subtotal,
              currency: cart.currency,
              metadata: payment.metadata as Prisma.InputJsonValue,
            },
          },
          shipments: {
            create: {
              provider: shipment.provider,
              status: shipment.status,
              metadata: shipment.metadata as Prisma.InputJsonValue,
            },
          },
        },
        include: { items: true, payments: true, shipments: true },
      });
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      return created;
    });

    return { data: order };
  });

  app.post("/api/v1/newsletter", async (request) => {
    const body = parse(z.object({ email: z.string().trim().email() }), request.body);
    await prisma.newsletterSubscriber.upsert({
      where: { email: body.email.toLowerCase() },
      update: {},
      create: { email: body.email.toLowerCase() },
    });
    return { data: { subscribed: true } };
  });

  app.post("/api/v1/admin/auth/login", { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = parse(z.object({ email: z.string().trim().email(), password: z.string().min(8).max(200) }), request.body);
    const user = await prisma.user.findFirst({ where: { email: body.email.toLowerCase(), deletedAt: null } });
    if (!user || user.status !== "ACTIVE" || !(await verifyPassword(user.passwordHash, body.password))) {
      throw new AppError(401, "INVALID_CREDENTIALS", "E-posta veya şifre hatalı.");
    }
    const access = await signAccessToken(env, { sub: user.id, email: user.email, role: user.role });
    const refresh = randomToken();
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refresh),
        expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
        userAgent: request.headers["user-agent"],
        ip: request.ip,
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await prisma.auditLog.create({
      data: { actorId: user.id, action: "auth.login", entityType: "user", entityId: user.id, ip: request.ip },
    });
    setAuthCookies(reply, env, access, refresh);
    return { data: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  app.post("/api/v1/admin/auth/refresh", async (request, reply) => {
    const refresh = request.cookies.dm_refresh;
    if (!refresh) throw new AppError(401, "UNAUTHENTICATED", "Yenileme oturumu yok.");
    const current = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refresh) }, include: { user: true } });
    if (!current || current.revokedAt || current.expiresAt < new Date() || current.user.deletedAt || current.user.status !== "ACTIVE") {
      throw new AppError(401, "UNAUTHENTICATED", "Yenileme oturumu geçersiz.");
    }
    await prisma.refreshToken.update({ where: { id: current.id }, data: { revokedAt: new Date() } });
    const next = randomToken();
    await prisma.refreshToken.create({
      data: {
        userId: current.userId,
        tokenHash: sha256(next),
        expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
        userAgent: request.headers["user-agent"],
        ip: request.ip,
      },
    });
    const access = await signAccessToken(env, { sub: current.user.id, email: current.user.email, role: current.user.role });
    setAuthCookies(reply, env, access, next);
    return { data: { id: current.user.id, email: current.user.email, name: current.user.name, role: current.user.role } };
  });

  app.post("/api/v1/admin/auth/logout", async (request, reply) => {
    const refresh = request.cookies.dm_refresh;
    if (refresh) {
      await prisma.refreshToken.updateMany({ where: { tokenHash: sha256(refresh), revokedAt: null }, data: { revokedAt: new Date() } });
    }
    clearAuthCookies(reply, env);
    return { data: { loggedOut: true } };
  });

  app.get("/api/v1/admin/auth/me", async (request) => {
    const staff = await requireStaff(request, env);
    return { data: staff };
  });

  app.get("/api/v1/admin/dashboard", async (request) => {
    await requireStaff(request, env);
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - 13);
    const [orderAgg, orderCount, customerCount, lowStock, recentOrders, grouped] = await Promise.all([
      prisma.order.aggregate({ where: { status: { not: "CANCELLED" } }, _sum: { totalAmount: true } }),
      prisma.order.count({ where: { status: { not: "CANCELLED" } } }),
      prisma.customer.count({ where: { deletedAt: null } }),
      prisma.inventoryItem.findMany({
        where: { variant: { deletedAt: null, product: { deletedAt: null } } },
        include: { variant: { include: { product: true } } },
        orderBy: { onHand: "asc" },
      }),
      prisma.order.findMany({ orderBy: { placedAt: "desc" }, take: 8, include: { items: true } }),
      prisma.$queryRaw<Array<{ day: Date; amount: number }>>`
        SELECT date_trunc('day', "placedAt") AS day, COALESCE(SUM("totalAmount"), 0)::int AS amount
        FROM "orders"
        WHERE "placedAt" >= ${since} AND "status" <> 'CANCELLED'
        GROUP BY 1
        ORDER BY 1
      `,
    ]);
    const revenueAmount = orderAgg._sum.totalAmount ?? 0;
    const low = lowStock
      .filter((item) => item.onHand - item.reserved <= item.lowThreshold)
      .slice(0, 8)
      .map((item) => ({
        sku: item.variant.sku,
        productName: item.variant.product.name,
        variantName: item.variant.name,
        onHand: item.onHand,
        reserved: item.reserved,
        lowThreshold: item.lowThreshold,
        isSeed: item.variant.product.isSeed,
      }));
    const byDay = new Map(grouped.map((row) => [new Date(row.day).toISOString().slice(0, 10), Number(row.amount)]));
    const salesSeries = Array.from({ length: 14 }, (_, index) => {
      const day = new Date(since);
      day.setDate(since.getDate() + index);
      const key = day.toISOString().slice(0, 10);
      return { date: key, amount: byDay.get(key) ?? 0 };
    });
    const topProducts = await prisma.orderItem.groupBy({
      by: ["sku", "productName"],
      _sum: { quantity: true, totalAmount: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 5,
    });
    return {
      data: {
        revenueAmount,
        orderCount,
        customerCount,
        averageOrderAmount: orderCount === 0 ? 0 : Math.round(revenueAmount / orderCount),
        conversionRate: null,
        conversionNote: "analytics_not_connected",
        salesSeries,
        topProducts: topProducts.map((row) => ({
          sku: row.sku,
          productName: row.productName,
          quantity: row._sum.quantity ?? 0,
          totalAmount: row._sum.totalAmount ?? 0,
        })),
        lowStock: low,
        recentOrders: recentOrders.map((order) => ({
          number: order.number,
          email: order.email,
          status: order.status,
          totalAmount: order.totalAmount,
          currency: order.currency,
          placedAt: order.placedAt,
          isSeed: order.isSeed,
        })),
      },
    };
  });

  app.get("/api/v1/admin/products", async (request) => {
    await requireStaff(request, env, ["OWNER", "ADMIN", "EDITOR", "ORDER_STAFF"]);
    const rows = await prisma.product.findMany({
      where: { deletedAt: null },
      include: publicProductInclude,
      orderBy: { name: "asc" },
    });
    return { data: rows.map((row) => serializeProduct(row, true)) };
  });

  app.get("/api/v1/admin/categories", async (request) => {
    await requireStaff(request, env);
    const rows = await prisma.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" } });
    return { data: rows };
  });

  app.get("/api/v1/admin/collections", async (request) => {
    await requireStaff(request, env);
    const rows = await prisma.collection.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" } });
    return { data: rows };
  });

  app.get("/api/v1/admin/orders", async (request) => {
    await requireStaff(request, env, ["OWNER", "ADMIN", "ORDER_STAFF"]);
    const rows = await prisma.order.findMany({ orderBy: { placedAt: "desc" }, take: 50, include: { payments: true, shipments: true } });
    return { data: rows };
  });

  app.get("/api/v1/admin/customers", async (request) => {
    await requireStaff(request, env, ["OWNER", "ADMIN", "ORDER_STAFF"]);
    const rows = await prisma.customer.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "desc" } });
    return { data: rows.map((row) => ({ id: row.id, email: row.email, firstName: row.firstName, lastName: row.lastName, phone: row.phone, createdAt: row.createdAt })) };
  });

  app.get("/api/v1/admin/users", async (request) => {
    await requireStaff(request, env, ["OWNER", "ADMIN"]);
    const rows = await prisma.user.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "asc" } });
    return { data: rows.map((row) => ({ id: row.id, email: row.email, name: row.name, role: row.role, status: row.status, lastLoginAt: row.lastLoginAt })) };
  });

  app.get("/api/v1/admin/media", async (request) => {
    await requireStaff(request, env, ["OWNER", "ADMIN", "EDITOR"]);
    const rows = await prisma.media.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "desc" } });
    const status = storageStatus(env);
    return {
      data: rows.map((row) => ({
        id: row.id,
        filename: row.filename,
        originalName: row.originalName,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        width: row.width,
        height: row.height,
        alt: row.alt,
        url: `/api/v1/media/${row.id}/file`,
      })),
      meta: {
        upload: status.persistent
          ? { enabled: true, maxBytes: UPLOAD_MAX_BYTES, types: UPLOAD_IMAGE_TYPES }
          : { enabled: false, maxBytes: UPLOAD_MAX_BYTES, types: UPLOAD_IMAGE_TYPES, message: status.message },
      },
    };
  });

  app.post("/api/v1/admin/media", async (request) => {
    const staff = await requireStaff(request, env, ["OWNER", "ADMIN", "EDITOR"]);
    const status = storageStatus(env);
    if (!status.persistent) throw new AppError(503, status.code, status.message);
    if (!request.isMultipart()) throw new AppError(400, "UPLOAD_REQUIRED", "Görsel dosyası gönderilmedi.");

    let file: Awaited<ReturnType<typeof request.file>>;
    let body: Buffer;
    try {
      file = await request.file({ limits: { fileSize: UPLOAD_MAX_BYTES, files: 1, fields: 0, parts: 1 } });
      if (!file) throw new AppError(400, "UPLOAD_REQUIRED", "Görsel dosyası gönderilmedi.");
      body = await file.toBuffer();
    } catch (error) {
      if (error instanceof AppError) throw error;
      const code = (error as { code?: string }).code;
      if (code === "FST_REQ_FILE_TOO_LARGE") throw new AppError(413, "FILE_TOO_LARGE", "Dosya 8 MB sınırını aşıyor. Daha küçük bir görsel seçin.");
      throw new AppError(400, "UPLOAD_FAILED", "Dosya okunamadı. Tek bir görsel seçip tekrar deneyin.");
    }
    if (file.file.truncated) throw new AppError(413, "FILE_TOO_LARGE", "Dosya 8 MB sınırını aşıyor. Daha küçük bir görsel seçin.");
    if (body.length === 0) throw new AppError(400, "EMPTY_FILE", "Dosya boş.");
    if (!(UPLOAD_IMAGE_TYPES as string[]).includes(file.mimetype)) {
      throw new AppError(400, "UNSUPPORTED_MEDIA", "Yalnızca JPG, PNG veya WebP görseller yüklenebilir.");
    }
    const image = detectImage(body);
    if (!image) throw new AppError(400, "INVALID_IMAGE", "Dosya içeriği geçerli bir JPG, PNG veya WebP görseli değil.");
    if (!matchesDeclared(image, file.mimetype, file.filename)) {
      throw new AppError(400, "INVALID_IMAGE", "Dosyanın uzantısı, türü ve içeriği birbiriyle uyuşmuyor.");
    }

    // Keys never contain user input; the original name is only kept as text.
    const key = `uploads/${randomBytes(16).toString("hex")}.${image.extension}`;
    assertSafeKey(key);
    const filename = safeFileName(file.filename, image.extension);
    const saved = await storage.save(key, body, image.mimeType, request.log);
    let media;
    try {
      media = await prisma.$transaction(async (tx) => {
        const row = await tx.media.create({
          data: {
            storageProvider: saved.storageProvider,
            storageKey: saved.storageKey,
            filename,
            originalName: cleanOriginalName(file.filename),
            mimeType: image.mimeType,
            sizeBytes: body.length,
            width: image.width,
            height: image.height,
            alt: "",
            metadata: saved.storage ? { uploadedBy: staff.id, storage: saved.storage } : { uploadedBy: staff.id },
          },
        });
        await tx.auditLog.create({
          data: { actorId: staff.id, action: "media.upload", entityType: "media", entityId: row.id },
        });
        return row;
      });
    } catch (error) {
      // Without a database row nobody can reach the stored object, so remove it rather than leave an orphan.
      await storage.discard(saved).catch((cleanup) => {
        request.log.error({ err: cleanup, storageKey: saved.storageKey }, "Yarım kalan medya nesnesi silinemedi");
      });
      request.log.error({ err: error, storageKey: saved.storageKey }, "Medya kaydı oluşturulamadı");
      throw new AppError(500, "MEDIA_SAVE_FAILED", "Görsel kaydedilemedi. Lütfen tekrar deneyin.");
    }
    return {
      data: {
        id: media.id,
        filename: media.filename,
        originalName: media.originalName,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes,
        width: media.width,
        height: media.height,
        alt: media.alt,
        url: `/api/v1/media/${media.id}/file`,
      },
    };
  });

  app.get("/api/v1/admin/pages", async (request) => {
    await requireStaff(request, env, ["OWNER", "ADMIN", "EDITOR"]);
    const rows = await prisma.page.findMany({
      where: { deletedAt: null },
      orderBy: { title: "asc" },
      include: { revisions: { orderBy: { version: "desc" }, take: 1 } },
    });
    return {
      data: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        status: row.status,
        latestVersion: row.revisions[0]?.version ?? 0,
      })),
    };
  });

  app.get("/api/v1/admin/pages/:id", async (request) => {
    await requireStaff(request, env, ["OWNER", "ADMIN", "EDITOR"]);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const page = await prisma.page.findFirst({
      where: { id, deletedAt: null },
      include: { revisions: { orderBy: { version: "desc" } } },
    });
    if (!page) throw notFound("Sayfa bulunamadı.");
    return { data: page };
  });

  app.post("/api/v1/admin/pages", async (request) => {
    const staff = await requireStaff(request, env, ["OWNER", "ADMIN", "EDITOR"]);
    const body = parse(
      z.object({
        title: z.string().trim().min(2).max(160),
        slug: z.string().trim().regex(/^[a-z0-9-]+$/),
        document: pageDocumentSchema,
      }),
      request.body,
    );
    await assertEditorMedia(body.document);
    const existing = await prisma.page.findFirst({ where: { slug: body.slug, deletedAt: null } });
    if (existing) throw new AppError(409, "SLUG_TAKEN", "Bu adres kullanılıyor.");
    try {
      const page = await prisma.page.create({
        data: {
          title: body.title,
          slug: body.slug,
          status: "DRAFT",
          revisions: { create: { version: 1, status: "DRAFT", document: body.document, createdById: staff.id } },
        },
      });
      return { data: page };
    } catch (error) {
      if (isUniqueConflict(error)) throw new AppError(409, "SLUG_TAKEN", "Bu adres kullanılıyor.");
      throw error;
    }
  });

  app.post("/api/v1/admin/pages/:id/revisions", async (request) => {
    const staff = await requireStaff(request, env, ["OWNER", "ADMIN", "EDITOR"]);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(z.object({
      document: pageDocumentSchema,
      baseVersion: z.number().int().min(0).optional(),
    }), request.body);
    await assertEditorMedia(body.document);
    const page = await prisma.page.findFirst({ where: { id, deletedAt: null }, include: { revisions: { orderBy: { version: "desc" }, take: 1 } } });
    if (!page) throw notFound("Sayfa bulunamadı.");
    const latest = page.revisions[0]?.version ?? 0;
    if (body.baseVersion !== undefined && body.baseVersion !== latest) {
      throw new AppError(409, "REVISION_CONFLICT", "Bu taslak başka bir yerde güncellendi. Kaydetmek için sayfayı yeniden yükleyin.");
    }
    try {
      const revision = await prisma.pageRevision.create({
        data: {
          pageId: page.id,
          version: latest + 1,
          status: "DRAFT",
          document: body.document,
          createdById: staff.id,
        },
      });
      return { data: revision };
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new AppError(409, "REVISION_CONFLICT", "Bu taslak başka bir yerde güncellendi. Kaydetmek için sayfayı yeniden yükleyin.");
      }
      throw error;
    }
  });

  app.post("/api/v1/admin/pages/:id/publish", async (request) => {
    const staff = await requireStaff(request, env, ["OWNER", "ADMIN", "EDITOR"]);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const page = await prisma.page.findFirst({
      where: { id, deletedAt: null },
      include: { revisions: { orderBy: { version: "desc" }, take: 1 } },
    });
    const revision = page?.revisions[0];
    if (!page || !revision) throw notFound("Yayınlanacak taslak yok.");
    if (page.slug === homeEditorSlug) {
      throw new AppError(409, "PUBLISH_UNSUPPORTED", "Mağaza ana sayfasına yayınlama henüz desteklenmiyor.");
    }
    const updated = await prisma.page.update({
      where: { id: page.id },
      data: { status: "PUBLISHED", publishedRevisionId: revision.id },
    });
    await prisma.pageRevision.update({ where: { id: revision.id }, data: { status: "PUBLISHED" } });
    await prisma.auditLog.create({
      data: { actorId: staff.id, action: "page.publish", entityType: "page", entityId: page.id, metadata: { version: revision.version } },
    });
    return { data: updated };
  });

  app.get("/api/v1/admin/audit-logs", async (request) => {
    await requireStaff(request, env, ["OWNER", "ADMIN"]);
    const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    return { data: rows };
  });
}
