import { del, put } from "@vercel/blob";
import { AppError } from "../common/errors";

export const BLOB_PROVIDER = "vercel-blob";

/** Where a Vercel Blob object lives; kept in Media.metadata.storage. */
export type BlobLocation = { provider: typeof BLOB_PROVIDER; url: string; pathname: string };

const PUBLIC_BLOB_HOST = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i;
const TOKEN_SHAPE = /^vercel_blob_rw_\S+$/;

export const BLOB_UNCONFIGURED_MESSAGE =
  "Vercel Blob yapılandırılmamış: sunucuda BLOB_READ_WRITE_TOKEN tanımlı değil. Görsel yüklenemiyor.";
export const BLOB_INVALID_TOKEN_MESSAGE =
  "Vercel Blob yapılandırması geçersiz: BLOB_READ_WRITE_TOKEN beklenen biçimde değil. Görsel yüklenemiyor.";

export function blobTokenProblem(token: string | undefined) {
  if (!token) return BLOB_UNCONFIGURED_MESSAGE;
  if (!TOKEN_SHAPE.test(token)) return BLOB_INVALID_TOKEN_MESSAGE;
  return null;
}

/** Only https URLs on the public Vercel Blob host are served, so stored metadata cannot become an open redirect. */
export function isBlobUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && PUBLIC_BLOB_HOST.test(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function readBlobLocation(metadata: unknown): BlobLocation | null {
  if (!metadata || typeof metadata !== "object") return null;
  const storage = (metadata as { storage?: unknown }).storage;
  if (!storage || typeof storage !== "object") return null;
  const { provider, url, pathname } = storage as Record<string, unknown>;
  if (provider !== BLOB_PROVIDER || !isBlobUrl(url) || typeof pathname !== "string" || !pathname) return null;
  return { provider: BLOB_PROVIDER, url, pathname };
}

export class BlobStorage {
  constructor(private token: string | undefined) {}

  private credential() {
    const problem = blobTokenProblem(this.token);
    if (problem) throw new AppError(503, "STORAGE_UNCONFIGURED", problem);
    return this.token as string;
  }

  async put(pathname: string, body: Buffer, contentType: string): Promise<BlobLocation> {
    const token = this.credential();
    // The token is always passed explicitly so the SDK never falls back to other process credentials.
    const result = await put(pathname, body, {
      access: "public",
      token,
      contentType,
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 60 * 60 * 24 * 365,
    });
    if (!isBlobUrl(result.url)) throw new Error("Vercel Blob beklenmeyen bir adres döndürdü.");
    return { provider: BLOB_PROVIDER, url: result.url, pathname: result.pathname };
  }

  async delete(location: BlobLocation) {
    await del(location.url, { token: this.credential() });
  }

  /** A loggable summary of an SDK error with the token masked. */
  describe(error: unknown) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    return { name, message: this.token ? message.split(this.token).join("[gizli]") : message };
  }
}
