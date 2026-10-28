import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../common/errors";
import type { Env } from "../config/env";
import { prisma } from "../db";
import { captureStockOnce } from "../orders/stock";
import { paytrCredentialsFromEnv, verifyPaytrCallbackHash, type PaytrCallbackFields } from "../providers/paytr";

function asField(value: unknown) {
  if (Array.isArray(value)) return String(value[0] ?? "");
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function fieldsFrom(request: FastifyRequest): PaytrCallbackFields {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  return {
    merchant_oid: asField(record.merchant_oid),
    status: asField(record.status),
    total_amount: asField(record.total_amount),
    hash: asField(record.hash),
    failed_reason_code: asField(record.failed_reason_code),
    failed_reason_msg: asField(record.failed_reason_msg),
  };
}

async function writeSystemAudit(orderId: string, action: string, text: string, extra?: Record<string, unknown>) {
  await prisma.auditLog.create({
    data: {
      action,
      entityType: "order",
      entityId: orderId,
      metadata: { text, ...extra },
    },
  });
}

export function registerPaytrCallback(app: FastifyInstance, env: Env) {
  app.post("/api/v1/payments/paytr/callback", { config: { rateLimit: { max: 200, timeWindow: "1 minute" } } }, async (request, reply) => {
    const credentials = paytrCredentialsFromEnv(env);
    const fields = fieldsFrom(request);
    if (!credentials) {
      request.log.warn({ merchantOid: fields.merchant_oid }, "PayTR callback anahtarlar tanımsızken geldi.");
      throw new AppError(503, "PAYTR_UNCONFIGURED", "Ödeme bildirimi işlenemedi.");
    }
    if (!verifyPaytrCallbackHash(credentials, fields)) {
      request.log.warn({ merchantOid: fields.merchant_oid }, "PayTR callback imzası doğrulanamadı.");
      throw new AppError(400, "PAYTR_HASH_INVALID", "Bildirim imzası geçersiz.");
    }

    const merchantOid = fields.merchant_oid!.trim();
    const payment = await prisma.payment.findFirst({
      where: { provider: "paytr", providerRef: merchantOid },
      include: { order: { include: { items: true } } },
    });
    if (!payment) {
      request.log.warn({ merchantOid }, "PayTR callback bilinmeyen sipariş.");
      throw new AppError(404, "PAYTR_ORDER_UNKNOWN", "Sipariş bulunamadı.");
    }

    const reported = Number.parseInt(String(fields.total_amount), 10);
    if (!Number.isInteger(reported) || reported !== payment.amount) {
      request.log.warn({ merchantOid, reported, expected: payment.amount }, "PayTR callback tutarı uyuşmuyor.");
      throw new AppError(400, "PAYTR_AMOUNT_MISMATCH", "Bildirim tutarı siparişle uyuşmuyor.");
    }

    if (fields.status === "success") {
      if (payment.status !== "PAID" && payment.order.status !== "PENDING") {
        request.log.warn({ merchantOid, orderStatus: payment.order.status }, "PayTR başarılı bildirimi bekleyen siparişte değil.");
        return reply.type("text/plain").send("OK");
      }
      await prisma.$transaction(async (tx) => {
        if (payment.status !== "PAID") {
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: "PAID",
              metadata: {
                ...(typeof payment.metadata === "object" && payment.metadata && !Array.isArray(payment.metadata) ? payment.metadata : {}),
                paytrStatus: "success",
                merchantOid,
                markedManually: false,
              },
            },
          });
        }
        if (payment.order.status === "PENDING") {
          await tx.order.update({ where: { id: payment.orderId }, data: { status: "CONFIRMED" } });
        }
        await captureStockOnce(tx, payment.orderId);
      });
      if (payment.status !== "PAID") {
        await writeSystemAudit(payment.orderId, "order.payment", "PayTR bildirimi ile ödeme alındı.", { merchantOid, provider: "paytr" });
      }
    } else {
      await prisma.$transaction(async (tx) => {
        if (payment.status === "PAID") return;
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: "FAILED",
            metadata: {
              paytrStatus: fields.status,
              failedReasonCode: fields.failed_reason_code,
              failedReasonMsg: fields.failed_reason_msg,
              merchantOid,
            },
          },
        });
        if (payment.order.status === "PENDING") {
          await tx.order.update({ where: { id: payment.orderId }, data: { status: "CANCELLED" } });
        }
      });
      if (payment.status !== "PAID" && payment.status !== "FAILED") {
        await writeSystemAudit(payment.orderId, "order.payment", "PayTR bildirimi: ödeme başarısız.", { merchantOid, provider: "paytr" });
      }
    }

    return reply.type("text/plain").send("OK");
  });
}
