import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { refreshVariantNames } from "./attributes";

type Tx = Prisma.TransactionClient;

const MEASURE = /^\s*(\d+(?:[.,]\d+)?)\s*(ml|cl|lt|l|gr|g|kg|mg|oz)\s*$/i;

export type SetupReport = {
  attributesCreated: number;
  valuesCreated: number;
  optionsLinked: number;
  valuesLinked: number;
  productsLinked: number;
  variantsRenamed: number;
  unmatched: Array<{ product: string; sku: string; name: string; reason: string }>;
};

class DryRun extends Error {}

function measureName(name: string) {
  const match = MEASURE.exec(name);
  return match ? `${match[1].replace(".", ",")} ${match[2].toLowerCase()}` : null;
}

function measureAmount(name: string) {
  const match = MEASURE.exec(name);
  return match ? Number(match[1].replace(",", ".")) : Number.POSITIVE_INFINITY;
}

async function findOrCreateAttribute(tx: Tx, name: string, report: SetupReport) {
  const found = await tx.variantAttribute.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
  if (found) return found;
  const last = await tx.variantAttribute.aggregate({ _max: { position: true } });
  report.attributesCreated += 1;
  return tx.variantAttribute.create({ data: { name, position: (last._max.position ?? -1) + 1 } });
}

async function findOrCreateValue(tx: Tx, attributeId: string, name: string, report: SetupReport) {
  const found = await tx.variantAttributeValue.findFirst({ where: { attributeId, name: { equals: name, mode: "insensitive" } } });
  if (found) return found;
  const last = await tx.variantAttributeValue.aggregate({ where: { attributeId }, _max: { position: true } });
  report.valuesCreated += 1;
  return tx.variantAttributeValue.create({ data: { attributeId, name, position: (last._max.position ?? -1) + 1 } });
}

/**
 * Links existing products to shared variant attributes. Safe to run again: already linked rows are skipped.
 * Prices, stock, SKUs and order history are never touched; only variant display names become "Özellik: Değer".
 */
export async function setupVariantAttributes(options: { attributeName: string; productIds?: string[]; dryRun?: boolean }) {
  const report: SetupReport = { attributesCreated: 0, valuesCreated: 0, optionsLinked: 0, valuesLinked: 0, productsLinked: 0, variantsRenamed: 0, unmatched: [] };
  const productScope: Prisma.ProductWhereInput = { deletedAt: null, ...(options.productIds ? { id: { in: options.productIds } } : {}) };
  try {
    await prisma.$transaction(
      async (tx) => {
        const legacy = await tx.productOption.findMany({
          where: { product: productScope, OR: [{ attributeId: null }, { values: { some: { attributeValueId: null } } }] },
          include: { values: true },
        });
        for (const option of legacy) {
          const attribute = option.attributeId
            ? await tx.variantAttribute.findUniqueOrThrow({ where: { id: option.attributeId } })
            : await findOrCreateAttribute(tx, option.name, report);
          if (!option.attributeId) {
            await tx.productOption.update({ where: { id: option.id }, data: { attributeId: attribute.id } });
            report.optionsLinked += 1;
          }
          for (const value of option.values.filter((row) => !row.attributeValueId)) {
            const shared = await findOrCreateValue(tx, attribute.id, value.value, report);
            await tx.productOptionValue.update({ where: { id: value.id }, data: { attributeValueId: shared.id } });
            report.valuesLinked += 1;
          }
        }

        const products = await tx.product.findMany({
          where: { ...productScope, options: { none: {} } },
          select: { id: true, name: true, variants: { where: { deletedAt: null }, orderBy: [{ position: "asc" }, { name: "asc" }], select: { id: true, sku: true, name: true } } },
        });
        for (const product of products) {
          if (!product.variants.length) continue;
          const named = product.variants.map((variant) => ({ variant, value: measureName(variant.name) }));
          const missing = named.filter((item) => !item.value);
          const values = named.map((item) => item.value?.toLocaleLowerCase("tr-TR"));
          if (missing.length) {
            for (const item of missing) {
              report.unmatched.push({ product: product.name, sku: item.variant.sku, name: item.variant.name, reason: "Ad bir ölçü değerine (örn. 100 ml) benzemiyor; ürün seçeneksiz bırakıldı." });
            }
            continue;
          }
          if (new Set(values).size !== values.length) {
            for (const item of named) {
              report.unmatched.push({ product: product.name, sku: item.variant.sku, name: item.variant.name, reason: "Aynı üründe iki varyant aynı değere sahip; ürün seçeneksiz bırakıldı." });
            }
            continue;
          }
          const attribute = await findOrCreateAttribute(tx, options.attributeName, report);
          const option = await tx.productOption.create({ data: { productId: product.id, name: attribute.name, position: 0, attributeId: attribute.id } });
          const sorted = [...named].sort((a, b) => measureAmount(a.value!) - measureAmount(b.value!));
          for (const [position, item] of sorted.entries()) {
            const shared = await findOrCreateValue(tx, attribute.id, item.value!, report);
            const value = await tx.productOptionValue.create({ data: { optionId: option.id, value: shared.name, position, attributeValueId: shared.id } });
            await tx.variantOptionValue.create({ data: { variantId: item.variant.id, valueId: value.id } });
          }
          report.productsLinked += 1;
        }

        const linked = await tx.productVariant.findMany({
          where: { deletedAt: null, product: productScope, optionValues: { some: {} } },
          select: { id: true },
        });
        report.variantsRenamed = await refreshVariantNames(tx, linked.map((row) => row.id));
        if (options.dryRun) throw new DryRun();
      },
      { timeout: 120_000 },
    );
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  }
  return report;
}

export function reportChanges(report: SetupReport) {
  return report.attributesCreated + report.valuesCreated + report.optionsLinked + report.valuesLinked + report.productsLinked + report.variantsRenamed;
}
