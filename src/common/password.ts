import argon2 from "argon2";
import { createHash, randomBytes } from "crypto";

export function hashPassword(password: string) {
  return argon2.hash(password, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, password: string) {
  return argon2.verify(hash, password);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
