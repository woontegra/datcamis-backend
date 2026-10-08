import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import path from "path";
import { AppError } from "../common/errors";

export type StoredObject = { body: Buffer; contentType: string };

export interface StorageAdapter {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const SAFE_KEY = /^(seed|uploads)\/[a-zA-Z0-9._-]+$/;

export function assertSafeKey(key: string) {
  if (!SAFE_KEY.test(key) || key.includes("..")) {
    throw new AppError(400, "INVALID_STORAGE_KEY", "Dosya anahtarı geçersiz.");
  }
}

export class LocalStorageAdapter implements StorageAdapter {
  constructor(private root: string) {}

  private resolve(key: string) {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    const base = path.resolve(this.root);
    if (!full.startsWith(base)) {
      throw new AppError(400, "INVALID_STORAGE_KEY", "Dosya anahtarı geçersiz.");
    }
    return full;
  }

  async put(key: string, body: Buffer) {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async get(key: string) {
    try {
      return await readFile(this.resolve(key));
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    await unlink(this.resolve(key)).catch(() => undefined);
  }
}

export class S3StorageAdapter implements StorageAdapter {
  constructor(
    private config: {
      bucket?: string;
      endpoint?: string;
      region?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
    },
  ) {}

  private assertConfigured(): never {
    const missing = ["bucket", "endpoint", "region", "accessKeyId", "secretAccessKey"].filter(
      (key) => !this.config[key as keyof typeof this.config],
    );
    throw new AppError(
      501,
      "STORAGE_UNCONFIGURED",
      "S3/R2 depolama sağlayıcısı yapılandırılmamış.",
      { missing },
    );
  }

  async put(): Promise<void> {
    this.assertConfigured();
  }

  async get(): Promise<Buffer | null> {
    this.assertConfigured();
  }

  async delete(): Promise<void> {
    this.assertConfigured();
  }
}
