import { z } from "zod";
import { AppError } from "../common/errors";
import { prisma } from "../db";
import { isValidTrIban, normalizeIban } from "./iban";

export const HAVALE_SETTING_KEY = "havale";

export type HavaleSettings = {
  enabled: boolean;
  bankName: string;
  accountHolder: string;
  iban: string;
  note: string;
};

const empty: HavaleSettings = {
  enabled: false,
  bankName: "",
  accountHolder: "",
  iban: "",
  note: "",
};

export const havaleSettingsSchema = z.object({
  enabled: z.boolean(),
  bankName: z.string().trim().max(80),
  accountHolder: z.string().trim().max(120),
  iban: z.string().trim().max(34),
  note: z.string().trim().max(300),
}).superRefine((value, ctx) => {
  const iban = normalizeIban(value.iban);
  if (value.enabled) {
    if (value.bankName.length < 2) ctx.addIssue({ code: "custom", path: ["bankName"], message: "Banka adı girin." });
    if (value.accountHolder.length < 3) ctx.addIssue({ code: "custom", path: ["accountHolder"], message: "Hesap sahibi girin." });
    if (!iban) ctx.addIssue({ code: "custom", path: ["iban"], message: "IBAN girin." });
    else if (!/^TR\d{24}$/.test(iban)) ctx.addIssue({ code: "custom", path: ["iban"], message: "IBAN TR ve 26 karakter olmalı." });
    else if (!isValidTrIban(iban)) ctx.addIssue({ code: "custom", path: ["iban"], message: "IBAN kontrol hanesi geçersiz." });
  } else if (iban && !isValidTrIban(iban)) {
    ctx.addIssue({ code: "custom", path: ["iban"], message: "IBAN kontrol hanesi geçersiz." });
  }
});

function asSettings(value: unknown): HavaleSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...empty };
  const row = value as Record<string, unknown>;
  return {
    enabled: row.enabled === true,
    bankName: String(row.bankName ?? "").trim(),
    accountHolder: String(row.accountHolder ?? "").trim(),
    iban: normalizeIban(String(row.iban ?? "")),
    note: String(row.note ?? "").trim(),
  };
}

export function isHavaleReady(settings: HavaleSettings) {
  return settings.enabled && settings.bankName.length >= 2 && settings.accountHolder.length >= 3 && isValidTrIban(settings.iban);
}

export async function readHavaleSettings() {
  const row = await prisma.siteSetting.findUnique({ where: { key: HAVALE_SETTING_KEY } });
  return asSettings(row?.value);
}

export async function saveHavaleSettings(input: unknown) {
  const parsed = havaleSettingsSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "Gönderilen veri geçersiz.", parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })));
  }
  const value: HavaleSettings = {
    ...parsed.data,
    iban: normalizeIban(parsed.data.iban),
  };
  await prisma.siteSetting.upsert({
    where: { key: HAVALE_SETTING_KEY },
    update: { value },
    create: { key: HAVALE_SETTING_KEY, value },
  });
  return value;
}

export function havaleSnapshot(settings: HavaleSettings) {
  return {
    bankName: settings.bankName,
    accountHolder: settings.accountHolder,
    iban: settings.iban,
    note: settings.note,
  };
}
