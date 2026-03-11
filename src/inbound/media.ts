import { existsSync } from "node:fs";
import { extname } from "node:path";
import { resolveImageForNapCat } from "../media/image";

type OneBotSegment = {
  type?: string;
  data?: Record<string, unknown>;
};

type OneBotInboundLike = {
  message?: OneBotSegment[];
  raw_message?: string;
  self_id?: number;
};

export interface InboundFileInfo {
  name: string;
  size?: number;
  url?: string;
  fileId?: string;
}

export interface ParsedOneBotInboundMessage {
  text: string;
  imageSources: string[];
  replyMessageId?: string | number;
  fileInfos: InboundFileInfo[];
  forwardId?: string;
}

export interface ResolvedInboundMedia {
  paths: string[];
  urls: string[];
  types: string[];
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function parseImageSourceFromSegment(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  const candidates = ["url", "path", "file", "src", "origin"] as const;
  for (const key of candidates) {
    const value = data[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function parseReplyMessageId(data: Record<string, unknown> | undefined): string | number | undefined {
  if (!data) return undefined;
  const candidates = [data.id, data.message_id, data.messageId];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return value;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) continue;
      if (/^\d+$/.test(trimmed)) {
        const num = Number(trimmed);
        if (Number.isSafeInteger(num) && num > 0) {
          return num;
        }
      }
      return trimmed;
    }
  }
  return undefined;
}

function parseCqImageSources(rawMessage: string): string[] {
  const out: string[] = [];
  const cqImageRegex = /\[CQ:image,([^\]]+)\]/gi;
  let match: RegExpExecArray | null;
  while ((match = cqImageRegex.exec(rawMessage)) !== null) {
    const payload = match[1] ?? "";
    const pairs = payload.split(",");
    const params: Record<string, string> = {};
    for (const pair of pairs) {
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const key = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!key || !value) continue;
      params[key] = value;
    }
    const source = params.url || params.file || params.path || params.src;
    if (source) out.push(source);
  }
  return dedupeStrings(out);
}

function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  const raw = uri.slice("file://".length);
  if (raw.startsWith("/") || raw.startsWith("\\")) return raw.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(raw)) return raw;
  return `/${raw.replace(/\\/g, "/")}`;
}

function isLikelyAbsolutePath(pathValue: string): boolean {
  return pathValue.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pathValue);
}

function inferImageMimeType(pathValue: string): string {
  const ext = extname(pathValue).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "image/jpeg";
}

export function parseOneBotInboundMessage(msg: OneBotInboundLike): ParsedOneBotInboundMessage {
  const arr = Array.isArray(msg.message) ? msg.message : [];
  const selfId = msg.self_id;
  const selfStr = selfId != null ? String(selfId) : "";
  const textParts: string[] = [];
  const imageSources: string[] = [];
  const fileInfos: InboundFileInfo[] = [];
  let replyMessageId: string | number | undefined;
  let forwardId: string | undefined;

  for (const segment of arr) {
    if (!segment || typeof segment !== "object") continue;
    if (segment.type === "reply") {
      replyMessageId = parseReplyMessageId(segment.data) ?? replyMessageId;
      continue;
    }
    if (segment.type === "forward") {
      const id = String(segment.data?.id ?? segment.data?.resid ?? "").trim();
      if (id) forwardId = id;
      continue;
    }
    if (segment.type === "at") {
      const qq = String(segment.data?.qq ?? segment.data?.id ?? "").trim();
      if (!qq || qq === selfStr) continue;
      const name = String(segment.data?.name ?? "").trim();
      textParts.push(name && name !== qq ? `@${name}（${qq}）` : `@${qq}`);
      continue;
    }
    if (segment.type === "text") {
      const value = segment.data?.text;
      if (typeof value === "string" && value) {
        textParts.push(value);
      }
      continue;
    }
    if (segment.type === "image") {
      const source = parseImageSourceFromSegment(segment.data);
      if (source) imageSources.push(source);
      continue;
    }
    if (segment.type === "file") {
      const data = segment.data;
      if (data) {
        const name = String(data.name ?? data.file_name ?? data.file ?? "").trim();
        const url = typeof data.url === "string" ? data.url.trim() : undefined;
        const fileId = typeof data.file_id === "string" ? data.file_id.trim() :
                       typeof data.file === "string" ? data.file.trim() : undefined;
        const size = typeof data.size === "number" ? data.size :
                     typeof data.file_size === "number" ? data.file_size as number : undefined;
        if (name || url || fileId) {
          fileInfos.push({ name: name || "unknown", size, url: url || undefined, fileId: fileId || undefined });
        }
      }
      continue;
    }
  }

  const textFromSegments = textParts.join("");
  const rawTextFallback =
    !textFromSegments && arr.length === 0 && typeof msg.raw_message === "string" ? msg.raw_message : "";
  const parsedCqImageSources =
    imageSources.length === 0 && typeof msg.raw_message === "string"
      ? parseCqImageSources(msg.raw_message)
      : [];

  return {
    text: textFromSegments || rawTextFallback,
    imageSources: dedupeStrings([...imageSources, ...parsedCqImageSources]),
    replyMessageId,
    fileInfos,
    forwardId,
  };
}

export async function resolveInboundMediaForPrompt(
  imageSources: string[],
  cacheDir: string,
  cacheMaxAgeMs?: number,
  logger?: { warn?: (msg: string) => void },
): Promise<ResolvedInboundMedia> {
  const paths: string[] = [];
  const urls: string[] = [];
  const types: string[] = [];

  for (const source of dedupeStrings(imageSources)) {
    try {
      const resolved = await resolveImageForNapCat(source, cacheDir, cacheMaxAgeMs);
      const pathValue = fileUriToPath(resolved);
      if (!isLikelyAbsolutePath(pathValue)) {
        logger?.warn?.(`[onebot] skip non-absolute inbound media path: ${pathValue}`);
        continue;
      }
      if (!existsSync(pathValue)) {
        logger?.warn?.(`[onebot] inbound media path missing: ${pathValue}`);
        continue;
      }
      paths.push(pathValue);
      urls.push(resolved.startsWith("file://") ? resolved : `file://${pathValue}`);
      types.push(inferImageMimeType(pathValue));
    } catch (err: any) {
      logger?.warn?.(
        `[onebot] resolve inbound media failed: ${err?.message || err} (source=${source})`,
      );
    }
  }

  return { paths, urls, types };
}
