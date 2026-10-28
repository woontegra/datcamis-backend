import { createHmac, timingSafeEqual } from "crypto";
import type { Env } from "../config/env";
import { AppError } from "../common/errors";

export const PAYTR_IFRAME_BASE = "https://www.paytr.com/odeme/guvenli/";
const PAYTR_GET_TOKEN_URL = "https://www.paytr.com/odeme/api/get-token";

export type PaytrCredentials = {
  merchantId: string;
  merchantKey: string;
  merchantSalt: string;
  testMode: "0" | "1";
};

export type PaytrBasketLine = { name: string; unitPrice: number; quantity: number };

export type PaytrTokenInput = {
  merchantOid: string;
  email: string;
  paymentAmount: number;
  userIp: string;
  userName: string;
  userAddress: string;
  userPhone: string;
  merchantOkUrl: string;
  merchantFailUrl: string;
  basket: PaytrBasketLine[];
  noInstallment: "0" | "1";
  maxInstallment: string;
  currency: "TL";
};

export type PaytrCallbackFields = {
  merchant_oid?: string;
  status?: string;
  total_amount?: string;
  hash?: string;
  failed_reason_code?: string;
  failed_reason_msg?: string;
};

export function emptyToUndefined(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function paytrCredentialsFromEnv(env: Env): PaytrCredentials | null {
  const merchantId = emptyToUndefined(env.PAYTR_MERCHANT_ID);
  const merchantKey = emptyToUndefined(env.PAYTR_MERCHANT_KEY);
  const merchantSalt = emptyToUndefined(env.PAYTR_MERCHANT_SALT);
  if (!merchantId || !merchantKey || !merchantSalt) return null;
  return {
    merchantId,
    merchantKey,
    merchantSalt,
    testMode: env.PAYTR_TEST_MODE === "0" ? "0" : "1",
  };
}

export function isPaytrConfigured(env: Env) {
  return paytrCredentialsFromEnv(env) !== null;
}

export function encodePaytrBasket(lines: PaytrBasketLine[]) {
  const payload = lines.map((line) => [line.name, (line.unitPrice / 100).toFixed(2), line.quantity]);
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function hmacBase64(key: string, value: string) {
  return createHmac("sha256", key).update(value).digest("base64");
}

export function buildPaytrIframeToken(credentials: PaytrCredentials, input: PaytrTokenInput) {
  const userBasket = encodePaytrBasket(input.basket);
  const hashStr =
    credentials.merchantId +
    input.userIp +
    input.merchantOid +
    input.email +
    String(input.paymentAmount) +
    userBasket +
    input.noInstallment +
    input.maxInstallment +
    input.currency +
    credentials.testMode;
  return hmacBase64(credentials.merchantKey, hashStr + credentials.merchantSalt);
}

export function buildPaytrCallbackHash(credentials: PaytrCredentials, merchantOid: string, status: string, totalAmount: string) {
  return hmacBase64(credentials.merchantKey, merchantOid + credentials.merchantSalt + status + totalAmount);
}

export function verifyPaytrCallbackHash(credentials: PaytrCredentials, fields: PaytrCallbackFields) {
  const merchantOid = fields.merchant_oid?.trim() ?? "";
  const status = fields.status?.trim() ?? "";
  const totalAmount = String(fields.total_amount ?? "").trim();
  const given = fields.hash?.trim() ?? "";
  if (!merchantOid || !status || !totalAmount || !given) return false;
  const expected = buildPaytrCallbackHash(credentials, merchantOid, status, totalAmount);
  const left = Buffer.from(expected);
  const right = Buffer.from(given);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function iframeUrlForToken(token: string) {
  return `${PAYTR_IFRAME_BASE}${token}`;
}

export function siteOrigin(env: Env) {
  return env.corsOrigins[0] || "http://localhost:3010";
}

export function merchantOidFromSequence(last: number, entropy: string) {
  return `DM${last}${entropy.replace(/[^A-Za-z0-9]/g, "").slice(0, 16)}`;
}

export type TokenFetcher = (url: string, body: URLSearchParams) => Promise<{ status: string; token?: string; reason?: string }>;

export async function requestPaytrIframeToken(
  credentials: PaytrCredentials,
  input: PaytrTokenInput,
  fetcher: TokenFetcher = defaultTokenFetcher,
) {
  const paytrToken = buildPaytrIframeToken(credentials, input);
  const body = new URLSearchParams({
    merchant_id: credentials.merchantId,
    user_ip: input.userIp,
    merchant_oid: input.merchantOid,
    email: input.email,
    payment_amount: String(input.paymentAmount),
    paytr_token: paytrToken,
    user_basket: encodePaytrBasket(input.basket),
    debug_on: credentials.testMode,
    no_installment: input.noInstallment,
    max_installment: input.maxInstallment,
    user_name: input.userName,
    user_address: input.userAddress,
    user_phone: input.userPhone,
    merchant_ok_url: input.merchantOkUrl,
    merchant_fail_url: input.merchantFailUrl,
    timeout_limit: "30",
    currency: input.currency,
    test_mode: credentials.testMode,
    lang: "tr",
  });
  const result = await fetcher(PAYTR_GET_TOKEN_URL, body);
  if (result.status !== "success" || !result.token) {
    throw new AppError(502, "PAYTR_TOKEN_FAILED", result.reason || "PayTR ödeme ekranı şu anda açılamadı.");
  }
  return result.token;
}

async function defaultTokenFetcher(url: string, body: URLSearchParams) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await response.json().catch(() => null)) as { status?: string; token?: string; reason?: string } | null;
  if (!json) return { status: "failed", reason: "PayTR yanıtı okunamadı." };
  return { status: json.status ?? "failed", token: json.token, reason: json.reason };
}
