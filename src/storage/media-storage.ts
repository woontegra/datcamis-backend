import type { Prisma, StorageProvider } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { AppError } from "../common/errors";
import type { Env } from "../config/env";
import { prisma } from "../db";
import type { StorageAdapter } from "./adapter";
import { BlobStorage, readBlobLocation, type BlobLocation } from "./blob";

/**
 * Blob objects use the existing S3 (remote object storage) provider value; Media.metadata.storage
 * records that the object is in Vercel Blob and where it lives, so no schema change is needed.
 */
export type SavedObject = { storageProvider: StorageProvider; storageKey: string; storage?: BlobLocation };

export type MediaRecord = { storageProvider: StorageProvider; storageKey: string; metadata: Prisma.JsonValue | null };

export type MediaFile = { kind: "body"; body: Buffer } | { kind: "redirect"; url: string };

export class MediaStorage {
  constructor(
    private env: Env,
    private local: StorageAdapter,
    private blob: BlobStorage,
  ) {}

  /** Writes a new upload to the active provider. */
  async save(key: string, body: Buffer, contentType: string, log?: FastifyBaseLogger): Promise<SavedObject> {
    if (this.env.STORAGE_PROVIDER === "blob") {
      try {
        const storage = await this.blob.put(key, body, contentType);
        return { storageProvider: "S3", storageKey: key, storage };
      } catch (error) {
        if (error instanceof AppError) throw error;
        log?.error({ blobError: this.blob.describe(error), storageKey: key }, "Vercel Blob yüklemesi başarısız");
        throw new AppError(502, "STORAGE_UPLOAD_FAILED", "Görsel depolamaya yüklenemedi. Lütfen biraz sonra tekrar deneyin.");
      }
    }
    if (this.env.STORAGE_PROVIDER === "local") {
      await this.local.put(key, body);
      return { storageProvider: "LOCAL", storageKey: key };
    }
    throw new AppError(503, "STORAGE_UNCONFIGURED", "Seçili depolama sağlayıcısı yapılandırılmamış.");
  }

  /** Reads by the provider recorded on the row, so older local media keep working after switching to Blob. */
  async read(media: MediaRecord): Promise<MediaFile | null> {
    if (media.storageProvider === "LOCAL") {
      const body = await this.local.get(media.storageKey);
      return body ? { kind: "body", body } : null;
    }
    const location = readBlobLocation(media.metadata);
    return location ? { kind: "redirect", url: location.url } : null;
  }

  /**
   * Removes a stored object only when no Media row points at it any more. Used to undo an upload whose
   * database write failed; storage keys are random, so a shared object would mean something is wrong.
   */
  async discard(saved: SavedObject) {
    const users = await prisma.media.count({ where: { storageKey: saved.storageKey } });
    if (users > 0) return false;
    if (saved.storage) {
      try {
        await this.blob.delete(saved.storage);
      } catch (error) {
        throw new Error(`Blob nesnesi silinemedi: ${this.blob.describe(error).message}`);
      }
    } else if (saved.storageProvider === "LOCAL") {
      await this.local.delete(saved.storageKey);
    }
    return true;
  }
}
