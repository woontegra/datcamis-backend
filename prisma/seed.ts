import { readFileSync } from "fs";
import path from "path";
import { PrismaClient, type StaffRole } from "@prisma/client";
import { hashPassword } from "../src/common/password";
import { loadEnv } from "../src/config/env";
import { loadDotEnv } from "../src/load-env";
import { defaultSpacing, defaultVisibility, type PageDocument } from "../src/page-builder/schema";

loadDotEnv();
const env = loadEnv();
const prisma = new PrismaClient();

const vis = defaultVisibility;
const sp = defaultSpacing;

const products = [
  ["limon-cicegi-kolonyasi", "Limon Çiçeği Kolonyası", "cicek-kolonyalari", "cicek-serisi", "limon", true],
  ["zeytin-cicegi-kolonyasi", "Zeytin Çiçeği Kolonyası", "cicek-kolonyalari", "cicek-serisi", "zeytin", true],
  ["badem-cicegi-kolonyasi", "Badem Çiçeği Kolonyası", "cicek-kolonyalari", "cicek-serisi", "badem", true],
  ["limon-kolonyasi", "Limon Kolonyası", "klasik-kolonyalar", "bahce-serisi", "limon", false],
  ["zeytin-kolonyasi", "Zeytin Kolonyası", "klasik-kolonyalar", "bahce-serisi", "zeytin", false],
  ["badem-kolonyasi", "Badem Kolonyası", "klasik-kolonyalar", "bahce-serisi", "badem", false],
  ["datca-bahcesi-kolonyasi", "Datça Bahçesi Kolonyası", "klasik-kolonyalar", "bahce-serisi", "limon", true],
  ["uc-cicek-kolonyasi", "Üç Çiçek Kolonyası", "cicek-kolonyalari", "cicek-serisi", "badem", true],
  ["narenciye-yapragi-kolonyasi", "Narenciye Yaprağı Kolonyası", "klasik-kolonyalar", "bahce-serisi", "limon", false],
  ["gece-bahcesi-kolonyasi", "Gece Bahçesi Kolonyası", "klasik-kolonyalar", "bahce-serisi", "zeytin", false],
] as const;

function storyDocument(): PageDocument {
  return {
    version: 1,
    sections: [
      {
        id: "hikaye-hero",
        visibility: vis,
        spacing: { ...sp, bottom: 24 },
        contained: true,
        columns: 1,
        blocks: [
          {
            id: "hikaye-hero-block",
            type: "hero",
            visibility: vis,
            spacing: sp,
            props: {
              eyebrow: "Datça",
              title: "Yarımadanın bahçesinden",
              text: "Limon, zeytin ve badem aynı kıyıda büyür. Bu sayfa seed içeriktir.",
              ctaLabel: "Kataloğu gör",
              ctaHref: "/urunler",
            },
          },
        ],
      },
      {
        id: "hikaye-metin",
        visibility: vis,
        spacing: sp,
        contained: true,
        columns: 1,
        blocks: [
          {
            id: "hikaye-text",
            type: "text",
            visibility: { desktop: true, tablet: true, mobile: true },
            spacing: sp,
            props: {
              eyebrow: "Seed sayfa",
              title: "Üç ağaç",
              body: "DatçaMis test kaydı. Bu metin bir pazarlama iddiası değildir; sayfa oluşturucunun yayınlanmış revizyonunu doğrulamak için durur.",
            },
          },
        ],
      },
    ],
  };
}

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL || "owner@datcamis.local").toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || "";
  const name = process.env.SEED_ADMIN_NAME || "DatçaMis Owner";
  if (password.length < 8) throw new Error("SEED_ADMIN_PASSWORD en az 8 karakter olmalı.");

  await prisma.user.upsert({
    where: { email },
    update: { name, role: "OWNER" satisfies StaffRole, status: "ACTIVE", passwordHash: await hashPassword(password) },
    create: { email, name, role: "OWNER", status: "ACTIVE", passwordHash: await hashPassword(password) },
  });

  await prisma.orderSequence.upsert({ where: { id: 1 }, update: {}, create: { id: 1, last: 1000 } });

  const mediaIds: Record<string, string> = {};
  for (const key of ["limon", "zeytin", "badem"] as const) {
    const filename = `${key}.svg`;
    const storageKey = `seed/${filename}`;
    const body = readFileSync(path.join("storage", "seed", filename));
    const media = await prisma.media.upsert({
      where: { storageKey },
      update: { sizeBytes: body.length, alt: `${key} botanik çizimi`, mimeType: "image/svg+xml" },
      create: {
        storageProvider: "LOCAL",
        storageKey,
        filename,
        originalName: filename,
        mimeType: "image/svg+xml",
        sizeBytes: body.length,
        alt: `${key} botanik çizimi`,
        metadata: { seed: true },
      },
    });
    mediaIds[key] = media.id;
  }

  const categoryFlower = await prisma.category.upsert({
    where: { slug: "cicek-kolonyalari" },
    update: { name: "Çiçek Kolonyaları", description: "Seed kategori." },
    create: { slug: "cicek-kolonyalari", name: "Çiçek Kolonyaları", description: "Seed kategori.", sortOrder: 1 },
  });
  const categoryClassic = await prisma.category.upsert({
    where: { slug: "klasik-kolonyalar" },
    update: { name: "Klasik Kolonyalar", description: "Seed kategori." },
    create: { slug: "klasik-kolonyalar", name: "Klasik Kolonyalar", description: "Seed kategori.", sortOrder: 2 },
  });

  const collections = {
    "cicek-serisi": await prisma.collection.upsert({
      where: { slug: "cicek-serisi" },
      update: { name: "Çiçek Serisi", description: "Seed koleksiyon." },
      create: { slug: "cicek-serisi", name: "Çiçek Serisi", description: "Seed koleksiyon.", sortOrder: 1 },
    }),
    "bahce-serisi": await prisma.collection.upsert({
      where: { slug: "bahce-serisi" },
      update: { name: "Bahçe Serisi", description: "Seed koleksiyon." },
      create: { slug: "bahce-serisi", name: "Bahçe Serisi", description: "Seed koleksiyon.", sortOrder: 2 },
    }),
    "one-cikanlar": await prisma.collection.upsert({
      where: { slug: "one-cikanlar" },
      update: { name: "Öne Çıkanlar", description: "Seed vitrin koleksiyonu." },
      create: { slug: "one-cikanlar", name: "Öne Çıkanlar", description: "Seed vitrin koleksiyonu.", sortOrder: 0 },
    }),
  };

  for (const [index, item] of products.entries()) {
    const [slug, title, categorySlug, collectionSlug, motif, featured] = item;
    const existing = await prisma.product.findUnique({ where: { slug } });
    if (existing) continue;
    const category = categorySlug === "cicek-kolonyalari" ? categoryFlower : categoryClassic;
    const base = 12000 + index * 500;
    const product = await prisma.product.create({
      data: {
        slug,
        name: title,
        summary: "Seed katalog kaydı. Satış metni değildir.",
        description: `${title} için test kaydı. Fiyat, stok ve içerik iddiası taşımaz. DatçaMis geliştirme verisidir.`,
        status: "ACTIVE",
        isSeed: true,
        images: { create: [{ mediaId: mediaIds[motif], sortOrder: 0, alt: `${title} seed görseli` }] },
        categories: { create: [{ categoryId: category.id }] },
        collections: {
          create: [
            { collectionId: collections[collectionSlug].id, sortOrder: index },
            ...(featured ? [{ collectionId: collections["one-cikanlar"].id, sortOrder: index }] : []),
          ],
        },
      },
    });
    const option = await prisma.productOption.create({ data: { productId: product.id, name: "Hacim", position: 0 } });
    const sizes = index < 3 ? (["100 ml", "250 ml"] as const) : (["100 ml"] as const);
    for (const [sizeIndex, size] of sizes.entries()) {
      const value = await prisma.productOptionValue.create({ data: { optionId: option.id, value: size, position: sizeIndex } });
      const low = slug === "badem-cicegi-kolonyasi" && size === "100 ml";
      const variant = await prisma.productVariant.create({
        data: {
          productId: product.id,
          sku: `SEED-${slug}-${sizeIndex + 1}`.toUpperCase().replace(/[^A-Z0-9-]/g, ""),
          name: size,
          priceAmount: base + sizeIndex * 7000,
          currency: "TRY",
          isDefault: sizeIndex === 0,
          inventory: {
            create: {
              onHand: low ? 2 : 40,
              reserved: 0,
              lowThreshold: 5,
              movements: { create: { type: "IN", quantity: low ? 2 : 40, reason: "seed" } },
            },
          },
        },
      });
      await prisma.variantOptionValue.create({ data: { variantId: variant.id, valueId: value.id } });
    }
    await prisma.seoMetadata.upsert({
      where: { entityType_entityId: { entityType: "product", entityId: product.id } },
      update: {},
      create: {
        entityType: "product",
        entityId: product.id,
        title: `${title} | DatçaMis`,
        description: "Seed ürün kaydı.",
        canonicalPath: `/urunler/${slug}`,
        robotsIndex: true,
        robotsFollow: true,
        ogMediaId: mediaIds[motif],
      },
    });
  }

  for (const category of [categoryFlower, categoryClassic]) {
    await prisma.seoMetadata.upsert({
      where: { entityType_entityId: { entityType: "category", entityId: category.id } },
      update: {},
      create: {
        entityType: "category",
        entityId: category.id,
        title: `${category.name} | DatçaMis`,
        description: "Seed kategori.",
        canonicalPath: `/kategoriler/${category.slug}`,
      },
    });
  }

  const page = await prisma.page.upsert({
    where: { slug: "hikayemiz" },
    update: {},
    create: { slug: "hikayemiz", title: "Hikâyemiz", status: "DRAFT" },
  });
  const revisionCount = await prisma.pageRevision.count({ where: { pageId: page.id } });
  if (revisionCount === 0) {
    const revision = await prisma.pageRevision.create({
      data: { pageId: page.id, version: 1, status: "PUBLISHED", document: storyDocument() },
    });
    await prisma.page.update({
      where: { id: page.id },
      data: { status: "PUBLISHED", publishedRevisionId: revision.id },
    });
    await prisma.seoMetadata.create({
      data: {
        entityType: "page",
        entityId: page.id,
        title: "Hikâyemiz | DatçaMis",
        description: "Seed sayfa.",
        canonicalPath: "/sayfa/hikayemiz",
      },
    });
  }

  const posts = [
    ["uc-agac", "Üç ağaç", "Limon, zeytin ve badem aynı yarımadada."],
    ["koylerin-saatleri", "Köylerin saatleri", "Datça kıyısında yavaşlayan bir gün üzerine seed not."],
  ] as const;
  for (const [slug, title, excerpt] of posts) {
    const post = await prisma.blogPost.upsert({
      where: { slug },
      update: {},
      create: {
        slug,
        title,
        excerpt,
        body: `${excerpt} Bu yazı seed/test içeriğidir ve bir ürün vaadi taşımaz.`,
        status: "PUBLISHED",
        isSeed: true,
        publishedAt: new Date("2026-01-15T09:00:00.000Z"),
      },
    });
    await prisma.seoMetadata.upsert({
      where: { entityType_entityId: { entityType: "blog_post", entityId: post.id } },
      update: {},
      create: {
        entityType: "blog_post",
        entityId: post.id,
        title: `${title} | DatçaMis`,
        description: excerpt,
        canonicalPath: `/blog/${slug}`,
      },
    });
  }

  async function ensureMenu(key: string, name: string, items: Array<[string, string]>) {
    const menu = await prisma.menu.upsert({ where: { key }, update: { name }, create: { key, name } });
    const count = await prisma.menuItem.count({ where: { menuId: menu.id } });
    if (count === 0) {
      await prisma.menuItem.createMany({
        data: items.map(([label, href], sortOrder) => ({ menuId: menu.id, label, href, sortOrder })),
      });
    }
  }

  await ensureMenu("header", "Üst menü", [
    ["Ana Sayfa", "/"],
    ["Ürünler", "/urunler"],
    ["Koleksiyonlar", "/koleksiyonlar"],
    ["Hikayemiz", "/hikayemiz"],
    ["Blog", "/blog"],
    ["İletişim", "/iletisim"],
  ]);
  await ensureMenu("footer", "Alt menü", [
    ["Ürünler", "/urunler"],
    ["Hikayemiz", "/hikayemiz"],
    ["İletişim", "/iletisim"],
  ]);

  const settings: Record<string, unknown> = {
    storeName: "DatçaMis",
    seedMode: true,
    pricingNotice: "Katalog fiyatları seed test verisidir; satış fiyatı değildir.",
    contactEmail: "hello@datcamis.local",
  };
  for (const [key, value] of Object.entries(settings)) {
    await prisma.siteSetting.upsert({ where: { key }, update: { value: value as never }, create: { key, value: value as never } });
  }

  console.log("Seed tamamlandı.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

void env;
