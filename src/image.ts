import http from "http";
import https from "https";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { extname, join } from "path";

const IMAGE_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30000;

function safeExtFromUrl(url: string): string {
  const ext = extname(url.split("?")[0] || "").toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) {
    return ext;
  }
  return ".png";
}

function toForwardSlashPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function downloadUrl(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, (res) => {
      const redirect =
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        typeof res.headers.location === "string"
          ? res.headers.location
          : null;

      if (redirect) {
        const nextUrl = redirect.startsWith("http") ? redirect : new URL(redirect, url).href;
        downloadUrl(nextUrl).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Image download failed: HTTP ${res.statusCode}`));
        return;
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error("Image download timeout"));
    });
  });
}

function ensureCacheDir(cacheDir: string): string {
  mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

function writeBufferToCache(cacheDir: string, ext: string, buf: Buffer): string {
  ensureCacheDir(cacheDir);
  const filePath = join(
    cacheDir,
    `img-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext || ".png"}`,
  );
  writeFileSync(filePath, buf);
  return toForwardSlashPath(filePath);
}

export function cleanupImageCache(cacheDir: string): void {
  try {
    const files = readdirSync(cacheDir);
    const now = Date.now();
    for (const file of files) {
      const fullPath = join(cacheDir, file);
      try {
        const st = statSync(fullPath);
        if (st.isFile() && now - st.mtimeMs > IMAGE_CACHE_MAX_AGE_MS) {
          unlinkSync(fullPath);
        }
      } catch {
        // ignore single file errors
      }
    }
  } catch {
    // ignore when cache dir does not exist
  }
}

export async function resolveImageForNapCat(image: string, cacheDir: string): Promise<string> {
  const trimmed = String(image || "").trim();
  if (!trimmed) {
    throw new Error("图片地址不能为空");
  }

  cleanupImageCache(cacheDir);

  if (/^https?:\/\//i.test(trimmed)) {
    const buf = await downloadUrl(trimmed);
    return writeBufferToCache(cacheDir, safeExtFromUrl(trimmed), buf);
  }

  if (trimmed.startsWith("base64://")) {
    const raw = trimmed.slice("base64://".length);
    const buf = Buffer.from(raw, "base64");
    return writeBufferToCache(cacheDir, ".png", buf);
  }

  const dataUrlMatch = trimmed.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (dataUrlMatch) {
    const mime = dataUrlMatch[1].toLowerCase();
    const raw = dataUrlMatch[2];
    const buf = Buffer.from(raw, "base64");
    const extMap: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/bmp": ".bmp",
    };
    return writeBufferToCache(cacheDir, extMap[mime] || ".png", buf);
  }

  if (trimmed.startsWith("file://")) {
    return toForwardSlashPath(trimmed.slice("file://".length));
  }

  return toForwardSlashPath(trimmed);
}
