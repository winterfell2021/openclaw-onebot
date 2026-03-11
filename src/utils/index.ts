import { extname } from "node:path";
import { normalizeFileUriToPath } from "../media/image-fallback";
import type { OneBotMessage, OutboundReplyId } from "../types";

// ---- 常量 ----

export const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".m4v",
  ".flv",
]);

export const STREAM_TEXT_FLUSH_DELAY_MS = 350;

// ---- 文本规范化 ----

export function stripNoReplyMarker(text: string): string {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  if (trimmed === "NO_REPLY") return "";
  return trimmed.replace(/\s*NO_REPLY\s*$/g, "").trim();
}

export function normalizeCaptionText(value: unknown): string {
  return String(value ?? "").trim();
}

export function normalizeCompactText(value: unknown, maxLength = 600): string {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}…`;
}

export function normalizeSenderName(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- 回复文本合并（流式缓冲） ----

function normalizeReplyFragment(value: unknown): string {
  return String(value ?? "").replace(/\r\n/g, "\n");
}

function resolveOverlapLength(previous: string, incoming: string): number {
  const maxLength = Math.min(previous.length, incoming.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (previous.slice(-length) === incoming.slice(0, length)) {
      return length;
    }
  }
  return 0;
}

export function mergeBufferedReplyText(previous: string, incoming: string): string {
  const next = normalizeReplyFragment(incoming);
  if (!next) return previous;
  if (!previous) return next;
  if (next.includes(previous)) return next;
  if (previous.includes(next)) return previous;

  const overlapLength = resolveOverlapLength(previous, next);
  if (overlapLength > 0) {
    return `${previous}${next.slice(overlapLength)}`;
  }
  return `${previous}${next}`;
}

export function mergeTextFragments(previous: string, incoming: string): string {
  const next = normalizeCompactText(incoming, 1200);
  if (!next) return previous;
  if (!previous) return next;
  if (next.includes(previous)) return next;
  if (previous.includes(next)) return previous;
  return `${previous}\n\n${next}`;
}

// ---- ID / 时间戳 ----

export function normalizeReplyToId(value: unknown): OutboundReplyId | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) {
    const num = Number(text);
    if (Number.isSafeInteger(num)) return num;
  }
  return text;
}

export function resolveMessageTimestampMs(msg: OneBotMessage): number {
  const raw = Number(msg.time);
  if (Number.isFinite(raw) && raw > 0) {
    if (raw > 1_000_000_000_000) return Math.floor(raw);
    return Math.floor(raw * 1000);
  }
  return Date.now();
}

// ---- 媒体类型检测 ----

export function resolveOutboundMediaKind(value: string, autoDetectVideo: boolean): "image" | "video" {
  const source = String(value || "").trim();
  if (!autoDetectVideo || !source) return "image";
  if (/^data:video\//i.test(source)) return "video";

  if (source.startsWith("[")) {
    try {
      const parsed = JSON.parse(source);
      if (Array.isArray(parsed)) {
        const hasVideoSegment = parsed.some((item) => item?.type === "video");
        if (hasVideoSegment) return "video";
      }
    } catch {
      // ignore malformed segment json
    }
  }

  const normalized = normalizeFileUriToPath(source);
  const ext = extname(normalized.split("?")[0] || "").toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return "image";
}

// ---- 发送者 / 入站消息 ----

export function resolveSenderDisplayLabel(msg: OneBotMessage, userId: number): string {
  const sender = msg.sender && typeof msg.sender === "object" ? msg.sender : undefined;
  const card = normalizeSenderName(sender?.card);
  const nickname = normalizeSenderName(sender?.nickname);
  const preferred = card || nickname;
  if (!preferred || preferred === String(userId)) {
    return String(userId);
  }
  return `${preferred}（${userId}）`;
}

export function buildInboundSharedBody(
  messageText: string,
  mediaCount: number,
  quotedBody?: string,
): string {
  const parts: string[] = [];
  const normalizedMessage = normalizeCompactText(messageText, 700);
  const normalizedQuote = normalizeCompactText(quotedBody, 240);
  if (normalizedQuote) {
    parts.push(`引用：${normalizedQuote}`);
  }
  if (normalizedMessage) {
    parts.push(normalizedMessage);
  }
  if (mediaCount > 0) {
    parts.push(`附带图片 ${mediaCount} 张`);
  }
  if (parts.length === 0) {
    return "发送了空白消息";
  }
  return parts.join("\n");
}
