export type UploadImageType = "image/jpeg" | "image/png" | "image/webp";

export type DetectedImage = { mimeType: UploadImageType; extension: "jpg" | "png" | "webp"; width: number; height: number };

export const UPLOAD_IMAGE_TYPES: UploadImageType[] = ["image/jpeg", "image/png", "image/webp"];
export const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const UPLOAD_MAX_SIDE = 10000;

const EXTENSIONS: Record<UploadImageType, string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
};

function pngSize(buffer: Buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < 33 || !signature.every((byte, index) => buffer[index] === byte)) return null;
  if (buffer.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// Walks JPEG segments up to the first start-of-frame marker, which holds the image size.
function jpegSize(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > buffer.length) return null;
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    offset += 2 + length;
  }
  return null;
}

function webpSize(buffer: Buffer) {
  if (buffer.length < 30 || buffer.toString("latin1", 0, 4) !== "RIFF" || buffer.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = buffer.toString("latin1", 12, 16);
  if (chunk === "VP8 ") {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/** Identifies the image from its bytes; the browser-supplied type and name are not trusted. */
export function detectImage(buffer: Buffer): DetectedImage | null {
  const checks: [UploadImageType, DetectedImage["extension"], (input: Buffer) => { width: number; height: number } | null][] = [
    ["image/jpeg", "jpg", jpegSize],
    ["image/png", "png", pngSize],
    ["image/webp", "webp", webpSize],
  ];
  for (const [mimeType, extension, read] of checks) {
    const size = read(buffer);
    if (!size) continue;
    if (size.width < 1 || size.height < 1 || size.width > UPLOAD_MAX_SIDE || size.height > UPLOAD_MAX_SIDE) return null;
    return { mimeType, extension, ...size };
  }
  return null;
}

export function extensionOf(name: string) {
  const match = name.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return match ? match[1] : "";
}

/** The declared type and the file extension must both agree with the real content. */
export function matchesDeclared(image: DetectedImage, declaredType: string, originalName: string) {
  return declaredType === image.mimeType && EXTENSIONS[image.mimeType].includes(extensionOf(originalName));
}

const TURKISH: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", Ç: "c", Ğ: "g", İ: "i", Ö: "o", Ş: "s", Ü: "u" };

/** A display name made only of safe characters; storage keys never use it. */
export function safeFileName(originalName: string, extension: string) {
  const base = originalName
    .replace(/\.[^.]*$/, "")
    .replace(/[çğıöşüÇĞİÖŞÜ]/g, (letter) => TURKISH[letter] ?? "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60);
  return `${base || "gorsel"}.${extension}`;
}

/** The original name as plain text for the library list. */
export function cleanOriginalName(originalName: string) {
  return originalName.replace(/[\u0000-\u001f\u007f<>"'`\\/]/g, "").trim().slice(0, 200) || "dosya";
}
