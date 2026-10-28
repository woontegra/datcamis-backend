import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../common/errors";
import { prisma } from "../db";
import { HAVALE_SETTING_KEY, havaleSettingsSchema, readHavaleSettings, type HavaleSettings } from "../orders/havale";
import { normalizeIban } from "../orders/iban";

export const CARGO_CARRIERS = ["Yurtiçi Kargo", "Aras Kargo", "MNG Kargo", "PTT Kargo", "Sürat Kargo", "UPS"] as const;
const MAX_AMOUNT = 10_000_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function text(max: number, label: string) {
  return z.string({ invalid_type_error: `${label} geçersiz.` }).trim().max(max, `${label} en fazla ${max} karakter olabilir.`).default("");
}

function email(label: string, message: string) {
  return text(160, label).refine((value) => !value || EMAIL_RE.test(value), message);
}

export function phoneDigits(value: string) {
  return value.replace(/[\s().-]/g, "");
}

function isPhone(value: string) {
  const digits = phoneDigits(value);
  if (/^444\d{4}$/.test(digits)) return true;
  return /^(\+90|90|0)?[2-5]\d{9}$/.test(digits);
}

function phone(label: string) {
  return text(24, label).refine((value) => !value || isPhone(value), `${label} geçersiz. Örnek: 0532 123 45 67`);
}

function withScheme(value: string) {
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return /^[^\s/]+\.[^\s/]+/.test(value) ? `https://${value}` : value;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".");
  } catch {
    return false;
  }
}

function link(label: string) {
  return text(500, label)
    .transform(withScheme)
    .refine((value) => !value || isHttpUrl(value), `${label} geçerli bir bağlantı olmalı (https://…).`);
}

function amount(label: string) {
  return z.number({ invalid_type_error: `${label} geçerli bir tutar olmalı.` })
    .int(`${label} geçerli bir tutar olmalı.`)
    .min(0, `${label} negatif olamaz.`)
    .max(MAX_AMOUNT, `${label} çok yüksek.`);
}

const generalSchema = z.object({
  storeName: text(80, "Mağaza adı").refine((value) => value.length >= 2, "Mağaza adı girin."),
  slogan: text(160, "Slogan"),
  logoMediaId: text(40, "Logo"),
  iconMediaId: text(40, "Site ikonu"),
});

const companySchema = z.object({
  legalName: text(200, "Ticari unvan"),
  taxOffice: text(80, "Vergi dairesi"),
  taxNumber: text(10, "Vergi no").refine((value) => !value || /^\d{10}$/.test(value), "Vergi no 10 haneli olmalı."),
  mersisNo: text(16, "MERSİS no").refine((value) => !value || /^\d{16}$/.test(value), "MERSİS no 16 haneli olmalı."),
  tradeRegistryNo: text(40, "Ticaret sicil no").refine((value) => !value || /^[0-9A-Za-z/ -]+$/.test(value), "Ticaret sicil no yalnızca rakam ve harf içermeli."),
  kepAddress: email("KEP adresi", "Geçerli bir KEP adresi girin."),
  address: text(400, "Firma adresi"),
});

const contactSchema = z.object({
  email: email("E-posta", "Geçerli bir e-posta girin."),
  phone: phone("Telefon"),
  whatsapp: phone("WhatsApp numarası"),
  address: text(400, "Adres"),
  workingHours: text(200, "Çalışma saatleri"),
  mapUrl: link("Harita bağlantısı"),
});

const socialSchema = z.object({
  instagram: link("Instagram"),
  facebook: link("Facebook"),
  tiktok: link("TikTok"),
  youtube: link("YouTube"),
  x: link("X"),
  pinterest: link("Pinterest"),
});

const shippingSchema = z.object({
  flatFee: amount("Kargo ücreti").default(0),
  freeShippingEnabled: z.boolean().default(false),
  freeShippingThreshold: amount("Ücretsiz kargo sınırı").nullable().default(null),
  defaultCarrier: z.string().trim().default("").refine(
    (value) => !value || (CARGO_CARRIERS as readonly string[]).includes(value),
    "Listeden bir kargo firması seçin.",
  ),
  dispatchTime: text(80, "Kargoya verme süresi"),
}).superRefine((value, ctx) => {
  if (value.freeShippingEnabled && !value.freeShippingThreshold) {
    ctx.addIssue({ code: "custom", path: ["freeShippingThreshold"], message: "Ücretsiz kargo sınırını girin." });
  }
});

const paymentSchema = z.object({
  minOrderAmount: amount("En düşük sipariş tutarı").nullable().default(null),
});

const orderSchema = z.object({
  numberPrefix: z.string().trim().toUpperCase().max(10, "Önek en fazla 10 karakter olabilir.")
    .refine((value) => /^[A-Z0-9-]*$/.test(value), "Önek yalnızca harf (A-Z), rakam ve tire içerebilir.")
    .default(""),
  havalePaymentDays: z.number({ invalid_type_error: "Gün sayısı girin." }).int("Gün sayısı tam sayı olmalı.")
    .min(1, "En az 1 gün olmalı.").max(30, "En fazla 30 gün olabilir.").nullable().default(null),
});

const announcementSchema = z.object({
  enabled: z.boolean().default(false),
  text: text(240, "Duyuru metni"),
}).superRefine((value, ctx) => {
  if (value.enabled && !value.text) ctx.addIssue({ code: "custom", path: ["text"], message: "Duyuru metni girin." });
});

const maintenanceSchema = z.object({
  enabled: z.boolean().default(false),
});

export const SECTION_SCHEMAS = {
  general: generalSchema,
  company: companySchema,
  contact: contactSchema,
  social: socialSchema,
  shipping: shippingSchema,
  payment: paymentSchema,
  order: orderSchema,
  announcement: announcementSchema,
  maintenance: maintenanceSchema,
} as const;

export type SectionKey = keyof typeof SECTION_SCHEMAS;
export const SECTION_KEYS = Object.keys(SECTION_SCHEMAS) as SectionKey[];

export const SECTION_LABELS: Record<SectionKey | "havale", string> = {
  general: "Genel",
  company: "Firma bilgileri",
  contact: "İletişim",
  social: "Sosyal medya",
  shipping: "Kargo",
  payment: "Ödeme",
  order: "Sipariş",
  announcement: "Duyuru",
  maintenance: "Bakım modu",
  havale: "Havale / EFT",
};

export type StoreSettings = { [K in SectionKey]: z.output<(typeof SECTION_SCHEMAS)[K]> } & { havale: HavaleSettings };

const LEGACY_KEYS = ["storeName", "pricingNotice"] as const;

function record(value: Prisma.JsonValue | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function legacyText(value: Prisma.JsonValue | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

function defaults<K extends SectionKey>(key: K): StoreSettings[K] {
  const result = (SECTION_SCHEMAS[key] as z.ZodTypeAny).safeParse({});
  if (result.success) return result.data;
  return Object.fromEntries(Object.keys((SECTION_SCHEMAS[key] as unknown as { shape?: object }).shape ?? {}).map((field) => [field, ""])) as StoreSettings[K];
}

function coerce<K extends SectionKey>(key: K, stored: Record<string, unknown> | null): StoreSettings[K] {
  const base = { ...defaults(key), ...(stored ?? {}) };
  const result = (SECTION_SCHEMAS[key] as z.ZodTypeAny).safeParse(base);
  if (result.success) return result.data;
  return base as StoreSettings[K];
}

async function derivedOrderPrefix() {
  const latest = await prisma.order.findFirst({ orderBy: { createdAt: "desc" }, select: { number: true } });
  const match = latest?.number.match(/^([A-Z0-9-]{0,10}?)\d+$/);
  return match ? match[1] : "";
}

export async function readStoreSettings(): Promise<StoreSettings> {
  const rows = await prisma.siteSetting.findMany({
    where: { key: { in: [...SECTION_KEYS, ...LEGACY_KEYS] } },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const settings = {} as StoreSettings;
  for (const key of SECTION_KEYS) {
    (settings as Record<string, unknown>)[key] = coerce(key, record(byKey.get(key)));
  }
  if (!byKey.has("general")) settings.general.storeName = legacyText(byKey.get("storeName"));
  if (!byKey.has("announcement")) {
    const notice = legacyText(byKey.get("pricingNotice"));
    settings.announcement = { enabled: Boolean(notice), text: notice };
  }
  if (!byKey.has("order")) settings.order.numberPrefix = await derivedOrderPrefix();
  settings.havale = await readHavaleSettings();
  return settings;
}

export async function readSection<K extends SectionKey>(key: K): Promise<StoreSettings[K]> {
  const row = await prisma.siteSetting.findUnique({ where: { key } });
  if (row) return coerce(key, record(row.value));
  if (key === "order") return { ...defaults("order"), numberPrefix: await derivedOrderPrefix() } as StoreSettings[K];
  return defaults(key);
}

type Issue = { path: string; message: string };

function validate(input: unknown) {
  const body = record(input as Prisma.JsonValue);
  if (!body) throw new AppError(400, "VALIDATION_ERROR", "Gönderilen veri geçersiz.");
  const issues: Issue[] = [];
  const parsed: Partial<StoreSettings> = {};
  for (const key of [...SECTION_KEYS, "havale"] as const) {
    if (!(key in body)) continue;
    const schema: z.ZodTypeAny = key === "havale" ? havaleSettingsSchema : SECTION_SCHEMAS[key];
    const result = schema.safeParse(body[key]);
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({ path: [key, ...issue.path].join("."), message: issue.message });
      }
      continue;
    }
    (parsed as Record<string, unknown>)[key] = key === "havale"
      ? { ...result.data, iban: normalizeIban(result.data.iban) }
      : result.data;
  }
  return { parsed, issues };
}

async function availableMedia(ids: string[]) {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return new Set<string>();
  const found = await prisma.media.findMany({
    where: { id: { in: wanted }, deletedAt: null, mimeType: { startsWith: "image/" } },
    select: { id: true },
  });
  return new Set(found.map((row) => row.id));
}

function maskIban(value: string) {
  return value ? `${value.slice(0, 4)} •••• ${value.slice(-4)}` : "";
}

function display(section: string, field: string, value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (section === "havale" && field === "iban") return maskIban(String(value));
  if (typeof value === "boolean") return value ? "Açık" : "Kapalı";
  return String(value).slice(0, 200);
}

export type SettingsChange = { section: string; field: string; from: string; to: string };

export async function saveStoreSettings(input: unknown, actor: { id: string }, ip: string | null) {
  const { parsed, issues } = validate(input);
  if (parsed.general) {
    const { logoMediaId, iconMediaId } = parsed.general;
    const found = await availableMedia([logoMediaId, iconMediaId]);
    if (logoMediaId && !found.has(logoMediaId)) {
      issues.push({ path: "general.logoMediaId", message: "Seçilen logo Medya Kütüphanesinde bulunamadı." });
    }
    if (iconMediaId && !found.has(iconMediaId)) {
      issues.push({ path: "general.iconMediaId", message: "Seçilen site ikonu Medya Kütüphanesinde bulunamadı." });
    }
  }
  if (issues.length) throw new AppError(400, "VALIDATION_ERROR", "Bazı alanlar hatalı. Lütfen kontrol edin.", issues);

  const current = await readStoreSettings();
  const changes: SettingsChange[] = [];
  const writes: Array<{ key: string; value: Prisma.InputJsonValue }> = [];
  for (const [key, next] of Object.entries(parsed) as Array<[keyof StoreSettings, Record<string, unknown>]>) {
    const before = current[key] as Record<string, unknown>;
    let changed = false;
    for (const field of Object.keys(next)) {
      if (JSON.stringify(before?.[field] ?? null) === JSON.stringify(next[field] ?? null)) continue;
      changed = true;
      changes.push({ section: key, field, from: display(key, field, before?.[field]), to: display(key, field, next[field]) });
    }
    if (changed) writes.push({ key: key === "havale" ? HAVALE_SETTING_KEY : key, value: next as Prisma.InputJsonValue });
  }

  if (writes.length) {
    const sections = [...new Set(changes.map((change) => SECTION_LABELS[change.section as SectionKey]))];
    await prisma.$transaction([
      ...writes.map((write) => prisma.siteSetting.upsert({
        where: { key: write.key },
        update: { value: write.value },
        create: { key: write.key, value: write.value },
      })),
      prisma.auditLog.create({
        data: {
          actorId: actor.id,
          action: "settings.update",
          entityType: "setting",
          entityId: writes.map((write) => write.key).join(","),
          ip,
          metadata: { text: `Ayarlar güncellendi: ${sections.join(", ")}.`, changes },
        },
      }),
    ]);
  }
  return { settings: await readStoreSettings(), changes };
}
