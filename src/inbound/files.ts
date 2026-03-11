import WebSocket from "ws";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getWs, sendOneBotAction } from "../ws/connection";
import type { ResolvedInboundFile } from "../types";
import type { InboundFileInfo } from "../inbound/media";

export const INBOUND_FILES_DIRNAME = ".onebot-files";
const FILE_DOWNLOAD_TIMEOUT_MS = 60000;

export function sanitizeFileName(name: string): string {
  return name.replace(/[^\w.\-\u4e00-\u9fff]/g, "_").slice(0, 200);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function downloadFileBuffer(url: string): Promise<Buffer> {
  const http = require("http");
  const https = require("https");
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, (res: any) => {
      const redirect =
        res.statusCode >= 300 && res.statusCode < 400 && typeof res.headers.location === "string"
          ? res.headers.location
          : null;
      if (redirect) {
        const nextUrl = redirect.startsWith("http") ? redirect : new URL(redirect, url).href;
        downloadFileBuffer(nextUrl).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode >= 400) {
        reject(new Error(`File download failed: HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: any) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(FILE_DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error("File download timeout"));
    });
  });
}

export async function resolveInboundFiles(
  fileInfos: InboundFileInfo[],
  workspaceDir: string,
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void },
): Promise<ResolvedInboundFile[]> {
  if (!fileInfos.length) return [];

  const filesDir = join(workspaceDir, INBOUND_FILES_DIRNAME);
  mkdirSync(filesDir, { recursive: true });

  const resolved: ResolvedInboundFile[] = [];

  for (const info of fileInfos) {
    try {
      let downloadUrl = info.url;

      // 如果没有 URL 但有 fileId，尝试通过 get_file API 获取
      if (!downloadUrl && info.fileId) {
        try {
          const w = getWs();
          if (w && w.readyState === WebSocket.OPEN) {
            const resp = await sendOneBotAction(w, "get_file", { file_id: info.fileId });
            const fileData = resp?.data;
            if (fileData?.url) {
              downloadUrl = fileData.url;
            } else if (fileData?.base64) {
              // base64 fallback
              const buf = Buffer.from(fileData.base64, "base64");
              const safeName = sanitizeFileName(info.name);
              const localPath = join(filesDir, `${Date.now()}-${safeName}`);
              writeFileSync(localPath, buf);
              resolved.push({ name: info.name, size: buf.length, localPath });
              logger?.info?.(`[onebot] saved inbound file via base64: ${info.name} → ${localPath}`);
              continue;
            }
          }
        } catch (err: any) {
          logger?.warn?.(`[onebot] get_file API failed for ${info.fileId}: ${err?.message || err}`);
        }
      }

      if (!downloadUrl) {
        logger?.warn?.(`[onebot] no download URL for file: ${info.name}`);
        continue;
      }

      const buf = await downloadFileBuffer(downloadUrl);
      const safeName = sanitizeFileName(info.name);
      const localPath = join(filesDir, `${Date.now()}-${safeName}`);
      writeFileSync(localPath, buf);
      resolved.push({ name: info.name, size: buf.length, localPath });
      logger?.info?.(`[onebot] saved inbound file: ${info.name} (${formatFileSize(buf.length)}) → ${localPath}`);
    } catch (err: any) {
      logger?.warn?.(`[onebot] resolve inbound file failed: ${err?.message || err} (name=${info.name})`);
    }
  }

  return resolved;
}

export function buildFileInfoPromptText(files: ResolvedInboundFile[]): string {
  if (!files.length) return "";
  return files
    .map((f) => `[收到文件: ${f.name}（${formatFileSize(f.size)}），已保存到 ${f.localPath}]`)
    .join("\n");
}
