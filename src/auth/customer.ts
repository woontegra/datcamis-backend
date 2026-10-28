import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config/env";
import { AppError } from "../common/errors";
import { randomToken, sha256 } from "../common/password";
import { prisma } from "../db";

export const CUSTOMER_COOKIE = "dm_customer";
const SESSION_DAYS = 30;

export type CustomerSession = {
  sessionId: string;
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  marketingConsentAt: Date | null;
  createdAt: Date;
};

function cookieOptions(env: Env) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/",
  };
}

export async function startCustomerSession(request: FastifyRequest, reply: FastifyReply, env: Env, customerId: string) {
  const token = randomToken();
  await prisma.customerSession.create({
    data: {
      customerId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000),
      userAgent: request.headers["user-agent"]?.slice(0, 300),
      ip: request.ip,
    },
  });
  reply.setCookie(CUSTOMER_COOKIE, token, { ...cookieOptions(env), maxAge: SESSION_DAYS * 24 * 60 * 60 });
}

export function clearCustomerCookie(reply: FastifyReply, env: Env) {
  reply.clearCookie(CUSTOMER_COOKIE, cookieOptions(env));
}

export async function optionalCustomer(request: FastifyRequest): Promise<CustomerSession | null> {
  const token = request.cookies[CUSTOMER_COOKIE];
  if (!token || token.length > 200) return null;
  const session = await prisma.customerSession.findUnique({
    where: { tokenHash: sha256(token) },
    include: { customer: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date() || session.customer.deletedAt) return null;
  const customer = session.customer;
  return {
    sessionId: session.id,
    id: customer.id,
    email: customer.email,
    firstName: customer.firstName,
    lastName: customer.lastName,
    phone: customer.phone,
    marketingConsentAt: customer.marketingConsentAt,
    createdAt: customer.createdAt,
  };
}

export async function requireCustomer(request: FastifyRequest): Promise<CustomerSession> {
  const customer = await optionalCustomer(request);
  if (!customer) throw new AppError(401, "UNAUTHENTICATED", "Lütfen giriş yapın.");
  return customer;
}

export async function revokeCurrentCustomerSession(request: FastifyRequest) {
  const token = request.cookies[CUSTOMER_COOKIE];
  if (!token || token.length > 200) return;
  await prisma.customerSession.updateMany({
    where: { tokenHash: sha256(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
