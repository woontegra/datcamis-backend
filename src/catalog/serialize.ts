import type { Prisma } from "@prisma/client";

const productInclude = {
  images: { orderBy: { sortOrder: "asc" as const }, include: { media: true } },
  variants: {
    where: { deletedAt: null },
    orderBy: [{ isDefault: "desc" as const }, { name: "asc" as const }],
    include: {
      inventory: true,
      optionValues: { include: { value: { include: { option: true } } } },
    },
  },
  categories: { include: { category: true } },
  collections: { include: { collection: true } },
} satisfies Prisma.ProductInclude;

export const publicProductInclude = productInclude;

type ProductRecord = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

function mediaUrl(id: string) {
  return `/api/v1/media/${id}/file`;
}

export function serializeVariant(variant: ProductRecord["variants"][number], admin: boolean) {
  const available = (variant.inventory?.onHand ?? 0) - (variant.inventory?.reserved ?? 0);
  return {
    id: variant.id,
    sku: variant.sku,
    name: variant.name,
    priceAmount: variant.priceAmount,
    currency: variant.currency,
    isDefault: variant.isDefault,
    inStock: available > 0,
    options: variant.optionValues.map((item) => ({
      name: item.value.option.name,
      value: item.value.value,
    })),
    ...(admin
      ? {
          onHand: variant.inventory?.onHand ?? 0,
          reserved: variant.inventory?.reserved ?? 0,
          lowThreshold: variant.inventory?.lowThreshold ?? 0,
        }
      : {}),
  };
}

export function serializeProduct(product: ProductRecord, admin = false) {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    summary: product.summary,
    description: product.description,
    status: product.status,
    isSeed: product.isSeed,
    images: product.images
      .filter((image) => !image.media.deletedAt)
      .map((image) => ({
        id: image.media.id,
        alt: image.alt || image.media.alt || product.name,
        url: mediaUrl(image.media.id),
      })),
    variants: product.variants.map((variant) => serializeVariant(variant, admin)),
    categories: product.categories
      .filter((item) => !item.category.deletedAt)
      .map((item) => ({ slug: item.category.slug, name: item.category.name })),
    collections: product.collections
      .filter((item) => !item.collection.deletedAt)
      .map((item) => ({ slug: item.collection.slug, name: item.collection.name })),
  };
}
