import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import path from "path";
import { AppError } from "./common/errors";
import type { Env } from "./config/env";
import { registerRoutes } from "./routes/register";
import { LocalStorageAdapter, S3StorageAdapter, type StorageAdapter } from "./storage/adapter";

export async function buildApp(env: Env) {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", "req.body.password"],
    },
    trustProxy: env.NODE_ENV === "production",
  });

  const storage: StorageAdapter =
    env.STORAGE_PROVIDER === "s3"
      ? new S3StorageAdapter({
          bucket: env.S3_BUCKET,
          endpoint: env.S3_ENDPOINT,
          region: env.S3_REGION,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        })
      : new LocalStorageAdapter(path.resolve(env.STORAGE_LOCAL_ROOT));

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: env.corsOrigins, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
  await app.register(multipart);
  await registerRoutes(app, env, storage);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    const known = error as { statusCode?: number; message?: string };
    const statusCode = known.statusCode ?? 500;
    if (statusCode === 429) {
      return reply.status(429).send({
        error: { code: "RATE_LIMITED", message: "Çok fazla istek. Lütfen daha sonra tekrar deneyin." },
      });
    }
    if (statusCode >= 500) request.log.error(error);
    return reply.status(statusCode).send({
      error: {
        code: statusCode >= 500 ? "INTERNAL" : "REQUEST_ERROR",
        message: statusCode >= 500 ? "Beklenmeyen bir hata oluştu." : known.message || "İstek tamamlanamadı.",
      },
    });
  });

  return app;
}
