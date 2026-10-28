import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  clearCustomerCookie,
  optionalCustomer,
  requireCustomer,
  revokeCurrentCustomerSession,
  startCustomerSession,
  type CustomerSession,
} from "../auth/customer";
import { AppError, notFound } from "../common/errors";
import { parse } from "../common/parse";
import { hashPassword, verifyPassword } from "../common/password";
import type { Env } from "../config/env";
import { prisma } from "../db";
import { addressSchema } from "../orders/checkout";
import { TURKEY_DISTRICTS, isTurkeyCityDistrict } from "../orders/turkey-locations";
import { customerOrderInclude, serializeCustomerOrderDetail, serializeCustomerOrderSummary } from "./orders";

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const MAX_ADDRESSES = 20;
const INVALID_LOGIN = "E-posta veya şifre hatalı.";
const PASSWORD_MISMATCH = "Şifreler eşleşmiyor.";
const LOCKED_LOGIN = `Çok fazla hatalı deneme yapıldı. Lütfen ${LOCK_MINUTES} dakika sonra tekrar deneyin.`;

const nameField = (label: string) => z.string().trim().min(2, `${label} en az 2 karakter olmalı.`).max(60, `${label} çok uzun.`);
const passwordField = z.string().min(8, "Şifre en az 8 karakter olmalı.").max(200, "Şifre çok uzun.");
const phoneField = z
  .string()
  .trim()
  .max(20, "Telefon numarasını kontrol edin.")
  .optional()
  .transform((value) => value || undefined)
  .refine((value) => !value || value.replace(/\D/g, "").length >= 10, "Telefon numarasını kontrol edin.");

const registerBody = z.object({
  firstName: nameField("Ad"),
  lastName: nameField("Soyad"),
  email: z.string().trim().toLowerCase().email("Geçerli bir e-posta girin.").max(160),
  phone: phoneField,
  password: passwordField,
  passwordConfirm: z.string().max(200),
  privacyAccepted: z.literal(true, { errorMap: () => ({ message: "Aydınlatma Metni’ni okuduğunuzu onaylayın." }) }),
  marketingOptIn: z.boolean().optional(),
}).refine((value) => value.password === value.passwordConfirm, { path: ["passwordConfirm"], message: PASSWORD_MISMATCH });

const loginBody = z.object({
  email: z.string().trim().toLowerCase().email("Geçerli bir e-posta girin.").max(160),
  password: z.string().min(1, "Şifrenizi girin.").max(200),
});

const profileBody = z.object({
  firstName: nameField("Ad"),
  lastName: nameField("Soyad"),
  phone: phoneField,
});

const passwordBody = z.object({
  currentPassword: z.string().min(1, "Mevcut şifrenizi girin.").max(200),
  newPassword: passwordField,
  newPasswordConfirm: z.string().max(200),
}).refine((value) => value.newPassword === value.newPasswordConfirm, { path: ["newPasswordConfirm"], message: PASSWORD_MISMATCH });

const addressBody = addressSchema
  .extend({ isDefault: z.boolean().optional() })
  .superRefine((value, ctx) => {
    if (!TURKEY_DISTRICTS[value.city]) {
      ctx.addIssue({ code: "custom", path: ["city"], message: "Geçerli bir il seçin." });
    } else if (!isTurkeyCityDistrict(value.city, value.district)) {
      ctx.addIssue({ code: "custom", path: ["district"], message: "İlçe, seçilen ile ait değil." });
    }
  });

const idParams = z.object({ id: z.string().trim().min(1).max(64) });

const unknownEmailFailures = new Map<string, { count: number; lockedUntil: number }>();
let dummyHash: Promise<string> | null = null;

function rateLimit(env: Env, production: { max: number; timeWindow: string }) {
  return { rateLimit: env.NODE_ENV === "production" ? production : { max: 120, timeWindow: "1 minute" } };
}

function unknownEmailLocked(email: string) {
  const entry = unknownEmailFailures.get(email);
  return Boolean(entry && entry.lockedUntil > Date.now());
}

function recordUnknownEmailFailure(email: string) {
  if (unknownEmailFailures.size > 5000) unknownEmailFailures.clear();
  const count = (unknownEmailFailures.get(email)?.count ?? 0) + 1;
  unknownEmailFailures.set(email, {
    count: count >= MAX_FAILED_LOGINS ? 0 : count,
    lockedUntil: count >= MAX_FAILED_LOGINS ? Date.now() + LOCK_MINUTES * 60 * 1000 : 0,
  });
}

async function burnPasswordCheck(password: string) {
  dummyHash ??= hashPassword("datcamis-timing-equalizer");
  await verifyPassword(await dummyHash, password).catch(() => false);
}

function profile(customer: Pick<CustomerSession, "id" | "email" | "firstName" | "lastName" | "phone" | "marketingConsentAt" | "createdAt">) {
  return {
    id: customer.id,
    email: customer.email,
    firstName: customer.firstName,
    lastName: customer.lastName,
    phone: customer.phone ?? "",
    marketingOptIn: Boolean(customer.marketingConsentAt),
    createdAt: customer.createdAt,
  };
}

function serializeAddress(row: {
  id: string;
  fullName: string;
  phone: string;
  line1: string;
  line2: string | null;
  district: string;
  city: string;
  postalCode: string;
  country: string;
  isDefault: boolean;
}) {
  return {
    id: row.id,
    fullName: row.fullName,
    phone: row.phone,
    line1: row.line1,
    line2: row.line2 ?? "",
    district: row.district,
    city: row.city,
    postalCode: row.postalCode,
    country: row.country,
    isDefault: row.isDefault,
  };
}

async function listAddresses(customerId: string) {
  const rows = await prisma.address.findMany({
    where: { customerId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
  return rows.map(serializeAddress);
}

function sameAddress(a: z.infer<typeof addressSchema>, b: { fullName: string; phone: string; line1: string; district: string; city: string; postalCode: string }) {
  const norm = (value: string) => value.trim().toLocaleLowerCase("tr");
  return norm(a.fullName) === norm(b.fullName)
    && norm(a.phone) === norm(b.phone)
    && norm(a.line1) === norm(b.line1)
    && norm(a.district) === norm(b.district)
    && norm(a.city) === norm(b.city)
    && norm(a.postalCode) === norm(b.postalCode);
}

export async function saveCheckoutAddress(customerId: string, address: z.infer<typeof addressSchema>) {
  const existing = await prisma.address.findMany({ where: { customerId } });
  if (existing.some((row) => sameAddress(address, row))) return;
  if (existing.length >= MAX_ADDRESSES) return;
  await prisma.address.create({
    data: {
      customerId,
      fullName: address.fullName,
      phone: address.phone,
      line1: address.line1,
      line2: address.line2 || null,
      district: address.district,
      city: address.city,
      postalCode: address.postalCode,
      country: address.country,
      isDefault: !existing.some((row) => row.isDefault),
    },
  });
}

function registrationFailed() {
  return new AppError(400, "REGISTRATION_FAILED", "Bu bilgilerle hesap oluşturulamadı. Hesabınız varsa giriş yapın.");
}

export function registerCustomerRoutes(app: FastifyInstance, env: Env) {
  app.post("/api/v1/account/register", { config: rateLimit(env, { max: 10, timeWindow: "1 hour" }) }, async (request, reply) => {
    const body = parse(registerBody, request.body);
    const passwordHash = await hashPassword(body.password);
    const existing = await prisma.customer.findUnique({ where: { email: body.email } });
    if (existing) throw registrationFailed();
    const now = new Date();
    let customer;
    try {
      customer = await prisma.customer.create({
        data: {
          email: body.email,
          passwordHash,
          firstName: body.firstName,
          lastName: body.lastName,
          phone: body.phone ?? null,
          privacyNoticeAcceptedAt: now,
          marketingConsentAt: body.marketingOptIn ? now : null,
        },
      });
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "P2002") throw registrationFailed();
      throw error;
    }
    await startCustomerSession(request, reply, env, customer.id);
    return { data: profile(customer) };
  });

  app.post("/api/v1/account/login", { config: rateLimit(env, { max: 20, timeWindow: "15 minutes" }) }, async (request, reply) => {
    const body = parse(loginBody, request.body);
    const customer = await prisma.customer.findFirst({ where: { email: body.email, deletedAt: null } });
    if (!customer || !customer.passwordHash) {
      if (unknownEmailLocked(body.email)) throw new AppError(429, "LOGIN_LOCKED", LOCKED_LOGIN);
      await burnPasswordCheck(body.password);
      recordUnknownEmailFailure(body.email);
      throw new AppError(401, "INVALID_CREDENTIALS", INVALID_LOGIN);
    }
    const now = new Date();
    if (customer.loginLockedUntil && customer.loginLockedUntil > now) {
      throw new AppError(429, "LOGIN_LOCKED", LOCKED_LOGIN);
    }
    const valid = await verifyPassword(customer.passwordHash, body.password).catch(() => false);
    if (!valid) {
      const failures = customer.failedLoginCount + 1;
      const lock = failures >= MAX_FAILED_LOGINS;
      await prisma.customer.update({
        where: { id: customer.id },
        data: {
          failedLoginCount: lock ? 0 : failures,
          loginLockedUntil: lock ? new Date(now.getTime() + LOCK_MINUTES * 60 * 1000) : customer.loginLockedUntil,
        },
      });
      throw new AppError(401, "INVALID_CREDENTIALS", INVALID_LOGIN);
    }
    if (customer.failedLoginCount || customer.loginLockedUntil) {
      await prisma.customer.update({ where: { id: customer.id }, data: { failedLoginCount: 0, loginLockedUntil: null } });
    }
    await startCustomerSession(request, reply, env, customer.id);
    return { data: profile(customer) };
  });

  app.post("/api/v1/account/logout", async (request, reply) => {
    await revokeCurrentCustomerSession(request);
    clearCustomerCookie(reply, env);
    return { data: { loggedOut: true } };
  });

  app.get("/api/v1/account/session", async (request) => {
    const customer = await optionalCustomer(request);
    return { data: customer ? profile(customer) : null };
  });

  app.get("/api/v1/account/me", async (request) => {
    const customer = await requireCustomer(request);
    return { data: profile(customer) };
  });

  app.patch("/api/v1/account/profile", async (request) => {
    const customer = await requireCustomer(request);
    const body = parse(profileBody, request.body);
    const updated = await prisma.customer.update({
      where: { id: customer.id },
      data: { firstName: body.firstName, lastName: body.lastName, phone: body.phone ?? null },
    });
    return { data: profile(updated) };
  });

  app.post("/api/v1/account/password", { config: rateLimit(env, { max: 10, timeWindow: "15 minutes" }) }, async (request) => {
    const customer = await requireCustomer(request);
    const body = parse(passwordBody, request.body);
    const row = await prisma.customer.findUnique({ where: { id: customer.id } });
    const valid = row?.passwordHash ? await verifyPassword(row.passwordHash, body.currentPassword).catch(() => false) : false;
    if (!valid) {
      throw new AppError(400, "VALIDATION_ERROR", "Mevcut şifre hatalı.", [{ path: "currentPassword", message: "Mevcut şifre hatalı." }]);
    }
    if (body.currentPassword === body.newPassword) {
      throw new AppError(400, "VALIDATION_ERROR", "Yeni şifre mevcut şifreden farklı olmalı.", [{ path: "newPassword", message: "Yeni şifre mevcut şifreden farklı olmalı." }]);
    }
    const now = new Date();
    await prisma.$transaction([
      prisma.customer.update({ where: { id: customer.id }, data: { passwordHash: await hashPassword(body.newPassword), failedLoginCount: 0, loginLockedUntil: null } }),
      prisma.customerSession.updateMany({
        where: { customerId: customer.id, revokedAt: null, id: { not: customer.sessionId } },
        data: { revokedAt: now },
      }),
    ]);
    return { data: { changed: true } };
  });

  app.get("/api/v1/account/addresses", async (request) => {
    const customer = await requireCustomer(request);
    return { data: await listAddresses(customer.id) };
  });

  app.post("/api/v1/account/addresses", async (request) => {
    const customer = await requireCustomer(request);
    const body = parse(addressBody, request.body);
    const count = await prisma.address.count({ where: { customerId: customer.id } });
    if (count >= MAX_ADDRESSES) throw new AppError(409, "ADDRESS_LIMIT", `En fazla ${MAX_ADDRESSES} adres kaydedebilirsiniz.`);
    const makeDefault = body.isDefault === true || count === 0;
    await prisma.$transaction(async (tx) => {
      if (makeDefault) await tx.address.updateMany({ where: { customerId: customer.id }, data: { isDefault: false } });
      await tx.address.create({
        data: {
          customerId: customer.id,
          fullName: body.fullName,
          phone: body.phone,
          line1: body.line1,
          line2: body.line2 || null,
          district: body.district,
          city: body.city,
          postalCode: body.postalCode,
          country: body.country,
          isDefault: makeDefault,
        },
      });
    });
    return { data: await listAddresses(customer.id) };
  });

  app.patch("/api/v1/account/addresses/:id", async (request) => {
    const customer = await requireCustomer(request);
    const { id } = parse(idParams, request.params);
    const body = parse(addressBody, request.body);
    const current = await prisma.address.findFirst({ where: { id, customerId: customer.id } });
    if (!current) throw notFound("Adres bulunamadı.");
    await prisma.$transaction(async (tx) => {
      if (body.isDefault) await tx.address.updateMany({ where: { customerId: customer.id }, data: { isDefault: false } });
      await tx.address.update({
        where: { id: current.id },
        data: {
          fullName: body.fullName,
          phone: body.phone,
          line1: body.line1,
          line2: body.line2 || null,
          district: body.district,
          city: body.city,
          postalCode: body.postalCode,
          country: body.country,
          ...(body.isDefault ? { isDefault: true } : {}),
        },
      });
    });
    return { data: await listAddresses(customer.id) };
  });

  app.post("/api/v1/account/addresses/:id/default", async (request) => {
    const customer = await requireCustomer(request);
    const { id } = parse(idParams, request.params);
    const current = await prisma.address.findFirst({ where: { id, customerId: customer.id } });
    if (!current) throw notFound("Adres bulunamadı.");
    await prisma.$transaction([
      prisma.address.updateMany({ where: { customerId: customer.id }, data: { isDefault: false } }),
      prisma.address.update({ where: { id: current.id }, data: { isDefault: true } }),
    ]);
    return { data: await listAddresses(customer.id) };
  });

  app.delete("/api/v1/account/addresses/:id", async (request) => {
    const customer = await requireCustomer(request);
    const { id } = parse(idParams, request.params);
    const current = await prisma.address.findFirst({ where: { id, customerId: customer.id } });
    if (!current) throw notFound("Adres bulunamadı.");
    await prisma.$transaction(async (tx) => {
      await tx.address.delete({ where: { id: current.id } });
      if (current.isDefault) {
        const next = await tx.address.findFirst({ where: { customerId: customer.id }, orderBy: { createdAt: "desc" } });
        if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
    return { data: await listAddresses(customer.id) };
  });

  app.get("/api/v1/account/orders", async (request) => {
    const customer = await requireCustomer(request);
    const rows = await prisma.order.findMany({
      where: { customerId: customer.id },
      orderBy: { placedAt: "desc" },
      take: 50,
      include: customerOrderInclude,
    });
    return { data: rows.map(serializeCustomerOrderSummary) };
  });

  app.get("/api/v1/account/orders/:id", async (request) => {
    const customer = await requireCustomer(request);
    const { id } = parse(idParams, request.params);
    const order = await prisma.order.findFirst({
      where: { id, customerId: customer.id },
      include: customerOrderInclude,
    });
    if (!order) throw notFound("Sipariş bulunamadı.");
    return { data: serializeCustomerOrderDetail(order) };
  });
}
