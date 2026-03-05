import http from "http";
import https from "https";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { extname, join } from "path";

const DEFAULT_VIDEO_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30 * 1000;
const MAX_REDIRECTS = 5;

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".m4v",
  ".flv",
]);

type ResolveVideoOptions = {
  cacheMaxAgeMs?: number;
  maxBytes?: number;
};

function toForwardSlashPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function toFileUri(localPath: string): string {
  const normalized = toForwardSlashPath(localPath);
  if (normalized.startsWith("file://")) return normalized;
  return `file://${normalized}`;
}

function ensureCacheDir(cacheDir: string): string {
  mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

function resolveEffectiveMaxBytes(maxBytes?: number): number {
  if (Number.isFinite(maxBytes) && Number(maxBytes) > 0) {
    return Math.floor(Number(maxBytes));
  }
  return DEFAULT_VIDEO_MAX_BYTES;
}

function resolveEffectiveMaxAgeMs(maxAgeMs?: number): number {
  if (Number.isFinite(maxAgeMs) && Number(maxAgeMs) > 0) {
    return Math.floor(Number(maxAgeMs));
  }
  return DEFAULT_VIDEO_CACHE_MAX_AGE_MS;
}

function assertVideoSize(size: number, source: string, maxBytes: number): void {
  if (size > maxBytes) {
    throw new Error(`视频超过大小限制(${Math.floor(maxBytes / 1024 / 1024)}MB): ${source}`);
  }
}

function safeVideoExtFromSource(source: string): string {
  const ext = extname(source.split("?")[0] || "").toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return ext;
  return ".mp4";
}

function detectVideoType(buf: Buffer): "mp4" | "avi" | "webm-or-mkv" | null {
  if (buf.length >= 12 && buf.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 11).toString("ascii") === "AVI"
  ) {
    return "avi";
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return "webm-or-mkv";
  }
  return null;
}

function assertVideoBuffer(buf: Buffer, source: string): void {
  if (!buf.length) throw new Error(`视频内容为空: ${source}`);
  const ext = safeVideoExtFromSource(source);
  if (!VIDEO_EXTENSIONS.has(ext)) return;
  const detected = detectVideoType(buf.subarray(0, Math.min(buf.length, 64)));
  if (!detected) {
    throw new Error(`视频格式无效或损坏: ${source}`);
  }
}

function writeBufferToCache(cacheDir: string, ext: string, buf: Buffer): string {
  ensureCacheDir(cacheDir);
  const filePath = join(
    cacheDir,
    `video-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext || ".mp4"}`,
  );
  writeFileSync(filePath, buf);
  return toForwardSlashPath(filePath);
}

function cacheLocalFileForNapCat(localPath: string, cacheDir: string, maxBytes: number): string {
  const normalized = toForwardSlashPath(
    localPath.startsWith("file://") ? decodeURIComponent(localPath.slice("file://".length)) : localPath,
  );
  if (!existsSync(normalized)) {
    return toFileUri(normalized);
  }

  const st = statSync(normalized);
  assertVideoSize(st.size, normalized, maxBytes);
  ensureCacheDir(cacheDir);
  const ext = safeVideoExtFromSource(normalized);
  const cachedPath = join(
    cacheDir,
    `video-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`,
  );
  copyFileSync(normalized, cachedPath);
  return toFileUri(toForwardSlashPath(cachedPath));
}

function downloadUrlWithLimit(url: string, maxBytes: number, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) {
      reject(new Error(`视频下载重定向次数过多: ${url}`));
      return;
    }

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
        downloadUrlWithLimit(nextUrl, maxBytes, redirects + 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`视频下载失败: HTTP ${res.statusCode}`));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk) => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += part.length;
        if (total > maxBytes) {
          req.destroy();
          reject(new Error(`视频超过大小限制(${Math.floor(maxBytes / 1024 / 1024)}MB): ${url}`));
          return;
        }
        chunks.push(part);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`视频下载超时: ${url}`));
    });
  });
}

function resolveVideoExtFromMime(mime: string): string {
  const map: Record<string, string> = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/x-msvideo": ".avi",
    "video/x-flv": ".flv",
  };
  return map[mime.toLowerCase()] || ".mp4";
}

export function cleanupVideoCache(cacheDir: string, maxAgeMs = DEFAULT_VIDEO_CACHE_MAX_AGE_MS): void {
  const effectiveMaxAgeMs = resolveEffectiveMaxAgeMs(maxAgeMs);
  try {
    const files = readdirSync(cacheDir);
    const now = Date.now();
    for (const file of files) {
      const fullPath = join(cacheDir, file);
      try {
        const st = statSync(fullPath);
        if (st.isFile() && now - st.mtimeMs > effectiveMaxAgeMs) {
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

export async function resolveVideoForNapCat(
  video: string,
  cacheDir: string,
  options: ResolveVideoOptions = {},
): Promise<string> {
  const trimmed = String(video || "").trim();
  if (!trimmed) throw new Error("视频地址不能为空");

  const maxBytes = resolveEffectiveMaxBytes(options.maxBytes);
  cleanupVideoCache(cacheDir, options.cacheMaxAgeMs);

  if (/^https?:\/\//i.test(trimmed)) {
    const buf = await downloadUrlWithLimit(trimmed, maxBytes);
    assertVideoBuffer(buf, trimmed);
    return toFileUri(writeBufferToCache(cacheDir, safeVideoExtFromSource(trimmed), buf));
  }

  if (trimmed.startsWith("base64://")) {
    const raw = trimmed.slice("base64://".length);
    const buf = Buffer.from(raw, "base64");
    assertVideoSize(buf.length, "base64://", maxBytes);
    assertVideoBuffer(buf, "base64://video.mp4");
    return toFileUri(writeBufferToCache(cacheDir, ".mp4", buf));
  }

  const dataUrlMatch = trimmed.match(/^data:(video\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (dataUrlMatch) {
    const mime = dataUrlMatch[1].toLowerCase();
    const raw = dataUrlMatch[2];
    const buf = Buffer.from(raw, "base64");
    assertVideoSize(buf.length, "data-url", maxBytes);
    assertVideoBuffer(buf, `data:${mime}`);
    return toFileUri(writeBufferToCache(cacheDir, resolveVideoExtFromMime(mime), buf));
  }

  if (trimmed.startsWith("file://") || existsSync(trimmed)) {
    return cacheLocalFileForNapCat(trimmed, cacheDir, maxBytes);
  }

  if (trimmed.startsWith("/")) {
    return toFileUri(trimmed);
  }

  return toFileUri(trimmed);
}
