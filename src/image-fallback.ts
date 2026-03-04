import { existsSync } from "fs";
import { basename } from "path";
import type { ImageFailureFallback } from "./options";

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? "");
}

export function shouldFallbackToFileUpload(err: unknown, fallback: ImageFailureFallback): boolean {
  if (fallback !== "upload-file") return false;
  const msg = errorMessage(err);
  return /rich media transfer failed/i.test(msg);
}

export function normalizeFileUriToPath(fileRef: string): string {
  const trimmed = String(fileRef || "").trim();
  if (trimmed.startsWith("file://")) {
    return decodeURIComponent(trimmed.slice("file://".length));
  }
  return trimmed;
}

export function toExistingLocalPath(fileRef: string): string | null {
  const localPath = normalizeFileUriToPath(fileRef);
  if (!localPath) return null;
  if (!existsSync(localPath)) return null;
  return localPath;
}

export function resolveUploadFileName(localPath: string): string {
  const name = basename(localPath);
  if (name) return name;
  return "onebot-image.bin";
}
