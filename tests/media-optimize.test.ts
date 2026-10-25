import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { AppError } from "../src/common/errors";
import { detectImage } from "../src/media/image";
import { imageUsage, optimizeImage, OPTIMIZE_MAX_PIXELS, targetSize, USAGE_RULES, type ImageUsage } from "../src/media/optimize";
import { animatedWebp, photoJpeg, photoPixels, photoPng, photoWebp, transparentPng } from "./helpers/images";

async function optimize(input: Buffer, usage: ImageUsage = "general") {
  const image = detectImage(input);
  if (!image) throw new Error("test görseli tanınmadı");
  const result = await optimizeImage(input, image, usage);
  const meta = await sharp(result.body).metadata();
  return { ...result, meta };
}

async function rejection(input: Buffer) {
  const image = detectImage(input);
  if (!image) throw new Error("test görseli tanınmadı");
  return optimizeImage(input, image, "general").then(
    () => {
      throw new Error("reddedilmesi gerekiyordu");
    },
    (error: unknown) => error as AppError,
  );
}

describe("görsel kullanım türü", () => {
  test("bilinmeyen veya eksik tür 1600 px genel sınıra düşer", () => {
    expect(imageUsage("hero")).toBe("hero");
    expect(imageUsage("banner")).toBe("banner");
    expect(imageUsage("product")).toBe("product");
    expect(imageUsage("logo")).toBe("logo");
    expect(imageUsage("decorative")).toBe("decorative");
    expect(imageUsage(undefined)).toBe("general");
    expect(imageUsage("HERO")).toBe("general");
    expect(imageUsage(["hero"])).toBe("general");
  });
});

describe("çözünürlük kuralları", () => {
  test("hedef boyut en-boy oranını korur ve hiçbir zaman büyütmez", () => {
    expect(targetSize(3000, 2000, USAGE_RULES.general)).toEqual({ width: 1600, height: 1067 });
    expect(targetSize(3000, 2000, USAGE_RULES.hero)).toEqual({ width: 2400, height: 1600 });
    expect(targetSize(3000, 3000, USAGE_RULES.logo)).toEqual({ width: 1200, height: 1200 });
    expect(targetSize(640, 480, USAGE_RULES.hero)).toEqual({ width: 640, height: 480 });
  });

  test("dekoratif görselde dar kenar korunur, yalnızca aşırı büyükse küçültülür", () => {
    expect(targetSize(400, 3500, USAGE_RULES.decorative)).toEqual({ width: 400, height: 3500 });
    expect(targetSize(400, 3500, USAGE_RULES.general)).toEqual({ width: 183, height: 1600 });
    expect(targetSize(3000, 900, USAGE_RULES.decorative)).toEqual({ width: 3000, height: 900 });
    expect(targetSize(2000, 8000, USAGE_RULES.decorative)).toEqual({ width: 1000, height: 4000 });
    expect(targetSize(3000, 3000, USAGE_RULES.decorative)).toEqual({ width: 1200, height: 1200 });
  });
});

describe("optimizeImage", () => {
  test("uzun ve dar şeffaf dekoratif görseli küçültmeden, saydamlığıyla ve yüksek kaliteyle saklar", async () => {
    const input = await transparentPng(400, 3500);
    const result = await optimize(input, "decorative");
    expect(result).toMatchObject({ mimeType: "image/webp", width: 400, height: 3500 });
    expect(result.meta.hasAlpha).toBe(true);
    expect(result.report).toMatchObject({ usage: "decorative", maxSide: 4000, maxShortSide: 1200, quality: 90, resized: false });
    expect(result.body.length).toBeLessThan(input.length);
    const { data, info } = await sharp(result.body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[(1000 * info.width + 10) * info.channels + 3]).toBe(0);
    expect(data[(1000 * info.width + 350) * info.channels + 3]).toBe(255);
  });

  test("logoyu 1200 px'e sığdırır ve yüksek kaliteyle saklar", async () => {
    const result = await optimize(await transparentPng(3000, 1500), "logo");
    expect(result).toMatchObject({ mimeType: "image/webp", width: 1200, height: 600 });
    expect(result.meta.hasAlpha).toBe(true);
    expect(result.report).toMatchObject({ usage: "logo", maxSide: 1200, quality: 90 });
  });

  test("büyük JPEG fotoğrafı WebP'ye çevirir, 1600 px'e sığdırır ve küçültür", async () => {
    const input = await photoJpeg(3000, 2000);
    const result = await optimize(input);
    expect(result).toMatchObject({ mimeType: "image/webp", extension: "webp", width: 1600, height: 1067 });
    expect(result.meta).toMatchObject({ format: "webp", width: 1600, height: 1067 });
    expect(result.body.length).toBeLessThan(input.length);
    expect(result.report).toMatchObject({
      usage: "general",
      maxSide: 1600,
      originalFormat: "jpg",
      originalBytes: input.length,
      originalWidth: 3000,
      originalHeight: 2000,
      outputFormat: "webp",
      outputBytes: result.body.length,
      resized: true,
      strategy: "webp",
    });
    expect(result.report.savingsPercent).toBeGreaterThan(50);
  });

  test("hero ve banner görselleri 2400 px, ürünler 1600 px sınırını kullanır", async () => {
    const input = await photoJpeg(3000, 2000);
    expect((await optimize(input, "hero")).meta).toMatchObject({ width: 2400, height: 1600 });
    expect((await optimize(input, "banner")).meta).toMatchObject({ width: 2400, height: 1600 });
    expect((await optimize(input, "product")).meta).toMatchObject({ width: 1600, height: 1067 });
    const tall = await optimize(await photoJpeg(1000, 3000), "hero");
    expect(tall.meta).toMatchObject({ width: 800, height: 2400 });
  });

  test("küçük görseli büyütmez", async () => {
    const result = await optimize(await photoJpeg(640, 480), "hero");
    expect(result).toMatchObject({ width: 640, height: 480, mimeType: "image/webp" });
    expect(result.report.resized).toBe(false);
  });

  test("PNG fotoğrafı WebP'ye çevirir", async () => {
    const input = await photoPng(1200, 800);
    const result = await optimize(input);
    expect(result).toMatchObject({ mimeType: "image/webp", width: 1200, height: 800 });
    expect(result.body.length).toBeLessThan(input.length / 2);
  });

  test("şeffaf PNG'de saydamlığı korur", async () => {
    const input = await transparentPng(800, 600);
    const result = await optimize(input);
    expect(result.mimeType).toBe("image/webp");
    expect(result.meta.hasAlpha).toBe(true);
    const { data, info } = await sharp(result.body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    expect(alphaAt(10, 300)).toBe(0);
    expect(alphaAt(700, 300)).toBe(255);
  });

  test("WebP girişini yeniden boyutlandırır", async () => {
    const input = await photoWebp(2000, 1000);
    const result = await optimize(input);
    expect(result).toMatchObject({ mimeType: "image/webp", width: 1600, height: 800 });
    expect(result.body.length).toBeLessThan(input.length);
  });

  test("zaten sıkıştırılmış temiz WebP'yi büyütmek yerine olduğu gibi tutar", async () => {
    const input = await photoWebp(300, 200, 40);
    const result = await optimize(input);
    expect(result.report.strategy).toBe("original");
    expect(result.body.equals(input)).toBe(true);
    expect(result.report.savingsPercent).toBe(0);
  });

  test("EXIF yönünü düzeltir ve konum/kamera bilgilerini siler", async () => {
    const input = await photoPixels(300, 200)
      .jpeg({ quality: 90 })
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Make: "Kamera", Copyright: "gizli" } })
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const result = await optimize(input);
    expect(result).toMatchObject({ width: 200, height: 300, mimeType: "image/webp" });
    expect(result.meta.exif).toBeUndefined();
    expect(result.meta.xmp).toBeUndefined();
    expect(result.meta.orientation).toBeUndefined();
    expect(result.body.includes(Buffer.from("Kamera"))).toBe(false);
  });

  test("bozuk (yarım kalmış) dosyayı Türkçe hatayla reddeder", async () => {
    const jpeg = await photoJpeg(1200, 800);
    const error = await rejection(jpeg.subarray(0, Math.floor(jpeg.length * 0.6)));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 422, code: "IMAGE_PROCESSING_FAILED" });
    expect(error.message).toMatch(/optimize edilemedi/);
  });

  test("piksel sayısı sınırı aşan görseli çözmeden reddeder", async () => {
    const huge = await sharp({ create: { width: 8000, height: 7000, channels: 3, background: "#ffffff" } }).png().toBuffer();
    expect(8000 * 7000).toBeGreaterThan(OPTIMIZE_MAX_PIXELS);
    const error = await rejection(huge);
    expect(error).toMatchObject({ statusCode: 400, code: "IMAGE_TOO_LARGE" });
    expect(error.message).toMatch(/megapiksel/);
  });

  test("hareketli WebP'yi reddeder", async () => {
    const error = await rejection(await animatedWebp());
    expect(error).toMatchObject({ statusCode: 400, code: "UNSUPPORTED_MEDIA" });
  });

  test("imzası ile içeriği uyuşmayan dosyayı reddeder", async () => {
    const png = await photoPng(100, 100);
    const error = await optimizeImage(png, { mimeType: "image/jpeg", extension: "jpg", width: 100, height: 100 }, "general").catch((e: unknown) => e);
    expect(error).toMatchObject({ statusCode: 400, code: "INVALID_IMAGE" });
  });
});
