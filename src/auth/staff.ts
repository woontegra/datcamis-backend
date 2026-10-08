import type { StaffRole } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config/env";
import { AppError } from "../common/errors";
import { verifyAccessToken } from "../common/tokens";
import { prisma } from "../db";

export type StaffSession = { id: string; email: string; name: string; role: StaffRole };

export async function requireStaff(request: FastifyRequest, env: Env, roles?: StaffRole[]): Promise<StaffSession> {
  const header = request.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const token = bearer || request.cookies.dm_access;
  if (!token) throw new AppError(401, "UNAUTHENTICATED", "Oturum gerekli.");

  let claims;
  try {
    claims = await verifyAccessToken(env, token);
  } catch {
    throw new AppError(401, "UNAUTHENTICATED", "Oturum geçersiz veya süresi dolmuş.");
  }

  const user = await prisma.user.findFirst({
    where: { id: claims.sub, deletedAt: null, status: "ACTIVE" },
  });
  if (!user) throw new AppError(401, "UNAUTHENTICATED", "Oturum geçersiz.");
  if (roles && !roles.includes(user.role)) {
    throw new AppError(403, "FORBIDDEN", "Bu işlem için yetkiniz yok.");
  }
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export function cookieBase(env: Env) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/",
  };
}

export function setAuthCookies(reply: FastifyReply, env: Env, access: string, refresh: string) {
  reply.setCookie("dm_access", access, { ...cookieBase(env), maxAge: 60 * 15 });
  reply.setCookie("dm_refresh", refresh, {
    ...cookieBase(env),
    path: "/api/v1/admin/auth",
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  });
}

export function clearAuthCookies(reply: FastifyReply, env: Env) {
  reply.clearCookie("dm_access", cookieBase(env));
  reply.clearCookie("dm_refresh", { ...cookieBase(env), path: "/api/v1/admin/auth" });
}
