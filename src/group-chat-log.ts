import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface GroupChatLogOptions {
  enabled: boolean;
  logDir: string;
  timeZone: string;
  maxTextLength: number;
  includeRawMessage: boolean;
}

export interface GroupChatLogEntry {
  groupId: number;
  userId: number;
  selfId?: number;
  messageId?: number;
  mentioned: boolean;
  ignoredByMention: boolean;
  messageTimestampMs: number;
  receivedTimestampMs: number;
  text: string;
  rawMessage?: string;
  imageSources: string[];
  resolvedMediaCount: number;
}

function resolvePositiveInt(value: number, fallback: number): number {
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

function trimWithLimit(value: string, maxLength: number): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function resolveDateKey(timestampMs: number, timeZone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(new Date(timestampMs));
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    // ignore invalid timezone
  }
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export async function appendGroupChatLog(entry: GroupChatLogEntry, options: GroupChatLogOptions): Promise<string | null> {
  if (!options.enabled) return null;

  const maxLength = resolvePositiveInt(options.maxTextLength, 2000);
  const dateKey = resolveDateKey(entry.messageTimestampMs, options.timeZone);
  const dayDir = join(options.logDir, dateKey);
  const filePath = join(dayDir, `group-${entry.groupId}.jsonl`);

  const payload: Record<string, unknown> = {
    date: dateKey,
    messageAt: new Date(entry.messageTimestampMs).toISOString(),
    receivedAt: new Date(entry.receivedTimestampMs).toISOString(),
    groupId: entry.groupId,
    userId: entry.userId,
    selfId: entry.selfId,
    messageId: entry.messageId,
    mentioned: entry.mentioned,
    ignoredByMention: entry.ignoredByMention,
    text: trimWithLimit(entry.text, maxLength),
    imageSources: entry.imageSources.slice(0, 20),
    resolvedMediaCount: entry.resolvedMediaCount,
  };

  if (options.includeRawMessage && entry.rawMessage) {
    payload.rawMessage = trimWithLimit(entry.rawMessage, maxLength);
  }

  await mkdir(dayDir, { recursive: true });
  await appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
  return filePath;
}

