import path from "path";
import { readdirSync } from "fs";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

const blob = vi.hoisted(() => ({
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ put: blob.put, del: blob.del }));

import { buildApp } from "../src/app";
import { loadEnv } from "../src/config/env";
import { loadDotEnv } from "../src/load-env";
import { prisma } from "../src/db";
import { blobTokenProblem, isBlobUrl, readBlobLocation } from "../src/storage/blob";
import { storageStatus } from "../src/storage/persistence";

loadDotEnv();
const base = loadEnv();
// A shape-valid placeholder; the SDK is mocked, so nothing leaves this process.
const TOKEN = ["vercel", "blob", "rw", "teststore", "yertutucu"].join("_");
const env = { ...base, STORAGE_PROVIDER: "blob" as const, BLOB_READ_WRITE_TOKEN: TOKEN };
const STORE = "https://teststore.public.blob.vercel-storage.com";
const PAGE_SLUG = "blob-taslak-test";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const WEBP = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = "";
const created: string[] = [];
const uploadsBefore = readdirSync(path.resolve(base.STORAGE_LOCAL_ROOT, "uploads")).sort();

function multipart(filename: string, type: string, content: Buffer) {
  const boundary = "----datcamis-blob-boundary";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function upload(target: typeof app, filename: string, type: string, content: Buffer) {
  const body = multipart(filename, type, content);
  const response = await target.inject({ method: "POST", url: "/api/v1/admin/media", headers: { ...body.headers, cookie }, payload: body.payload });
  if (response.statusCode === 200) created.push(response.json().data.id);
  return response;
}

function storedBlob() {
  blob.put.mockImplementation(async (pathname: string, _body: Buffer, options: { contentType: string }) => ({
    url: `${STORE}/${pathname}`,
    downloadUrl: `${STORE}/${pathname}?download=1`,
    pathname,
    contentType: options.contentType,
    contentDisposition: "inline",
  }));
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  await prisma.page.deleteMany({ where: { slug: PAGE_SLUG, publishedRevisionId: null } });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/admin/auth/login",
    payload: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const list = ([] as string[]).concat(login.headers["set-cookie"] ?? []);
  cookie = list.find((item) => item.startsWith("dm_access="))!.split(";")[0];
});

afterEach(() => {
  blob.put.mockReset();
  blob.del.mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.page.deleteMany({ where: { slug: PAGE_SLUG, publishedRevisionId: null } });
  await prisma.auditLog.deleteMany({ where: { entityType: "media", entityId: { in: created } } });
  await prisma.media.deleteMany({ where: { id: { in: created } } });
  await app.close();
  await prisma.$disconnect();
});

describe("Vercel Blob yapılandırması", () => {
  test("token yoksa veya biçimi bozuksa yüklemeyi kapatır, Railway diski gerekmez", () => {
    expect(blobTokenProblem(undefined)).toMatch(/BLOB_READ_WRITE_TOKEN tanımlı değil/);
    expect(blobTokenProblem("yanlis")).toMatch(/beklenen biçimde değil/);
    expect(blobTokenProblem(TOKEN)).toBeNull();
    const railway = { ...env, NODE_ENV: "production" as const, RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: undefined, STORAGE_PERSISTENT: undefined };
    expect(storageStatus(railway).persistent).toBe(true);
    expect(storageStatus({ ...railway, BLOB_READ_WRITE_TOKEN: undefined })).toMatchObject({ persistent: false, code: "STORAGE_UNCONFIGURED" });
    expect(storageStatus({ ...railway, STORAGE_PROVIDER: "local" }).persistent).toBe(false);
  });

  test("hata kayıtlarında token gizlenir", async () => {
    const { BlobStorage } = await import("../src/storage/blob");
    const summary = new BlobStorage(TOKEN).describe(new Error(`istek reddedildi ${TOKEN}`));
    expect(summary.message).toBe("istek reddedildi [gizli]");
    expect(JSON.stringify(summary)).not.toContain(TOKEN);
  });

  test("yalnızca public Vercel Blob adreslerini kabul eder", () => {
    expect(isBlobUrl(`${STORE}/uploads/a.png`)).toBe(true);
    expect(isBlobUrl("http://teststore.public.blob.vercel-storage.com/uploads/a.png")).toBe(false);
    expect(isBlobUrl("https://evil.example.com/uploads/a.png")).toBe(false);
    expect(isBlobUrl("https://teststore.public.blob.vercel-storage.com.evil.com/a.png")).toBe(false);
    expect(isBlobUrl("https://user:pw@teststore.public.blob.vercel-storage.com/a.png")).toBe(false);
    expect(readBlobLocation({ storage: { provider: "vercel-blob", url: "https://evil.example.com/a.png", pathname: "a.png" } })).toBeNull();
    expect(readBlobLocation({ uploadedBy: "x" })).toBeNull();
  });

  test("token eksikken uygulama açılır ve yükleme açık Türkçe hata verir", async () => {
    const bare = await buildApp({ ...env, BLOB_READ_WRITE_TOKEN: undefined });
    await bare.ready();
    try {
      const before = await prisma.media.count();
      const response = await upload(bare, "a.png", "image/png", PNG);
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toMatchObject({
        code: "STORAGE_UNCONFIGURED",
        message: "Vercel Blob yapılandırılmamış: sunucuda BLOB_READ_WRITE_TOKEN tanımlı değil. Görsel yüklenemiyor.",
      });
      expect(blob.put).not.toHaveBeenCalled();
      expect(await prisma.media.count()).toBe(before);
      const list = await bare.inject({ method: "GET", url: "/api/v1/admin/media", headers: { cookie } });
      expect(list.statusCode).toBe(200);
      expect(list.json().meta.upload).toMatchObject({ enabled: false });
    } finally {
      await bare.close();
    }
  });
});

describe("Blob ile yükleme ve okuma", () => {
  test("görseli benzersiz adla Blob'a yükler, kimliği ve konumu Media kaydına yazar", async () => {
    storedBlob();
    const response = await upload(app, "Datça Zeytin.webp", "image/webp", WEBP);
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data).toMatchObject({ mimeType: "image/webp", width: 1, height: 1, url: `/api/v1/media/${data.id}/file` });
    expect(JSON.stringify(response.json())).not.toContain(TOKEN);
    expect(JSON.stringify(response.json())).not.toContain("blob.vercel-storage.com");

    expect(blob.put).toHaveBeenCalledTimes(1);
    const [pathname, body, options] = blob.put.mock.calls[0];
    expect(pathname).toMatch(/^uploads\/[a-f0-9]{32}\.webp$/);
    expect(Buffer.compare(body, WEBP)).toBe(0);
    expect(options).toMatchObject({ access: "public", token: TOKEN, contentType: "image/webp", addRandomSuffix: false, allowOverwrite: false });

    const row = await prisma.media.findUniqueOrThrow({ where: { id: data.id } });
    expect(row).toMatchObject({ storageProvider: "S3", storageKey: pathname, filename: "datca-zeytin.webp", sizeBytes: WEBP.length });
    expect(row.metadata).toMatchObject({ storage: { provider: "vercel-blob", url: `${STORE}/${pathname}`, pathname } });
    expect(readdirSync(path.resolve(base.STORAGE_LOCAL_ROOT, "uploads")).sort()).toEqual(uploadsBefore);

    const file = await app.inject({ method: "GET", url: data.url });
    expect(file.statusCode).toBe(302);
    expect(file.headers.location).toBe(`${STORE}/${pathname}`);
    const head = await app.inject({ method: "HEAD", url: data.url });
    expect(head.statusCode).toBe(302);

    const list = await app.inject({ method: "GET", url: "/api/v1/admin/media", headers: { cookie } });
    expect(list.json().data[0]).toMatchObject({ id: data.id, url: data.url });
    expect(list.json().meta.upload).toMatchObject({ enabled: true });
  });

  test("Blob'a yüklenen görsel Page Builder taslağına kaydedilir ve geri okunur", async () => {
    const mediaId = created[0];
    const document = {
      version: 2,
      sections: [],
      editor: { target: "home", copies: {}, layers: [], images: { "home.hero.photo": { mediaId, fit: "cover" } } },
    };
    const page = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pages",
      headers: { cookie },
      payload: { title: "Blob taslak testi", slug: PAGE_SLUG, document },
    });
    expect(page.statusCode).toBe(200);
    const pageId = page.json().data.id as string;
    const revision = await app.inject({
      method: "POST",
      url: `/api/v1/admin/pages/${pageId}/revisions`,
      headers: { cookie },
      payload: { document, baseVersion: 1 },
    });
    expect(revision.statusCode).toBe(200);
    const reloaded = await app.inject({ method: "GET", url: `/api/v1/admin/pages/${pageId}`, headers: { cookie } });
    expect(reloaded.json().data.revisions[0].document.editor.images["home.hero.photo"].mediaId).toBe(mediaId);
  });

  test("eski yerel medya kayıtları Blob açıkken de okunur", async () => {
    const legacy = await prisma.media.findFirst({ where: { storageProvider: "LOCAL", deletedAt: null }, orderBy: { createdAt: "asc" } });
    expect(legacy).not.toBeNull();
    const file = await app.inject({ method: "GET", url: `/api/v1/media/${legacy!.id}/file` });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toContain(legacy!.mimeType);
    expect(blob.put).not.toHaveBeenCalled();
  });

  test("içerik, tür ve boyut doğrulaması Blob'a gitmeden önce yapılır", async () => {
    storedBlob();
    const fake = await upload(app, "sahte.png", "image/png", Buffer.from("<html></html>"));
    expect(fake.statusCode).toBe(400);
    const svg = await upload(app, "a.svg", "image/svg+xml", Buffer.from("<svg/>"));
    expect(svg.statusCode).toBe(400);
    const big = await upload(app, "buyuk.png", "image/png", Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]));
    expect(big.statusCode).toBe(413);
    const anonymous = await app.inject({ method: "POST", url: "/api/v1/admin/media", ...multipart("a.png", "image/png", PNG) });
    expect(anonymous.statusCode).toBe(401);
    expect(blob.put).not.toHaveBeenCalled();
  });

  test("Blob hatasında kayıt oluşturmaz ve Türkçe hata döner", async () => {
    blob.put.mockRejectedValue(Object.assign(new Error(`Vercel Blob: Access denied ${TOKEN}`), { name: "BlobAccessError" }));
    const before = await prisma.media.count();
    const response = await upload(app, "a.png", "image/png", PNG);
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toEqual({ code: "STORAGE_UPLOAD_FAILED", message: "Görsel depolamaya yüklenemedi. Lütfen biraz sonra tekrar deneyin." });
    expect(response.body).not.toContain(TOKEN);
    expect(await prisma.media.count()).toBe(before);
  });

  test("veritabanı yazımı başarısız olursa Blob nesnesini geri siler", async () => {
    storedBlob();
    blob.del.mockResolvedValue(undefined);
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("veritabanı kapalı"));
    const before = await prisma.media.count();
    const response = await upload(app, "a.png", "image/png", PNG);
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toEqual({ code: "MEDIA_SAVE_FAILED", message: "Görsel kaydedilemedi. Lütfen tekrar deneyin." });
    const pathname = blob.put.mock.calls[0][0];
    expect(blob.del).toHaveBeenCalledWith(`${STORE}/${pathname}`, { token: TOKEN });
    expect(await prisma.media.count()).toBe(before);
  });

  test("geri silme de başarısız olursa hata yine kontrollü döner", async () => {
    storedBlob();
    blob.del.mockRejectedValue(new Error("ağ hatası"));
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("veritabanı kapalı"));
    const response = await upload(app, "a.png", "image/png", PNG);
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("MEDIA_SAVE_FAILED");
    expect(blob.del).toHaveBeenCalledTimes(1);
  });

  test("başka bir kayıtta kullanılan nesne silinmez", async () => {
    const { MediaStorage } = await import("../src/storage/media-storage");
    const { BlobStorage } = await import("../src/storage/blob");
    const { LocalStorageAdapter } = await import("../src/storage/adapter");
    const row = await prisma.media.findUniqueOrThrow({ where: { id: created[0] } });
    const storage = new MediaStorage(env, new LocalStorageAdapter(path.resolve(base.STORAGE_LOCAL_ROOT)), new BlobStorage(TOKEN));
    const removed = await storage.discard({ storageProvider: "S3", storageKey: row.storageKey, storage: readBlobLocation(row.metadata)! });
    expect(removed).toBe(false);
    expect(blob.del).not.toHaveBeenCalled();
  });

  test("bozuk veya yabancı adres içeren kayıt yönlendirilmez", async () => {
    const row = await prisma.media.create({
      data: {
        storageProvider: "S3",
        storageKey: `uploads/blobtest${Date.now()}.png`,
        filename: "kotu.png",
        originalName: "kotu.png",
        mimeType: "image/png",
        sizeBytes: 1,
        metadata: { storage: { provider: "vercel-blob", url: "https://evil.example.com/a.png", pathname: "a.png" } },
      },
    });
    created.push(row.id);
    const file = await app.inject({ method: "GET", url: `/api/v1/media/${row.id}/file` });
    expect(file.statusCode).toBe(404);
    expect(file.headers.location).toBeUndefined();
  });
});
