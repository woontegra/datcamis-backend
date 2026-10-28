import type { Prisma } from "@prisma/client";

const productInclude = {
  images: { orderBy: { sortOrder: "asc" as const }, include: { media: true } },
  variants: {
    where: { deletedAt: null },
    orderBy: [{ position: "asc" as const }, { isDefault: "desc" as const }, { name: "asc" as const }],
    include: {
      inventory: true,
      media: true,
      optionValues: { include: { value: { include: { option: true } } } },
    },
  },
  categories: { include: { category: true } },
  collections: { include: { collection: true } },
  options: {
    orderBy: { position: "asc" as const },
    include: { attribute: true, values: { orderBy: { position: "asc" as const }, include: { attributeValue: true } } },
  },
} satisfies Prisma.ProductInclude;

export const publicProductInclude = productInclude;

type ProductRecord = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

function mediaUrl(id: string) {
  return `/api/v1/media/${id}/file`;
}

function visibleCompareAt(priceAmount: number, compareAtAmount: number | null | undefined) {
  if (compareAtAmount == null || compareAtAmount <= priceAmount) return null;
  return compareAtAmount;
}

function desiNumber(value: Prisma.Decimal | null | undefined) {
  if (value == null) return null;
  return Number(value);
}

export function serializeVariant(variant: ProductRecord["variants"][number], admin: boolean) {
  const available = (variant.inventory?.onHand ?? 0) - (variant.inventory?.reserved ?? 0);
  const compareAtAmount = visibleCompareAt(variant.priceAmount, variant.compareAtAmount);
  return {
    id: variant.id,
    sku: variant.sku,
    name: variant.name,
    priceAmount: variant.priceAmount,
    compareAtAmount,
    currency: variant.currency,
    isDefault: variant.isDefault,
    inStock: available > 0,
    disabled: Boolean(variant.disabledAt),
    options: variant.optionValues
      .slice()
      .sort((a, b) => a.value.option.position - b.value.option.position)
      .map((item) => ({
        optionId: item.value.optionId,
        valueId: item.value.id,
        name: item.value.option.name,
        value: item.value.value,
      })),
    image: variant.media && !variant.media.deletedAt
      ? { id: variant.media.id, alt: variant.media.alt || variant.name, url: mediaUrl(variant.media.id) }
      : null,
    ...(admin
      ? {
          barcode: variant.barcode,
          weightGrams: variant.weightGrams,
          desi: desiNumber(variant.desi),
          position: variant.position,
          onHand: variant.inventory?.onHand ?? 0,
          reserved: variant.inventory?.reserved ?? 0,
          lowThreshold: variant.inventory?.lowThreshold ?? 0,
          optionValueIds: variant.optionValues.map((item) => item.value.attributeValueId).filter((id): id is string => Boolean(id)),
        }
      : {}),
  };
}

export function serializeProduct(product: ProductRecord, admin = false) {
  const variants = admin ? product.variants : product.variants.filter((variant) => !variant.disabledAt);
  return {
    id: product.id,
    createdAt: product.createdAt,
    slug: product.slug,
    name: product.name,
    summary: product.summary,
    description: product.description,
    content: product.content,
    usageNotes: product.usageNotes,
    warningNotes: product.warningNotes,
    featured: product.featured,
    vatRate: product.vatRate,
    status: product.status,
    isSeed: product.isSeed,
    images: product.images
      .filter((image) => !image.media.deletedAt)
      .map((image) => ({
        id: image.id,
        mediaId: image.media.id,
        alt: image.alt || image.media.alt || product.name,
        url: mediaUrl(image.media.id),
        sortOrder: image.sortOrder,
      })),
    variants: variants.map((variant) => serializeVariant(variant, admin)),
    options: product.options.map((option) => ({
      id: option.id,
      attributeId: option.attributeId,
      name: option.name,
      displayType: option.attribute?.displayType ?? "BUTTONS",
      values: option.values.map((value) => ({
        id: value.id,
        attributeValueId: value.attributeValueId,
        name: value.value,
        colorHex: value.attributeValue?.colorHex ?? null,
      })),
    })),
    categories: product.categories
      .filter((item) => !item.category.deletedAt && (admin || item.category.isVisible))
      .map((item) => ({ id: item.category.id, slug: item.category.slug, name: item.category.name })),
    collections: product.collections
      .filter((item) => !item.collection.deletedAt && (admin || item.collection.isVisible))
      .map((item) => ({ id: item.collection.id, slug: item.collection.slug, name: item.collection.name })),
  };
}
