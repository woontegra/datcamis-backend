import sharp, { type Metadata } from "sharp";
import type { FastifyBaseLogger } from "fastify";
import { AppError } from "../common/errors";
import type { DetectedImage, UploadImageType } from "./image";

/** What the picture is for; it decides how large the stored copy may be and how carefully it is encoded. */
export type ImageUsage = "hero" | "banner" | "product" | "logo" | "decorative" | "general";

export type UsageRule = {
  /** Longest side of the stored copy. */
  maxLong: number;
  /**
   * Shortest side of the stored copy. Only decorative art sets it: tall or wide ornaments are limited by their
   * narrow side so a 400×3500 strip is not squeezed to 183 px wide by the long-side rule.
   */
  maxShort?: number;
  quality: number;
};

export const IMAGE_USAGES: ImageUsage[] = ["hero", "banner", "product", "logo", "decorative", "general"];
export const USAGE_RULES: Record<ImageUsage, UsageRule> = {
  hero: { maxLong: 2400, quality: 82 },
  banner: { maxLong: 2400, quality: 82 },
  product: { maxLong: 1600, quality: 82 },
  // Logos and ornaments are small in bytes but show edges and gradients plainly, so they get a higher quality.
  logo: { maxLong: 1200, quality: 90 },
  decorative: { maxLong: 4000, maxShort: 1200, quality: 90 },
  general: { maxLong: 1600, quality: 82 },
};
/** Decoding is bounded by pixel count, not file size: a small file can still expand to gigabytes of pixels. */
export const OPTIMIZE_MAX_PIXELS = 50_000_000;
const OPTIMIZE_TIMEOUT_SECONDS = 30;

type Strategy = "webp" | "webp-lossless" | "original";

export type OptimizationReport = {
  usage: ImageUsage;
  maxSide: number;
  maxShortSide: number | null;
  quality: number;
  originalFormat: DetectedImage["extension"];
  originalBytes: number;
  originalWidth: number;
  originalHeight: number;
  outputFormat: DetectedImage["extension"];
  outputBytes: number;
  outputWidth: number;
  outputHeight: number;
  savingsPercent: number;
  resized: boolean;
  strategy: Strategy;
};

export type OptimizedImage = {
  body: Buffer;
  mimeType: UploadImageType;
  extension: DetectedImage["extension"];
  width: number;
  height: number;
  report: OptimizationReport;
};

// Uploads are one-off; the libvips operation cache would only hold memory between requests.
sharp.cache(false);

/** Anything unknown or missing falls back to the general limit. */
export function imageUsage(value: unknown): ImageUsage {
  return typeof value === "string" && (IMAGE_USAGES as string[]).includes(value) ? (value as ImageUsage) : "general";
}

const TOO_MANY_PIXELS = new AppError(
  400,
  "IMAGE_TOO_LARGE",
  "Görselin çözünürlüğü çok yüksek (en fazla 50 megapiksel). Daha küçük boyutlu bir görsel seçin.",
);
const UNREADABLE = new AppError(400, "INVALID_IMAGE", "Görsel bozuk veya eksik olduğu için açılamadı. Dosyayı kontrol edip tekrar deneyin.");
const ANIMATED = new AppError(400, "UNSUPPORTED_MEDIA", "Hareketli görseller desteklenmiyor. Tek kareli bir JPG, PNG veya WebP seçin.");
const FAILED = new AppError(
  422,
  "IMAGE_PROCESSING_FAILED",
  "Görsel optimize edilemedi; dosya bozuk olabilir. Görseli yeniden kaydedip tekrar deneyin.",
);

function open(input: Buffer) {
  return sharp(input, { failOn: "error", limitInputPixels: OPTIMIZE_MAX_PIXELS, pages: 1 });
}

function savings(before: number, after: number) {
  return Math.round((1 - after / before) * 1000) / 10;
}

/** The upright size after applying the rule; never larger than the source and the aspect ratio is kept. */
export function targetSize(width: number, height: number, rule: UsageRule) {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const scale = Math.min(1, rule.maxLong / long, rule.maxShort ? rule.maxShort / short : 1);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Re-encodes an already validated upload: corrects EXIF orientation, fits it inside the usage limit without
 * enlarging, drops metadata and stores WebP (alpha is kept). The original bytes are never returned on failure.
 */
export async function optimizeImage(input: Buffer, detected: DetectedImage, usage: ImageUsage, log?: FastifyBaseLogger): Promise<OptimizedImage> {
  if (detected.width * detected.height > OPTIMIZE_MAX_PIXELS) throw TOO_MANY_PIXELS;
  let meta: Metadata;
  try {
    meta = await open(input).metadata();
  } catch (error) {
    log?.warn({ err: error }, "Görsel üst bilgisi okunamadı");
    throw UNREADABLE;
  }
  // The decoder must agree with the signature check, so a crafted header cannot smuggle another format.
  if (`image/${meta.format}` !== detected.mimeType || meta.width !== detected.width || meta.height !== detected.height) throw UNREADABLE;
  if ((meta.pages ?? 1) > 1) throw ANIMATED;

  const rule = USAGE_RULES[usage];
  const upright = meta.autoOrient ?? { width: meta.width, height: meta.height };
  const target = targetSize(upright.width, upright.height, rule);
  const encode = async (lossless: boolean) => {
    const pipeline = open(input)
      .rotate()
      .resize({ width: target.width, height: target.height, fit: "fill", withoutEnlargement: true })
      .timeout({ seconds: OPTIMIZE_TIMEOUT_SECONDS });
    const { data, info } = await (lossless ? pipeline.webp({ lossless: true }) : pipeline.webp({ quality: rule.quality })).toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, strategy: (lossless ? "webp-lossless" : "webp") as Strategy };
  };

  let best: Awaited<ReturnType<typeof encode>>;
  try {
    best = await encode(false);
    // Flat graphics and transparent images are often smaller lossless, and then lose no detail at all.
    if (meta.hasAlpha || detected.mimeType === "image/png" || usage === "logo") {
      const lossless = await encode(true);
      if (lossless.data.length <= best.data.length) best = lossless;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/pixel limit/i.test(message)) throw TOO_MANY_PIXELS;
    log?.warn({ err: error }, "Görsel optimize edilemedi");
    throw FAILED;
  }

  const resized = best.width !== upright.width || best.height !== upright.height;
  const rotated = (meta.orientation ?? 1) !== 1;
  const carriesMetadata = !!(meta.exif || meta.xmp || meta.iptc || meta.comments?.length);
  // A file that is already compact cannot be improved by re-encoding; keeping it avoids growth and a second
  // lossy pass. Only clean files qualify, so stored images never carry location or camera metadata.
  const keepOriginal = best.data.length >= input.length && !resized && !rotated && !carriesMetadata;

  const body = keepOriginal ? input : best.data;
  const extension = keepOriginal ? detected.extension : "webp";
  const width = keepOriginal ? detected.width : best.width;
  const height = keepOriginal ? detected.height : best.height;
  return {
    body,
    mimeType: keepOriginal ? detected.mimeType : "image/webp",
    extension,
    width,
    height,
    report: {
      usage,
      maxSide: rule.maxLong,
      maxShortSide: rule.maxShort ?? null,
      quality: rule.quality,
      originalFormat: detected.extension,
      originalBytes: input.length,
      originalWidth: detected.width,
      originalHeight: detected.height,
      outputFormat: extension,
      outputBytes: body.length,
      outputWidth: width,
      outputHeight: height,
      savingsPercent: savings(input.length, body.length),
      resized: !keepOriginal && resized,
      strategy: keepOriginal ? "original" : best.strategy,
    },
  };
}
