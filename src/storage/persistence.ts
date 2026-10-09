import path from "path";
import type { Env } from "../config/env";
import { blobTokenProblem } from "./blob";

export type StorageStatus = { persistent: true } | { persistent: false; code: "STORAGE_UNCONFIGURED" | "STORAGE_NOT_PERSISTENT"; message: string };

function isInside(child: string, parent: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Uploads are only accepted where files survive a restart. Vercel Blob is persistent once its token is set.
 * A container's own disk (Railway without a volume, or any production host) is temporary, so local storage
 * there must sit inside a mounted volume or be declared persistent by the operator.
 */
export function storageStatus(env: Env): StorageStatus {
  if (env.STORAGE_PROVIDER === "blob") {
    const problem = blobTokenProblem(env.BLOB_READ_WRITE_TOKEN);
    return problem ? { persistent: false, code: "STORAGE_UNCONFIGURED", message: problem } : { persistent: true };
  }
  if (env.STORAGE_PROVIDER === "s3") {
    return { persistent: false, code: "STORAGE_UNCONFIGURED", message: "Kalıcı dosya depolama (S3/R2) yapılandırılmamış; görsel yüklenemiyor." };
  }
  if (env.STORAGE_PERSISTENT === "true") return { persistent: true };
  const hosted = env.NODE_ENV === "production" || !!env.RAILWAY_ENVIRONMENT || !!env.RAILWAY_ENVIRONMENT_NAME;
  if (!hosted) return { persistent: true };
  if (env.RAILWAY_VOLUME_MOUNT_PATH && isInside(env.STORAGE_LOCAL_ROOT, env.RAILWAY_VOLUME_MOUNT_PATH)) return { persistent: true };
  return {
    persistent: false,
    code: "STORAGE_NOT_PERSISTENT",
    message:
      "Sunucuda kalıcı dosya depolama yapılandırılmamış; görseller yeniden başlatmada silineceği için yükleme kapalı. Vercel Blob için STORAGE_PROVIDER=blob ve BLOB_READ_WRITE_TOKEN tanımlanmalı.",
  };
}
