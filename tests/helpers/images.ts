import sharp from "sharp";

/** A photo-like picture: smooth gradients plus seeded grain, so encoders behave as they do on real photos. */
export function photoPixels(width: number, height: number, channels: 3 | 4 = 3) {
  const data = Buffer.alloc(width * height * channels);
  let seed = 12345;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const grain = (seed % 17) - 8;
      const offset = (y * width + x) * channels;
      data[offset] = Math.max(0, Math.min(255, Math.round((x / width) * 200) + 30 + grain));
      data[offset + 1] = Math.max(0, Math.min(255, Math.round((y / height) * 180) + 40 + grain));
      data[offset + 2] = Math.max(0, Math.min(255, Math.round(((x + y) / (width + height)) * 160) + 60 + grain));
      // Transparent left quarter, solid elsewhere.
      if (channels === 4) data[offset + 3] = x < width / 4 ? 0 : 255;
    }
  }
  return sharp(data, { raw: { width, height, channels } });
}

export const photoJpeg = (width: number, height: number) => photoPixels(width, height).jpeg({ quality: 95 }).toBuffer();
export const photoPng = (width: number, height: number) => photoPixels(width, height).png().toBuffer();
export const transparentPng = (width: number, height: number) => photoPixels(width, height, 4).png().toBuffer();
export const photoWebp = (width: number, height: number, quality = 95) => photoPixels(width, height).webp({ quality }).toBuffer();
/** Three 10×10 frames stacked vertically, saved as a looping WebP. */
export function animatedWebp() {
  const frames = Buffer.alloc(10 * 30 * 3);
  for (let offset = 0; offset < frames.length; offset += 3) frames[offset] = Math.floor((offset / frames.length) * 3) * 120;
  return sharp(frames, { raw: { width: 10, height: 30, channels: 3, pageHeight: 10 } }).webp({ loop: 0, delay: [100, 100, 100] }).toBuffer();
}
