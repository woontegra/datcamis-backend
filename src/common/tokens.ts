import { jwtVerify, SignJWT } from "jose";
import type { StaffRole } from "@prisma/client";
import type { Env } from "../config/env";

export type AccessClaims = {
  sub: string;
  email: string;
  role: StaffRole;
};

export async function signAccessToken(env: Env, claims: AccessClaims) {
  return new SignJWT({ email: claims.email, role: claims.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(env.ACCESS_TOKEN_TTL)
    .sign(new TextEncoder().encode(env.JWT_ACCESS_SECRET));
}

export async function verifyAccessToken(env: Env, token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(env.JWT_ACCESS_SECRET));
  if (!payload.sub || typeof payload.email !== "string" || typeof payload.role !== "string") {
    throw new Error("Geçersiz erişim jetonu.");
  }
  return { sub: payload.sub, email: payload.email, role: payload.role as StaffRole };
}
