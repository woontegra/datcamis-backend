import type { Prisma, VariantAttribute, VariantAttributeValue } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireStaff, type StaffSession } from "../auth/staff";
import { AppError, notFound } from "../common/errors";
import { parse } from "../common/parse";
import type { Env } from "../config/env";
import { prisma } from "../db";
import { canEditProductContent, PRODUCT_CONTENT_ROLES, PRODUCT_VIEW_ROLES } from "./roles";

type Db = Prisma.TransactionClient | typeof prisma;

export const MAX_PRODUCT_OPTIONS = 3;
export const ATTRIBUTE_DISPLAYS = ["BUTTONS", "SELECT", "SWATCH"] as const;

/* ---------- Combinations and labels ---------- */

/** Every combination, one item from each group, in group order. */
export function combinations<T>(groups: T[][]): T[][] {
  return groups.reduce<T[][]>((acc, group) => acc.flatMap((prefix) => group.map((item) => [...prefix, item])), [[]]);
}

export function variantLabel(parts: Array<{ name: string; value: string }>) {
  return parts.map((part) => `${part.name}: ${part.value}`).join(" · ");
}

/** Recomputes "Özellik: Değer · …" names for variants that are linked to option values. Order snapshots are untouched. */
export async function refreshVariantNames(db: Db, variantIds: string[]) {
  if (!variantIds.length) return 0;
  const variants = await db.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: { id: true, name: true, optionValues: { select: { value: { select: { value: true, option: { select: { name: true, position: true } } } } } } },
  });
  let changed = 0;
  for (const variant of variants) {
    if (!variant.optionValues.length) continue;
    const name = variantLabel(
      variant.optionValues
        .map((item) => item.value)
        .sort((a, b) => a.option.position - b.option.position)
        .map((value) => ({ name: value.option.name, value: value.value })),
    ).slice(0, 160);
    if (name !== variant.name) {
      await db.productVariant.update({ where: { id: variant.id }, data: { name } });
      changed += 1;
    }
  }
  return changed;
}

/* ---------- Product options (used by the product form) ---------- */

export const productOptionInput = z.object({
  attributeId: z.string().min(1),
  valueIds: z.array(z.string().min(1)).min(1, "Her seçenek için en az bir değer işaretleyin.").max(60),
});

export type ResolvedOption = { attribute: VariantAttribute; position: number; values: VariantAttributeValue[] };

export async function resolveOptions(options: Array<z.infer<typeof productOptionInput>>): Promise<ResolvedOption[]> {
  if (options.length > MAX_PRODUCT_OPTIONS) throw new AppError(400, "OPTIONS_LIMIT", `Bir ürüne en fazla ${MAX_PRODUCT_OPTIONS} seçenek eklenebilir.`);
  if (new Set(options.map((option) => option.attributeId)).size !== options.length) {
    throw new AppError(400, "OPTIONS_DUPLICATE", "Aynı seçenek iki kez eklenemez.");
  }
  const attributes = await prisma.variantAttribute.findMany({
    where: { id: { in: options.map((option) => option.attributeId) } },
    include: { values: { orderBy: [{ position: "asc" }, { name: "asc" }] } },
  });
  return options.map((option, position) => {
    const attribute = attributes.find((row) => row.id === option.attributeId);
    if (!attribute) throw new AppError(400, "ATTRIBUTE_UNKNOWN", "Seçenek bulunamadı; sayfayı yenileyin.");
    const wanted = new Set(option.valueIds);
    const values = attribute.values.filter((value) => wanted.has(value.id));
    if (values.length !== wanted.size) throw new AppError(400, "ATTRIBUTE_VALUE_UNKNOWN", `“${attribute.name}” değerlerinden biri bulunamadı; sayfayı yenileyin.`);
    const { values: _all, ...plain } = attribute;
    return { attribute: plain, position, values };
  });
}

/** Returns the ordered attribute values a variant stands for, or null for a variant without a combination. */
export function variantCombo(resolved: ResolvedOption[], valueIds: string[] | undefined) {
  const ids = valueIds ?? [];
  if (!resolved.length) {
    if (ids.length) throw new AppError(400, "VARIANT_OPTIONS_INVALID", "Seçeneksiz üründe varyanta değer bağlanamaz.");
    return null;
  }
  if (!ids.length) return null;
  const picked = resolved.map((option) => option.values.filter((value) => ids.includes(value.id)));
  if (ids.length !== resolved.length || picked.some((values) => values.length !== 1)) {
    throw new AppError(400, "VARIANT_OPTIONS_INVALID", "Her varyant, her seçenekten tam bir değer içermeli.");
  }
  return picked.map((values) => values[0]);
}

export function comboKey(values: VariantAttributeValue[]) {
  return values.map((value) => value.id).join("|");
}

export function comboName(resolved: ResolvedOption[], values: VariantAttributeValue[]) {
  return variantLabel(resolved.map((option, index) => ({ name: option.attribute.name, value: values[index].name })));
}

/** Makes the product's option rows match the chosen attributes/values. Returns attributeValueId → product option value id. */
export async function writeProductOptions(db: Db, productId: string, resolved: ResolvedOption[]) {
  const existing = await db.productOption.findMany({ where: { productId }, include: { values: true } });
  const matches = resolved.map((option) =>
    existing.find((row) => row.attributeId === option.attribute.id) ??
    existing.find((row) => !row.attributeId && row.name === option.attribute.name),
  );
  const kept = new Set(matches.filter(Boolean).map((row) => row!.id));
  const dropped = existing.filter((row) => !kept.has(row.id)).map((row) => row.id);
  if (dropped.length) await db.productOption.deleteMany({ where: { id: { in: dropped } } });

  const map = new Map<string, string>();
  for (const [index, option] of resolved.entries()) {
    const match = matches[index];
    const row = match
      ? await db.productOption.update({ where: { id: match.id }, data: { name: option.attribute.name, position: option.position, attributeId: option.attribute.id } })
      : await db.productOption.create({ data: { productId, name: option.attribute.name, position: option.position, attributeId: option.attribute.id } });
    const values = match?.values ?? [];
    const valueMatches = option.values.map((value) =>
      values.find((row) => row.attributeValueId === value.id) ?? values.find((row) => !row.attributeValueId && row.value === value.name),
    );
    const keptValues = new Set(valueMatches.filter(Boolean).map((item) => item!.id));
    const droppedValues = values.filter((item) => !keptValues.has(item.id)).map((item) => item.id);
    if (droppedValues.length) await db.productOptionValue.deleteMany({ where: { id: { in: droppedValues } } });
    for (const [position, value] of option.values.entries()) {
      const found = valueMatches[position];
      const saved = found
        ? await db.productOptionValue.update({ where: { id: found.id }, data: { value: value.name, position, attributeValueId: value.id } })
        : await db.productOptionValue.create({ data: { optionId: row.id, value: value.name, position, attributeValueId: value.id } });
      map.set(value.id, saved.id);
    }
  }
  return map;
}

export async function linkVariant(db: Db, variantId: string, productValueIds: string[]) {
  await db.variantOptionValue.deleteMany({ where: { variantId } });
  if (productValueIds.length) await db.variantOptionValue.createMany({ data: productValueIds.map((valueId) => ({ variantId, valueId })) });
}

/* ---------- Usage ---------- */

async function usage(attributeIds: string[]) {
  const [options, values] = await Promise.all([
    prisma.productOption.findMany({ where: { attributeId: { in: attributeIds }, product: { deletedAt: null } }, select: { attributeId: true, productId: true } }),
    prisma.productOptionValue.findMany({
      where: { attributeValueId: { not: null }, option: { attributeId: { in: attributeIds }, product: { deletedAt: null } } },
      select: { attributeValueId: true, option: { select: { productId: true } } },
    }),
  ]);
  const byAttribute = new Map<string, Set<string>>();
  for (const row of options) byAttribute.set(row.attributeId!, (byAttribute.get(row.attributeId!) ?? new Set()).add(row.productId));
  const byValue = new Map<string, Set<string>>();
  for (const row of values) byValue.set(row.attributeValueId!, (byValue.get(row.attributeValueId!) ?? new Set()).add(row.option.productId));
  return {
    attribute: (id: string) => byAttribute.get(id)?.size ?? 0,
    value: (id: string) => byValue.get(id)?.size ?? 0,
  };
}

/* ---------- Admin routes ---------- */

const HEX = /^#[0-9a-fA-F]{6}$/;

const attributeBody = z.object({
  name: z.string().trim().min(1, "Özellik adı gerekli.").max(60),
  displayType: z.enum(ATTRIBUTE_DISPLAYS).default("BUTTONS"),
  values: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        name: z.string().trim().min(1, "Değer adı boş olamaz.").max(60),
        colorHex: z.string().trim().regex(HEX, "Renk kodu #RRGGBB biçiminde olmalı.").nullable().optional(),
      }),
    )
    .max(200)
    .default([]),
});

function assertDistinctValues(values: Array<{ name: string }>) {
  const seen = new Map<string, number>();
  const problems: Array<{ path: string; message: string }> = [];
  values.forEach((value, index) => {
    const key = value.name.toLocaleLowerCase("tr-TR");
    if (seen.has(key)) problems.push({ path: `values.${index}`, message: `“${value.name}” iki kez yazılmış.` });
    seen.set(key, index);
  });
  if (problems.length) throw new AppError(400, "VALUE_DUPLICATE", problems[0].message, problems);
}

async function audit(actor: StaffSession, action: string, entityId: string, text: string, extra: Record<string, unknown> = {}) {
  await prisma.auditLog.create({ data: { actorId: actor.id, action, entityType: "attribute", entityId, metadata: { text, ...extra } as Prisma.InputJsonValue } });
}

function uniqueNameError(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

async function serializeAttributes() {
  const rows = await prisma.variantAttribute.findMany({
    orderBy: [{ position: "asc" }, { name: "asc" }],
    include: { values: { orderBy: [{ position: "asc" }, { name: "asc" }] } },
  });
  const used = await usage(rows.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    displayType: row.displayType,
    productCount: used.attribute(row.id),
    values: row.values.map((value) => ({ id: value.id, name: value.name, colorHex: value.colorHex, productCount: used.value(value.id) })),
  }));
}

export function registerAttributeRoutes(app: FastifyInstance, env: Env) {
  app.get("/api/v1/admin/attributes", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_VIEW_ROLES);
    return { data: await serializeAttributes(), meta: { canEdit: canEditProductContent(staff.role), maxPerProduct: MAX_PRODUCT_OPTIONS } };
  });

  app.post("/api/v1/admin/attributes", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_CONTENT_ROLES);
    const body = parse(attributeBody, request.body);
    assertDistinctValues(body.values);
    const last = await prisma.variantAttribute.aggregate({ _max: { position: true } });
    try {
      const created = await prisma.variantAttribute.create({
        data: {
          name: body.name,
          displayType: body.displayType,
          position: (last._max.position ?? -1) + 1,
          values: { create: body.values.map((value, position) => ({ name: value.name, colorHex: value.colorHex ?? null, position })) },
        },
      });
      await audit(staff, "attribute.create", created.id, `Varyant özelliği oluşturuldu: ${body.name}.`, { values: body.values.map((value) => value.name) });
      return { data: (await serializeAttributes()).find((row) => row.id === created.id) };
    } catch (error) {
      if (uniqueNameError(error)) throw new AppError(409, "ATTRIBUTE_EXISTS", `“${body.name}” adında bir özellik zaten var.`, [{ path: "name", message: "Bu ad kullanılıyor." }]);
      throw error;
    }
  });

  app.put("/api/v1/admin/attributes/:id", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_CONTENT_ROLES);
    const { id } = parse(z.object({ id: z.string().min(1) }), request.params);
    const body = parse(attributeBody, request.body);
    assertDistinctValues(body.values);
    const current = await prisma.variantAttribute.findUnique({ where: { id }, include: { values: true } });
    if (!current) throw notFound("Özellik bulunamadı.");
    const byId = new Map(current.values.map((value) => [value.id, value]));
    for (const value of body.values) {
      if (value.id && !byId.has(value.id)) throw new AppError(400, "VALUE_UNKNOWN", "Değerlerden biri bulunamadı; sayfayı yenileyin.");
    }
    const keptIds = new Set(body.values.map((value) => value.id).filter(Boolean));
    const removed = current.values.filter((value) => !keptIds.has(value.id));
    const used = await usage([id]);
    const blocked = removed.filter((value) => used.value(value.id) > 0);
    if (blocked.length) {
      throw new AppError(
        409,
        "VALUE_IN_USE",
        blocked.map((value) => `“${value.name}” ${used.value(value.id)} üründe kullanılıyor`).join(", ") + "; önce o ürünlerden kaldırın.",
        blocked.map((value) => ({ path: value.id, message: `${used.value(value.id)} üründe kullanılıyor.` })),
      );
    }
    const renamed = body.values.filter((value) => value.id && byId.get(value.id)!.name !== value.name);
    const nameChanged = current.name !== body.name;

    try {
      await prisma.$transaction(async (tx) => {
        await tx.variantAttribute.update({ where: { id }, data: { name: body.name, displayType: body.displayType } });
        if (removed.length) await tx.variantAttributeValue.deleteMany({ where: { id: { in: removed.map((value) => value.id) } } });
        for (const value of renamed) await tx.variantAttributeValue.update({ where: { id: value.id! }, data: { name: `~yeniden-adlandiriliyor~${value.id}` } });
        for (const [position, value] of body.values.entries()) {
          if (value.id) await tx.variantAttributeValue.update({ where: { id: value.id }, data: { name: value.name, colorHex: value.colorHex ?? null, position } });
          else await tx.variantAttributeValue.create({ data: { attributeId: id, name: value.name, colorHex: value.colorHex ?? null, position } });
        }
        if (nameChanged) await tx.productOption.updateMany({ where: { attributeId: id }, data: { name: body.name } });
        for (const value of renamed) await tx.productOptionValue.updateMany({ where: { attributeValueId: value.id }, data: { value: value.name } });
        if (nameChanged || renamed.length) {
          const links = await tx.variantOptionValue.findMany({ where: { value: { option: { attributeId: id } } }, select: { variantId: true } });
          await refreshVariantNames(tx, [...new Set(links.map((link) => link.variantId))]);
        }
      });
    } catch (error) {
      if (uniqueNameError(error)) throw new AppError(409, "ATTRIBUTE_EXISTS", "Bu ad başka bir özellikte veya bir üründe zaten kullanılıyor.", [{ path: "name", message: "Bu ad kullanılıyor." }]);
      throw error;
    }

    const changes = [
      nameChanged ? `ad: ${current.name} → ${body.name}` : "",
      current.displayType !== body.displayType ? `gösterim: ${current.displayType} → ${body.displayType}` : "",
      ...renamed.map((value) => `${byId.get(value.id!)!.name} → ${value.name}`),
      ...removed.map((value) => `silindi: ${value.name}`),
      ...body.values.filter((value) => !value.id).map((value) => `eklendi: ${value.name}`),
    ].filter(Boolean);
    await audit(staff, "attribute.update", id, `Varyant özelliği güncellendi: ${body.name}.`, { changes });
    return { data: (await serializeAttributes()).find((row) => row.id === id) };
  });

  app.delete("/api/v1/admin/attributes/:id", async (request) => {
    const staff = await requireStaff(request, env, PRODUCT_CONTENT_ROLES);
    const { id } = parse(z.object({ id: z.string().min(1) }), request.params);
    const current = await prisma.variantAttribute.findUnique({ where: { id } });
    if (!current) throw notFound("Özellik bulunamadı.");
    const count = (await usage([id])).attribute(id);
    if (count > 0) throw new AppError(409, "ATTRIBUTE_IN_USE", `“${current.name}” ${count} üründe kullanılıyor; silmeden önce o ürünlerden kaldırın.`);
    await prisma.variantAttribute.delete({ where: { id } });
    await audit(staff, "attribute.delete", id, `Varyant özelliği silindi: ${current.name}.`);
    return { data: { deleted: true } };
  });
}
