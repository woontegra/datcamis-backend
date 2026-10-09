import path from "path";
import { existsSync } from "fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { loadEnv } from "../src/config/env";
import { loadDotEnv } from "../src/load-env";
import { prisma } from "../src/db";
import { signAccessToken } from "../src/common/tokens";
import { LocalStorageAdapter } from "../src/storage/adapter";
import { storageStatus } from "../src/storage/persistence";
import { detectImage, safeFileName, UPLOAD_MAX_BYTES } from "../src/media/image";

loadDotEnv();
const env = loadEnv();
const storage = new LocalStorageAdapter(path.resolve(env.STORAGE_LOCAL_ROOT));

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);
const WEBP = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>');

let app: Awaited<ReturnType<typeof buildApp>>;
let ownerCookie = "";
let staffToken = "";
let staffUserId = "";
const created: string[] = [];

function accessCookie(setCookie: string | string[] | undefined) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const found = list.find((item) => item.startsWith("dm_access="));
  if (!found) throw new Error("dm_access çerezi yok");
  return found.split(";")[0];
}

function multipart(filename: string, type: string, content: Buffer, extra?: { name: string; value: string }) {
  const boundary = "----datcamis-test-boundary";
  const parts: Buffer[] = [];
  if (extra) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${extra.name}"\r\n\r\n${extra.value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`));
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function upload(target: typeof app, auth: Record<string, string>, filename: string, type: string, content: Buffer) {
  const body = multipart(filename, type, content);
  const response = await target.inject({ method: "POST", url: "/api/v1/admin/media", headers: { ...body.headers, ...auth }, payload: body.payload });
  if (response.statusCode === 200) created.push(response.json().data.id);
  return response;
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/admin/auth/login",
    payload: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  ownerCookie = accessCookie(login.headers["set-cookie"]);
  const staff = await prisma.user.create({
    data: { email: `medya-test-${Date.now()}@datcamis.local`, passwordHash: "kullanilamaz", name: "Medya Test", role: "ORDER_STAFF" },
  });
  staffUserId = staff.id;
  staffToken = await signAccessToken(env, { sub: staff.id, email: staff.email, role: "ORDER_STAFF" });
});

afterAll(async () => {
  const rows = await prisma.media.findMany({ where: { id: { in: created } } });
  for (const row of rows) await storage.delete(row.storageKey);
  await prisma.auditLog.deleteMany({ where: { entityType: "media", entityId: { in: created } } });
  await prisma.media.deleteMany({ where: { id: { in: created } } });
  if (staffUserId) await prisma.user.delete({ where: { id: staffUserId } });
  await app.close();
  await prisma.$disconnect();
});

describe("görsel içeriği", () => {
  test("gerçek JPG, PNG ve WebP baytlarını boyutlarıyla tanır", () => {
    expect(detectImage(PNG)).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
    expect(detectImage(JPEG)).toMatchObject({ mimeType: "image/jpeg", width: 1, height: 1 });
    expect(detectImage(WEBP)).toMatchObject({ mimeType: "image/webp", width: 1, height: 1 });
    expect(detectImage(SVG)).toBeNull();
    expect(detectImage(Buffer.from("bu bir görsel değil"))).toBeNull();
    expect(detectImage(PNG.subarray(0, 20))).toBeNull();
  });

  test("dosya adlarını güvenli üretir", () => {
    expect(safeFileName("../../etc/passwd.png", "png")).toBe("etc-passwd.png");
    expect(safeFileName("Datça Zeytin Ağacı.JPG", "jpg")).toBe("datca-zeytin-agaci.jpg");
    expect(safeFileName("<script>.webp", "webp")).toBe("script.webp");
    expect(safeFileName("....png", "png")).toBe("gorsel.png");
  });

  test("kalıcı olmayan sunucu diskini reddeder", () => {
    expect(storageStatus({ ...env, NODE_ENV: "development", RAILWAY_ENVIRONMENT: undefined, RAILWAY_ENVIRONMENT_NAME: undefined }).persistent).toBe(true);
    expect(storageStatus({ ...env, NODE_ENV: "production", STORAGE_PERSISTENT: undefined, RAILWAY_VOLUME_MOUNT_PATH: undefined }).persistent).toBe(false);
    expect(storageStatus({ ...env, RAILWAY_ENVIRONMENT: "production", STORAGE_PERSISTENT: undefined, RAILWAY_VOLUME_MOUNT_PATH: undefined }).persistent).toBe(false);
    expect(
      storageStatus({ ...env, RAILWAY_ENVIRONMENT: "production", STORAGE_PERSISTENT: undefined, RAILWAY_VOLUME_MOUNT_PATH: "/data", STORAGE_LOCAL_ROOT: "/data/storage" }).persistent,
    ).toBe(true);
    expect(
      storageStatus({ ...env, RAILWAY_ENVIRONMENT: "production", STORAGE_PERSISTENT: undefined, RAILWAY_VOLUME_MOUNT_PATH: "/data", STORAGE_LOCAL_ROOT: "/app/storage" }).persistent,
    ).toBe(false);
    expect(storageStatus({ ...env, NODE_ENV: "production", STORAGE_PERSISTENT: "true" }).persistent).toBe(true);
    expect(storageStatus({ ...env, STORAGE_PROVIDER: "s3" }).persistent).toBe(false);
  });
});

describe("POST /api/v1/admin/media", () => {
  test("oturum ve yetki ister", async () => {
    const anonymous = await upload(app, {}, "a.png", "image/png", PNG);
    expect(anonymous.statusCode).toBe(401);
    const forbidden = await upload(app, { authorization: `Bearer ${staffToken}` }, "a.png", "image/png", PNG);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.message).toBe("Bu işlem için yetkiniz yok.");
  });

  test("JPG, PNG ve WebP yükler, rastgele anahtarla saklar ve listede gösterir", async () => {
    const files: [string, string, Buffer, string][] = [
      ["Zeytin Bahçesi.png", "image/png", PNG, "png"],
      ["limon.jpeg", "image/jpeg", JPEG, "jpg"],
      ["badem.webp", "image/webp", WEBP, "webp"],
    ];
    for (const [name, type, content, extension] of files) {
      const response = await upload(app, { cookie: ownerCookie }, name, type, content);
      expect(response.statusCode).toBe(200);
      const data = response.json().data;
      expect(data).toMatchObject({ mimeType: type, width: 1, height: 1, sizeBytes: content.length, url: `/api/v1/media/${data.id}/file` });
      const row = await prisma.media.findUniqueOrThrow({ where: { id: data.id } });
      expect(row.storageKey).toMatch(new RegExp(`^uploads/[a-f0-9]{32}\\.${extension}$`));
      expect(existsSync(path.resolve(env.STORAGE_LOCAL_ROOT, row.storageKey))).toBe(true);

      const file = await app.inject({ method: "GET", url: data.url });
      expect(file.statusCode).toBe(200);
      expect(file.headers["content-type"]).toContain(type);
      expect(file.headers["x-content-type-options"]).toBe("nosniff");
      expect(file.rawPayload.equals(content)).toBe(true);
    }
    expect(created).toHaveLength(3);

    const list = await app.inject({ method: "GET", url: "/api/v1/admin/media", headers: { cookie: ownerCookie } });
    const body = list.json();
    expect(body.data.slice(0, 3).map((item: { id: string }) => item.id)).toEqual([...created].reverse());
    expect(body.meta.upload).toMatchObject({ enabled: true, maxBytes: UPLOAD_MAX_BYTES });
  });

  test("tehlikeli dosya adı anahtara karışmaz", async () => {
    const response = await upload(app, { cookie: ownerCookie }, "../../etc/passwd.png", "image/png", PNG);
    expect(response.statusCode).toBe(200);
    const row = await prisma.media.findUniqueOrThrow({ where: { id: response.json().data.id } });
    expect(row.storageKey).toMatch(/^uploads\/[a-f0-9]{32}\.png$/);
    expect(row.filename).toMatch(/^[a-z0-9-]+\.png$/);
    expect(row.originalName).not.toMatch(/[\\/]|\.\./);
  });

  test("sahte, desteklenmeyen ve uyuşmayan dosyaları reddeder", async () => {
    const cases: [string, string, Buffer, string][] = [
      ["sahte.png", "image/png", Buffer.from("<html>bu bir görsel değil</html>"), "INVALID_IMAGE"],
      ["vektor.svg", "image/svg+xml", SVG, "UNSUPPORTED_MEDIA"],
      ["vektor.png", "image/png", SVG, "INVALID_IMAGE"],
      ["belge.pdf", "application/pdf", Buffer.from("%PDF-1.4"), "UNSUPPORTED_MEDIA"],
      ["yanlis.jpg", "image/png", PNG, "INVALID_IMAGE"],
      ["yanlis.png", "image/jpeg", PNG, "INVALID_IMAGE"],
      ["uzantisiz", "image/png", PNG, "INVALID_IMAGE"],
      ["calistir.php.png", "image/png", Buffer.concat([Buffer.from("<?php echo 1; ?>"), PNG]), "INVALID_IMAGE"],
      ["bos.png", "image/png", Buffer.alloc(0), "EMPTY_FILE"],
    ];
    for (const [name, type, content, code] of cases) {
      const response = await upload(app, { cookie: ownerCookie }, name, type, content);
      expect(response.statusCode, name).toBe(400);
      expect(response.json().error.code, name).toBe(code);
      expect(response.json().error.message, name).toMatch(/[ğüşıöçİ]|görsel|Dosya/);
    }
  });

  test("8 MB sınırını aşan dosyayı 413 ile reddeder", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(UPLOAD_MAX_BYTES)]);
    const response = await upload(app, { cookie: ownerCookie }, "buyuk.png", "image/png", big);
    expect(response.statusCode).toBe(413);
    expect(response.json().error).toMatchObject({ code: "FILE_TOO_LARGE", message: "Dosya 8 MB sınırını aşıyor. Daha küçük bir görsel seçin." });
  });

  test("dosyasız veya çok parçalı olmayan isteği açık mesajla reddeder", async () => {
    const json = await app.inject({ method: "POST", url: "/api/v1/admin/media", headers: { cookie: ownerCookie }, payload: { file: "x" } });
    expect(json.statusCode).toBe(400);
    expect(json.json().error.message).toBe("Görsel dosyası gönderilmedi.");
    const extra = multipart("a.png", "image/png", PNG, { name: "baska", value: "x" });
    const withField = await app.inject({ method: "POST", url: "/api/v1/admin/media", headers: { ...extra.headers, cookie: ownerCookie }, payload: extra.payload });
    expect(withField.statusCode).toBe(400);
  });

  test("kalıcı depolama yoksa dosyayı kaydetmeden 503 döner", async () => {
    const hosted = await buildApp({ ...env, RAILWAY_ENVIRONMENT: "production", STORAGE_PERSISTENT: undefined, RAILWAY_VOLUME_MOUNT_PATH: undefined });
    await hosted.ready();
    try {
      const before = await prisma.media.count();
      const response = await upload(hosted, { cookie: ownerCookie }, "a.png", "image/png", PNG);
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("STORAGE_NOT_PERSISTENT");
      expect(await prisma.media.count()).toBe(before);
      const list = await hosted.inject({ method: "GET", url: "/api/v1/admin/media", headers: { cookie: ownerCookie } });
      expect(list.json().meta.upload.enabled).toBe(false);
    } finally {
      await hosted.close();
    }
  });
});
