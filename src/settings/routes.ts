import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireStaff } from "../auth/staff";
import { AppError } from "../common/errors";
import type { Env } from "../config/env";
import { prisma } from "../db";
import { clientIp } from "../orders/checkout";
import { isPaytrConfigured } from "../providers/paytr";
import { CARGO_CARRIERS, readSection, readStoreSettings, saveStoreSettings, SECTION_KEYS, type StoreSettings } from "./store-settings";

const MAINTENANCE_MESSAGE = "Mağazamız kısa bir süre için bakımda. Lütfen daha sonra tekrar deneyin.";

function guardedPath(method: string, url: string) {
  const path = url.split("?")[0];
  if (path === "/api/v1/checkout" || path === "/api/v1/checkout/payment-config") return true;
  if (path === "/api/v1/carts" || path.startsWith("/api/v1/carts/")) return method !== "GET";
  return false;
}

async function isStaff(request: FastifyRequest, env: Env) {
  try {
    await requireStaff(request, env);
    return true;
  } catch {
    return false;
  }
}

/** Visitors cannot start carts or orders during maintenance; staff and the PayTR callback are unaffected. */
export function registerMaintenanceGuard(app: FastifyInstance, env: Env) {
  app.addHook("onRequest", async (request) => {
    if (!guardedPath(request.method, request.url)) return;
    const maintenance = await readSection("maintenance");
    if (!maintenance.enabled) return;
    if (await isStaff(request, env)) return;
    throw new AppError(503, "MAINTENANCE", MAINTENANCE_MESSAGE);
  });
}

async function liveMediaUrls(ids: string[]) {
  const wanted = ids.filter(Boolean);
  if (!wanted.length) return new Map<string, number>();
  const rows = await prisma.media.findMany({ where: { id: { in: wanted }, deletedAt: null }, select: { id: true, updatedAt: true } });
  return new Map(rows.map((row) => [row.id, row.updatedAt.getTime()]));
}

export async function publicSettings(settings: StoreSettings) {
  const { general, company, contact, social, shipping, payment, order, announcement, maintenance } = settings;
  const [live, generalRow] = await Promise.all([
    liveMediaUrls([general.logoMediaId, general.iconMediaId]),
    prisma.siteSetting.findUnique({ where: { key: "general" }, select: { key: true } }),
  ]);
  const url = (id: string) => (id && live.has(id) ? `/api/v1/media/${id}/file` : null);
  return {
    general: {
      storeName: general.storeName,
      slogan: general.slogan,
      logoUrl: url(general.logoMediaId),
      iconUrl: url(general.iconMediaId) && `${url(general.iconMediaId)}?v=${general.iconMediaId}-${live.get(general.iconMediaId)}`,
      configured: Boolean(generalRow),
    },
    company,
    contact,
    social: Object.fromEntries(Object.entries(social).filter(([, value]) => Boolean(value))),
    shipping: {
      flatFee: shipping.flatFee,
      freeShippingThreshold: shipping.freeShippingEnabled ? shipping.freeShippingThreshold : null,
      dispatchTime: shipping.dispatchTime,
      defaultCarrier: shipping.defaultCarrier,
    },
    payment: { minOrderAmount: payment.minOrderAmount },
    order: { havalePaymentDays: order.havalePaymentDays },
    announcement: { enabled: announcement.enabled && Boolean(announcement.text), text: announcement.enabled ? announcement.text : "" },
    maintenance: { enabled: maintenance.enabled },
  };
}

export function registerSettingsRoutes(app: FastifyInstance, env: Env) {
  app.get("/api/v1/settings/public", async () => ({ data: await publicSettings(await readStoreSettings()) }));

  app.get("/api/v1/admin/settings", async (request) => {
    await requireStaff(request, env, ["OWNER", "ADMIN"]);
    const [settings, saved] = await Promise.all([
      readStoreSettings(),
      prisma.siteSetting.findMany({ where: { key: { in: SECTION_KEYS } }, select: { key: true } }),
    ]);
    return {
      data: {
        settings,
        info: {
          paytrConfigured: isPaytrConfigured(env),
          carriers: CARGO_CARRIERS,
          savedSections: saved.map((row) => row.key),
        },
      },
    };
  });

  app.put("/api/v1/admin/settings", async (request) => {
    const staff = await requireStaff(request, env, ["OWNER", "ADMIN"]);
    const result = await saveStoreSettings(request.body, staff, clientIp(request));
    return { data: { settings: result.settings, changed: result.changes.length } };
  });
}
