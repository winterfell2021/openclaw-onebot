/**
 * OpenClaw OneBot Channel Plugin
 *
 * 将 OneBot v11 协议（QQ/Lagrange.Core/go-cqhttp）接入 OpenClaw Gateway。
 * 支持正向 WebSocket 和反向 WebSocket 连接。
 */

import WebSocket from "ws";
import { createServer } from "http";
import { AsyncLocalStorage } from "async_hooks";
import { readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupImageCache, resolveImageForNapCat } from "./image";
import { cleanupVideoCache, resolveVideoForNapCat } from "./video";
import { convertVideoToGif } from "./video-gif";
import { resolveOneBotRuntimeOptions, type OneBotRuntimeOptions } from "./options";
import { normalizeFileUriToPath, resolveUploadFileName, shouldFallbackToFileUpload, toExistingLocalPath } from "./image-fallback";
import { parseQqMediaSegments } from "./qqmedia";
import { mergeBufferedReplyText } from "./reply-text";
import { appendGroupChatLog } from "./group-chat-log";
import { resolveToolTargetByPolicy, type OneBotTarget } from "./target-policy";
import { parseOneBotInboundMessage, resolveInboundMediaForPrompt } from "./inbound-media";
import { GroupMentionMediaCache } from "./group-media-cache";
import { GroupSharedContextStore } from "./group-shared-context";

// 尝试加载 plugin-sdk（兼容 openclaw 与 clawdbot）- 懒加载
let sdkLoaded = false;
let buildPendingHistoryContextFromMap: any;
let recordPendingHistoryEntry: any;
let clearHistoryEntriesIfEnabled: any;
const pluginVersion = resolvePluginVersion();

function resolvePluginVersion(): string {
  try {
    const currentFilePath = fileURLToPath(import.meta.url);
    const currentDir = dirname(currentFilePath);
    const packageJsonPath = resolve(currentDir, "../package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    const version = pkg?.version;
    if (typeof version === "string" && version.trim()) {
      return version.trim();
    }
  } catch {
    // ignore
  }
  return "unknown";
}

async function loadPluginSdk() {
  if (sdkLoaded) return;
  try {
    const sdk = await import("openclaw/plugin-sdk");
    buildPendingHistoryContextFromMap = sdk.buildPendingHistoryContextFromMap;
    recordPendingHistoryEntry = sdk.recordPendingHistoryEntry;
    clearHistoryEntriesIfEnabled = sdk.clearHistoryEntriesIfEnabled;
  } catch {
    try {
      const sdk = await import("clawdbot/plugin-sdk");
      buildPendingHistoryContextFromMap = sdk.buildPendingHistoryContextFromMap;
      recordPendingHistoryEntry = sdk.recordPendingHistoryEntry;
      clearHistoryEntriesIfEnabled = sdk.clearHistoryEntriesIfEnabled;
    } catch {
      console.warn("[onebot] plugin-sdk not found, history features disabled");
    }
  }
  sdkLoaded = true;
}

// ============ OneBot 消息类型 ============

interface OneBotMessage {
  post_type: string;
  message_type?: "private" | "group";
  message_id?: number;
  user_id?: number;
  group_id?: number;
  sender?: {
    card?: string;
    nickname?: string;
    user_id?: number;
    [key: string]: unknown;
  };
  message?: Array<{ type: string; data?: Record<string, unknown> }>;
  raw_message?: string;
  self_id?: number;
  time?: number;
  [key: string]: unknown;
}

// ============ 配置 ============

interface OneBotAccountConfig {
  accountId?: string;
  type: "forward-websocket" | "backward-websocket";
  host: string;
  port: number;
  accessToken?: string;
  path?: string;
  enabled?: boolean;
}

function getOneBotConfig(api: any, accountId?: string): OneBotAccountConfig | null {
  const cfg = api?.config ?? (globalThis as any).__onebotGatewayConfig;
  const id = accountId ?? "default";

  const channel = cfg?.channels?.onebot;
  const account = channel?.accounts?.[id];
  if (account) {
    const { type, host, port, accessToken, path } = account;
    if (host && port) {
      return {
        accountId: id,
        type: type ?? "forward-websocket",
        host,
        port,
        accessToken,
        path: path ?? "/onebot/v11/ws",
        enabled: account.enabled !== false,
      };
    }
  }

  if (channel?.host && channel?.port) {
    return {
      accountId: id,
      type: channel.type ?? "forward-websocket",
      host: channel.host,
      port: channel.port,
      accessToken: channel.accessToken,
      path: channel.path ?? "/onebot/v11/ws",
    };
  }

  // 回退到 LAGRANGE_WS_* 环境变量（兼容 Lagrange 项目 .env）
  const type = process.env.LAGRANGE_WS_TYPE as "forward-websocket" | "backward-websocket" | undefined;
  const host = process.env.LAGRANGE_WS_HOST;
  const portStr = process.env.LAGRANGE_WS_PORT;
  const accessToken = process.env.LAGRANGE_WS_ACCESS_TOKEN;
  const path = process.env.LAGRANGE_WS_PATH ?? "/onebot/v11/ws";

  if (host && portStr) {
    const port = parseInt(portStr, 10);
    if (Number.isFinite(port)) {
      return {
        accountId: id,
        type: type === "backward-websocket" ? "backward-websocket" : "forward-websocket",
        host,
        port,
        accessToken: accessToken || undefined,
        path,
      };
    }
  }

  return null;
}

function listAccountIds(api: any): string[] {
  const cfg = api?.config ?? (globalThis as any).__onebotGatewayConfig;
  const accounts = cfg?.channels?.onebot?.accounts;
  if (accounts && Object.keys(accounts).length > 0) {
    return Object.keys(accounts);
  }
  if (cfg?.channels?.onebot?.host) return ["default"];
  return [];
}

function parseOneBotTarget(input: string): OneBotTarget | null {
  const normalized = input.replace(/^onebot:/i, "").trim();
  if (!normalized) return null;

  if (normalized.startsWith("group:")) {
    const id = parseInt(normalized.slice(6), 10);
    return Number.isFinite(id) ? { type: "group", id } : null;
  }

  if (normalized.startsWith("user:")) {
    const id = parseInt(normalized.slice(5), 10);
    return Number.isFinite(id) ? { type: "user", id } : null;
  }

  const id = parseInt(normalized, 10);
  if (!Number.isFinite(id)) return null;
  return id > 100000000 ? { type: "user", id } : { type: "group", id };
}

function stripNoReplyMarker(text: string): string {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  if (trimmed === "NO_REPLY") return "";
  return trimmed.replace(/\s*NO_REPLY\s*$/g, "").trim();
}

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".m4v",
  ".flv",
]);

type OutboundMediaKind = "image" | "video";
type OutboundReplyId = string | number;

interface OneBotSendOptions {
  replyToId?: OutboundReplyId | null;
  caption?: string;
}

function normalizeReplyToId(value: unknown): OutboundReplyId | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) {
    const num = Number(text);
    if (Number.isSafeInteger(num)) return num;
  }
  return text;
}

function normalizeCaptionText(value: unknown): string {
  return String(value ?? "").trim();
}

function buildGroupReplySegment(replyToId?: OutboundReplyId | null): any[] {
  const normalized = normalizeReplyToId(replyToId);
  if (normalized === undefined) return [];
  return [{ type: "reply", data: { id: normalized } }];
}

function buildMessageWithOptionalPrefix(
  target: OneBotTarget,
  baseSegments: any[],
  options: OneBotSendOptions = {},
): any[] {
  const segments: any[] = [];
  if (target.type === "group") {
    segments.push(...buildGroupReplySegment(options.replyToId));
  }
  const caption = normalizeCaptionText(options.caption);
  if (caption) {
    segments.push({ type: "text", data: { text: caption } });
  }
  segments.push(...baseSegments);
  return segments;
}

function buildTextPayload(target: OneBotTarget, text: string, replyToId?: OutboundReplyId | null): string | any[] | null {
  const cleaned = normalizeCaptionText(text);
  if (!cleaned) return null;
  if (target.type !== "group") return cleaned;
  const replySegments = buildGroupReplySegment(replyToId);
  if (replySegments.length === 0) return cleaned;
  return [
    ...replySegments,
    { type: "text", data: { text: cleaned } },
  ];
}

async function sendUploadFallbackCaption(target: OneBotTarget, options: OneBotSendOptions = {}): Promise<void> {
  const caption = normalizeCaptionText(options.caption);
  if (!caption) return;
  if (target.type === "group") {
    await sendGroupMsg(target.id, caption, { replyToId: options.replyToId });
    return;
  }
  await sendPrivateMsg(target.id, caption);
}

function resolveMessageTimestampMs(msg: OneBotMessage): number {
  const raw = Number(msg.time);
  if (Number.isFinite(raw) && raw > 0) {
    if (raw > 1_000_000_000_000) return Math.floor(raw);
    return Math.floor(raw * 1000);
  }
  return Date.now();
}

function resolveOutboundMediaKind(value: string, autoDetectVideo: boolean): OutboundMediaKind {
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

let mediaCacheCleanupTimer: ReturnType<typeof setInterval> | null = null;

function cleanupMediaCacheByOptions(options: OneBotRuntimeOptions): void {
  cleanupImageCache(options.imageCacheDir, options.imageCacheMaxAgeMs);
  cleanupVideoCache(options.videoCacheDir, options.videoCacheMaxAgeMs);
}

function startMediaCacheCleanupLoop(): void {
  stopMediaCacheCleanupLoop();
  cleanupMediaCacheByOptions(getRuntimeOptions());
  mediaCacheCleanupTimer = setInterval(() => {
    cleanupMediaCacheByOptions(getRuntimeOptions());
  }, 60 * 60 * 1000);
}

function stopMediaCacheCleanupLoop(): void {
  if (!mediaCacheCleanupTimer) return;
  clearInterval(mediaCacheCleanupTimer);
  mediaCacheCleanupTimer = null;
}

interface OneBotToolExecutionContext {
  target: OneBotTarget | null;
  sessionKey: string;
  chatType: "group" | "direct";
}

const oneBotToolContextStorage = new AsyncLocalStorage<OneBotToolExecutionContext>();

function getCurrentToolExecutionContext(): OneBotToolExecutionContext | undefined {
  return oneBotToolContextStorage.getStore();
}

function resolveEffectiveToolTarget(
  rawTarget: string,
  runtimeOptions: OneBotRuntimeOptions,
  logger?: { warn?: (msg: string) => void },
): OneBotTarget | null {
  const requested = parseOneBotTarget(rawTarget);
  const contextTarget = getCurrentToolExecutionContext()?.target ?? null;
  const effective = resolveToolTargetByPolicy(
    requested,
    contextTarget,
    runtimeOptions.groupToolTargetPolicy,
  );
  if (
    runtimeOptions.groupToolTargetPolicy === "force-current-group" &&
    contextTarget?.type === "group" &&
    requested &&
    (requested.type !== contextTarget.type || requested.id !== contextTarget.id)
  ) {
    logger?.warn?.(
      `[onebot] force current group target: requested=${requested.type}:${requested.id}, effective=group:${contextTarget.id}`,
    );
  }
  return effective;
}

async function deliverTextWithQqMedia(
  text: string,
  target: OneBotTarget,
  options: OneBotRuntimeOptions,
  logger?: { error?: (msg: string) => void },
  replyToId?: OutboundReplyId | null,
): Promise<void> {
  const cleaned = stripNoReplyMarker(text);
  if (!cleaned) return;
  const normalizedReplyToId = normalizeReplyToId(replyToId);

  if (!options.qqimgTagEnabled && !options.qqvideoTagEnabled) {
    if (target.type === "group") await sendGroupMsg(target.id, cleaned, { replyToId: normalizedReplyToId });
    else await sendPrivateMsg(target.id, cleaned);
    return;
  }

  const queue = parseQqMediaSegments(cleaned, {
    imageCloseVariants: options.qqimgTagEnabled ? options.qqimgTagCloseVariants : [],
    videoCloseVariants: options.qqvideoTagEnabled ? options.qqvideoTagCloseVariants : [],
  });
  for (const item of queue) {
    try {
      if (item.type === "text") {
        if (target.type === "group") await sendGroupMsg(target.id, item.content, { replyToId: normalizedReplyToId });
        else await sendPrivateMsg(target.id, item.content);
      } else if (item.type === "image") {
        if (target.type === "group") {
          await sendGroupImage(target.id, item.content, options.imageCacheDir, { replyToId: normalizedReplyToId });
        }
        else await sendPrivateImage(target.id, item.content, options.imageCacheDir);
      } else {
        if (target.type === "group") {
          await sendGroupVideo(target.id, item.content, options.videoCacheDir, { replyToId: normalizedReplyToId });
        }
        else await sendPrivateVideo(target.id, item.content, options.videoCacheDir);
      }
    } catch (err: any) {
      logger?.error?.(`[onebot] send ${item.type} failed: ${err?.message || err}`);
    }
  }
}

/** 检查群聊消息是否 @ 了机器人（self_id） */
function isMentioned(msg: OneBotMessage, selfId: number): boolean {
  const arr = msg.message;
  if (!Array.isArray(arr)) return false;
  const selfStr = String(selfId);
  return arr.some((m) => m?.type === "at" && String((m?.data as any)?.qq || (m?.data as any)?.id) === selfStr);
}

// ============ WebSocket 与 OneBot API ============

let ws: WebSocket | null = null;
let wsServer: import("ws").WebSocketServer | null = null;
let httpServer: import("http").Server | null = null;
const pendingEcho = new Map<string, { resolve: (v: any) => void; reject: (err: Error) => void }>();
let echoCounter = 0;

function nextEcho(): string {
  return `onebot-${Date.now()}-${++echoCounter}`;
}

function oneBotActionError(action: string, resp: any): Error {
  const code = typeof resp?.retcode === "number" ? resp.retcode : "unknown";
  const detail = resp?.msg || resp?.message || resp?.wording || "";
  return new Error(`OneBot action ${action} failed: retcode=${code}${detail ? ` ${detail}` : ""}`);
}

function isOneBotActionOk(resp: any): boolean {
  if (typeof resp?.retcode === "number" && resp.retcode !== 0) return false;
  if (typeof resp?.status === "string" && resp.status.toLowerCase() !== "ok") return false;
  return true;
}

function sendOneBotAction(wsocket: WebSocket, action: string, params: Record<string, unknown>): Promise<any> {
  const echo = nextEcho();
  const payload = { action, params, echo };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingEcho.delete(echo);
      reject(new Error(`OneBot action ${action} timeout`));
    }, 15000);

    pendingEcho.set(echo, {
      resolve: (v) => {
        clearTimeout(timeout);
        pendingEcho.delete(echo);
        if (!isOneBotActionOk(v)) {
          reject(oneBotActionError(action, v));
          return;
        }
        resolve(v);
      },
      reject,
    });

    wsocket.send(JSON.stringify(payload), (err?: Error) => {
      if (err) {
        pendingEcho.delete(echo);
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

async function sendPrivateMsg(userId: number, text: string, _options: OneBotSendOptions = {}): Promise<void> {
  const w = ws;
  if (!w || w.readyState !== WebSocket.OPEN) {
    throw new Error("OneBot WebSocket not connected");
  }
  const payload = buildTextPayload({ type: "user", id: userId }, text);
  if (!payload) return;
  await sendOneBotAction(w, "send_private_msg", { user_id: userId, message: payload });
}

async function sendGroupMsg(groupId: number, text: string, options: OneBotSendOptions = {}): Promise<void> {
  const w = ws;
  if (!w || w.readyState !== WebSocket.OPEN) {
    throw new Error("OneBot WebSocket not connected");
  }
  const payload = buildTextPayload({ type: "group", id: groupId }, text, options.replyToId);
  if (!payload) return;
  await sendOneBotAction(w, "send_group_msg", { group_id: groupId, message: payload });
}

function getRuntimeOptions(): OneBotRuntimeOptions {
  return resolveOneBotRuntimeOptions((globalThis as any).__onebotApi?.config);
}

function getGroupMentionMediaCache(runtimeOptions: OneBotRuntimeOptions): GroupMentionMediaCache {
  if (!groupMentionMediaCache || groupMentionMediaCacheTtlMs !== runtimeOptions.groupMentionMediaTtlMs) {
    groupMentionMediaCache = new GroupMentionMediaCache(runtimeOptions.groupMentionMediaTtlMs);
    groupMentionMediaCacheTtlMs = runtimeOptions.groupMentionMediaTtlMs;
  }
  return groupMentionMediaCache;
}

function extractFirstImageFileRef(segments: any[]): string | null {
  for (const segment of segments) {
    if (segment?.type !== "image") continue;
    const data = segment?.data ?? {};
    if (typeof data.file === "string" && data.file.trim()) return data.file.trim();
    if (typeof data.url === "string" && data.url.trim()) return data.url.trim();
  }
  return null;
}

function extractFirstVideoFileRef(segments: any[]): string | null {
  for (const segment of segments) {
    if (segment?.type !== "video") continue;
    const data = segment?.data ?? {};
    if (typeof data.file === "string" && data.file.trim()) return data.file.trim();
    if (typeof data.url === "string" && data.url.trim()) return data.url.trim();
  }
  return null;
}

async function sendImageWithFallback(
  target: OneBotTarget,
  image: string,
  imageCacheDir?: string,
  options: OneBotSendOptions = {},
): Promise<void> {
  const w = ws;
  if (!w || w.readyState !== WebSocket.OPEN) throw new Error("OneBot WebSocket not connected");
  const runtimeOptions = getRuntimeOptions();
  const cacheDir = imageCacheDir || runtimeOptions.imageCacheDir;

  let seg: any[];
  let primaryFileRef: string | null = null;
  if (image.startsWith("[")) {
    const parsed = JSON.parse(image);
    if (!Array.isArray(parsed)) throw new Error("图片消息段格式错误");
    seg = parsed;
    primaryFileRef = extractFirstImageFileRef(parsed);
  } else {
    primaryFileRef = await resolveImageForNapCat(image, cacheDir, runtimeOptions.imageCacheMaxAgeMs);
    seg = [{ type: "image", data: { file: primaryFileRef } }];
  }

  const composedMessage = buildMessageWithOptionalPrefix(target, seg, options);
  const action = target.type === "group" ? "send_group_msg" : "send_private_msg";
  const params =
    target.type === "group"
      ? { group_id: target.id, message: composedMessage }
      : { user_id: target.id, message: composedMessage };

  try {
    await sendOneBotAction(w, action, params);
    return;
  } catch (err: any) {
    if (!shouldFallbackToFileUpload(err, runtimeOptions.imageFailureFallback)) {
      throw err;
    }

    const fallbackSource = primaryFileRef || image;
    let localPath = toExistingLocalPath(fallbackSource);
    if (!localPath) {
      try {
        const resolved = await resolveImageForNapCat(
          fallbackSource,
          cacheDir,
          runtimeOptions.imageCacheMaxAgeMs,
        );
        localPath = toExistingLocalPath(resolved);
      } catch {
        localPath = null;
      }
    }
    if (!localPath) throw err;

    try {
      await sendUploadFallbackCaption(target, options);
    } catch {
      // ignore caption fallback failure
    }

    const name = resolveUploadFileName(localPath);
    if (target.type === "group") {
      await uploadGroupFileAction(target.id, localPath, name);
      if (runtimeOptions.imageFailureFallbackNotice) {
        try {
          await sendGroupMsg(target.id, `图片发送失败，已转为群文件：${name}`);
        } catch {
          // ignore notice failure
        }
      }
    } else {
      await uploadPrivateFileAction(target.id, localPath, name);
      if (runtimeOptions.imageFailureFallbackNotice) {
        try {
          await sendPrivateMsg(target.id, `图片发送失败，已转为文件：${name}`);
        } catch {
          // ignore notice failure
        }
      }
    }
  }
}

function resolveVideoUploadFileName(localPath: string): string {
  const name = basename(localPath);
  if (name) return name;
  return "onebot-video.mp4";
}

async function resolveExistingVideoLocalPath(videoRef: string, runtimeOptions: OneBotRuntimeOptions): Promise<string | null> {
  let localPath = toExistingLocalPath(videoRef);
  if (localPath) return localPath;
  try {
    const resolved = await resolveVideoForNapCat(videoRef, runtimeOptions.videoCacheDir, {
      cacheMaxAgeMs: runtimeOptions.videoCacheMaxAgeMs,
      maxBytes: runtimeOptions.videoMaxBytes,
    });
    localPath = toExistingLocalPath(resolved);
    return localPath;
  } catch {
    return null;
  }
}

async function sendVideoWithFallback(
  target: OneBotTarget,
  video: string,
  videoCacheDir?: string,
  options: OneBotSendOptions = {},
): Promise<void> {
  const w = ws;
  if (!w || w.readyState !== WebSocket.OPEN) throw new Error("OneBot WebSocket not connected");

  const runtimeOptions = getRuntimeOptions();
  const cacheDir = videoCacheDir || runtimeOptions.videoCacheDir;

  let seg: any[];
  let primaryFileRef: string | null = null;
  if (video.startsWith("[")) {
    const parsed = JSON.parse(video);
    if (!Array.isArray(parsed)) throw new Error("视频消息段格式错误");
    seg = parsed;
    primaryFileRef = extractFirstVideoFileRef(parsed);
  } else {
    primaryFileRef = await resolveVideoForNapCat(video, cacheDir, {
      cacheMaxAgeMs: runtimeOptions.videoCacheMaxAgeMs,
      maxBytes: runtimeOptions.videoMaxBytes,
    });
    seg = [{ type: "video", data: { file: primaryFileRef } }];
  }

  const composedMessage = buildMessageWithOptionalPrefix(target, seg, options);
  const action = target.type === "group" ? "send_group_msg" : "send_private_msg";
  const params =
    target.type === "group"
      ? { group_id: target.id, message: composedMessage }
      : { user_id: target.id, message: composedMessage };

  try {
    await sendOneBotAction(w, action, params);
    return;
  } catch (err: any) {
    if (runtimeOptions.videoFailureFallback === "none") {
      throw err;
    }

    const fallbackSource = primaryFileRef || video;
    const localPath = await resolveExistingVideoLocalPath(fallbackSource, runtimeOptions);
    if (!localPath) throw err;

    if (runtimeOptions.videoFailureFallback === "gif") {
      try {
        const gifPath = await convertVideoToGif(localPath, runtimeOptions.videoCacheDir, {
          timeoutMs: runtimeOptions.videoGifTimeoutMs,
          fps: runtimeOptions.videoGifFps,
          width: runtimeOptions.videoGifWidth,
        });
        if (target.type === "group") {
          await sendGroupImage(target.id, gifPath, runtimeOptions.imageCacheDir, options);
        } else {
          await sendPrivateImage(target.id, gifPath, runtimeOptions.imageCacheDir, options);
        }
        if (runtimeOptions.videoFailureFallbackNotice) {
          try {
            if (target.type === "group") {
              await sendGroupMsg(target.id, "视频发送失败，已转 GIF 发送");
            } else {
              await sendPrivateMsg(target.id, "视频发送失败，已转 GIF 发送");
            }
          } catch {
            // ignore notice failure
          }
        }
        return;
      } catch {
        // gif fallback failed, continue with file upload fallback
      }
    }

    try {
      await sendUploadFallbackCaption(target, options);
    } catch {
      // ignore caption fallback failure
    }

    const name = resolveVideoUploadFileName(localPath);
    if (target.type === "group") {
      await uploadGroupFileAction(target.id, localPath, name);
      if (runtimeOptions.videoFailureFallbackNotice) {
        try {
          await sendGroupMsg(target.id, `视频发送失败，已转为群文件：${name}`);
        } catch {
          // ignore notice failure
        }
      }
    } else {
      await uploadPrivateFileAction(target.id, localPath, name);
      if (runtimeOptions.videoFailureFallbackNotice) {
        try {
          await sendPrivateMsg(target.id, `视频发送失败，已转为文件：${name}`);
        } catch {
          // ignore notice failure
        }
      }
    }
  }
}

/** 发送图片：message 可为 file 路径（file://、http://、base64://）或消息段数组 */
async function sendGroupImage(
  groupId: number,
  image: string,
  imageCacheDir?: string,
  options: OneBotSendOptions = {},
): Promise<void> {
  await sendImageWithFallback({ type: "group", id: groupId }, image, imageCacheDir, options);
}

async function sendPrivateImage(
  userId: number,
  image: string,
  imageCacheDir?: string,
  options: OneBotSendOptions = {},
): Promise<void> {
  await sendImageWithFallback({ type: "user", id: userId }, image, imageCacheDir, options);
}

/** 发送视频：message 可为 file 路径（file://、http://、base64://）或消息段数组 */
async function sendGroupVideo(
  groupId: number,
  video: string,
  videoCacheDir?: string,
  options: OneBotSendOptions = {},
): Promise<void> {
  await sendVideoWithFallback({ type: "group", id: groupId }, video, videoCacheDir, options);
}

async function sendPrivateVideo(
  userId: number,
  video: string,
  videoCacheDir?: string,
  options: OneBotSendOptions = {},
): Promise<void> {
  await sendVideoWithFallback({ type: "user", id: userId }, video, videoCacheDir, options);
}

async function sendMediaByKind(
  target: OneBotTarget,
  mediaUrl: string,
  runtimeOptions: OneBotRuntimeOptions,
  options: OneBotSendOptions = {},
): Promise<void> {
  const mediaKind = resolveOutboundMediaKind(
    mediaUrl,
    runtimeOptions.autoDetectVideoFromMediaUrls,
  );
  if (mediaKind === "video") {
    if (target.type === "group") {
      await sendGroupVideo(target.id, mediaUrl, runtimeOptions.videoCacheDir, options);
    } else {
      await sendPrivateVideo(target.id, mediaUrl, runtimeOptions.videoCacheDir, options);
    }
    return;
  }
  if (target.type === "group") {
    await sendGroupImage(target.id, mediaUrl, runtimeOptions.imageCacheDir, options);
  } else {
    await sendPrivateImage(target.id, mediaUrl, runtimeOptions.imageCacheDir, options);
  }
}

async function setMsgEmojiLike(messageId: number, emojiId: number, set: boolean): Promise<void> {
  const w = ws;
  if (!w || w.readyState !== WebSocket.OPEN) throw new Error("OneBot WebSocket not connected");

  const first = await sendOneBotAction(w, "set_msg_emoji_like", {
    message_id: messageId,
    emoji_id: emojiId,
    set,
  });
  if (first?.retcode === 0 || first?.status === "ok") return;

  const second = await sendOneBotAction(w, "set_msg_emoji_like", {
    message_id: messageId,
    emoji_id: emojiId,
    is_set: set,
  });
  if (second?.retcode === 0 || second?.status === "ok") return;

  throw new Error(
    `set_msg_emoji_like failed: ${second?.retcode ?? first?.retcode ?? "unknown"} ${
      second?.msg || first?.msg || ""
    }`,
  );
}

/** 上传群文件 */
async function uploadGroupFileAction(groupId: number, file: string, name: string): Promise<void> {
  const w = ws;
  if (!w || w.readyState !== WebSocket.OPEN) throw new Error("OneBot WebSocket not connected");
  await sendOneBotAction(w, "upload_group_file", { group_id: groupId, file, name });
}

/** 上传私聊文件 */
async function uploadPrivateFileAction(userId: number, file: string, name: string): Promise<void> {
  const w = ws;
  if (!w || w.readyState !== WebSocket.OPEN) throw new Error("OneBot WebSocket not connected");
  await sendOneBotAction(w, "upload_private_file", { user_id: userId, file, name });
}

// ============ 会话历史 ============

const DEFAULT_HISTORY_LIMIT = 20;
const sessionHistories = new Map<string, Array<{ sender: string; body: string; timestamp: number; messageId: string }>>();
let groupMentionMediaCache: GroupMentionMediaCache | null = null;
let groupMentionMediaCacheTtlMs = 0;
const DEFAULT_GROUP_SHARED_HISTORY_LIMIT = DEFAULT_HISTORY_LIMIT * 2;
const GROUP_SHARED_CONTEXT_DIRNAME = ".onebot-group-shared-context";
const STREAM_TEXT_FLUSH_DELAY_MS = 350;
const groupSharedContextStores = new Map<string, GroupSharedContextStore>();

function resolveExecutionSessionKey(
  isGroup: boolean,
  groupId: number | undefined,
  userId: number,
  inboundMessageId: number | undefined,
  messageTimestampMs: number,
): string {
  if (!isGroup || typeof groupId !== "number") {
    return `onebot:${userId}`.toLowerCase();
  }
  if (typeof inboundMessageId === "number") {
    return `onebot:group:${groupId}:msg:${inboundMessageId}`.toLowerCase();
  }
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `onebot:group:${groupId}:user:${userId}:ts:${messageTimestampMs}:${randomSuffix}`.toLowerCase();
}

function resolveGroupSharedContextDir(runtimeOptions: OneBotRuntimeOptions): string {
  return join(dirname(runtimeOptions.groupChatLogDir), GROUP_SHARED_CONTEXT_DIRNAME);
}

function getGroupSharedContextStore(runtimeOptions: OneBotRuntimeOptions): GroupSharedContextStore {
  const rootDir = resolveGroupSharedContextDir(runtimeOptions);
  let store = groupSharedContextStores.get(rootDir);
  if (!store) {
    store = new GroupSharedContextStore(rootDir, DEFAULT_GROUP_SHARED_HISTORY_LIMIT);
    groupSharedContextStores.set(rootDir, store);
  }
  return store;
}

function normalizeCompactText(value: unknown, maxLength = 600): string {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}…`;
}

function mergeTextFragments(previous: string, incoming: string): string {
  const next = normalizeCompactText(incoming, 1200);
  if (!next) return previous;
  if (!previous) return next;
  if (next.includes(previous)) return next;
  if (previous.includes(next)) return previous;
  return `${previous}\n\n${next}`;
}

function normalizeSenderName(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveSenderDisplayLabel(msg: OneBotMessage, userId: number): string {
  const sender = msg.sender && typeof msg.sender === "object" ? msg.sender : undefined;
  const card = normalizeSenderName(sender?.card);
  const nickname = normalizeSenderName(sender?.nickname);
  const preferred = card || nickname;
  if (!preferred || preferred === String(userId)) {
    return String(userId);
  }
  return `${preferred}（${userId}）`;
}

function buildInboundSharedBody(
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

interface ReplySummaryAccumulator {
  text: string;
  imageCount: number;
  videoCount: number;
}

function createReplySummaryAccumulator(): ReplySummaryAccumulator {
  return {
    text: "",
    imageCount: 0,
    videoCount: 0,
  };
}

function appendReplySummary(
  accumulator: ReplySummaryAccumulator,
  replyText: string,
  mediaCandidates: string[],
  runtimeOptions: OneBotRuntimeOptions,
): void {
  accumulator.text = mergeTextFragments(accumulator.text, replyText);
  for (const mediaUrl of mediaCandidates) {
    const kind = resolveOutboundMediaKind(mediaUrl, runtimeOptions.autoDetectVideoFromMediaUrls);
    if (kind === "video") accumulator.videoCount += 1;
    else accumulator.imageCount += 1;
  }
}

function buildReplySummary(accumulator: ReplySummaryAccumulator): string {
  const parts: string[] = [];
  const normalizedText = normalizeCompactText(accumulator.text, 900);
  if (normalizedText) {
    parts.push(normalizedText);
  }
  if (accumulator.imageCount > 0) {
    parts.push(`发送图片 ${accumulator.imageCount} 张`);
  }
  if (accumulator.videoCount > 0) {
    parts.push(`发送视频 ${accumulator.videoCount} 个`);
  }
  return parts.join("\n");
}

function hasReplySummaryContent(accumulator: ReplySummaryAccumulator): boolean {
  return Boolean(normalizeCompactText(accumulator.text) || accumulator.imageCount > 0 || accumulator.videoCount > 0);
}

async function resolveQuotedMessageBody(
  replyMessageId: string | number | undefined,
  logger?: { warn?: (msg: string) => void },
): Promise<string | undefined> {
  const normalizedReplyId = normalizeReplyToId(replyMessageId);
  const w = ws;
  if (!normalizedReplyId || !w || w.readyState !== WebSocket.OPEN) {
    return undefined;
  }

  try {
    const response = await sendOneBotAction(w, "get_msg", {
      message_id: normalizedReplyId,
    });
    const messageData = response?.data && typeof response.data === "object" ? response.data : response;
    const quoted = parseOneBotInboundMessage(messageData as any);
    return buildInboundSharedBody(quoted.text, quoted.imageSources.length);
  } catch (err: any) {
    logger?.warn?.(`[onebot] resolve quoted message failed: ${err?.message || err}`);
    return undefined;
  }
}

// ============ Channel 定义 ============

const OneBotChannelPlugin = {
  id: "onebot",
  meta: {
    id: "onebot",
    label: "OneBot",
    selectionLabel: "OneBot (QQ/Lagrange)",
    docsPath: "/channels/onebot",
    blurb: "OneBot v11 protocol via WebSocket (go-cqhttp, Lagrange.Core)",
    aliases: ["qq", "lagrange", "cqhttp"],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
  },
  config: {
    listAccountIds: (cfg: any) => listAccountIds({ config: cfg }),
    resolveAccount: (cfg: any, accountId?: string) => {
      const id = accountId ?? "default";
      const acc = cfg?.channels?.onebot?.accounts?.[id];
      if (acc) return acc;
      const ch = cfg?.channels?.onebot;
      if (ch?.host) return { accountId: id, ...ch };
      return { accountId: id };
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    resolveTarget: ({ to }: { to?: string }) => {
      const t = to?.trim();
      if (!t) return { ok: false, error: new Error("OneBot requires --to <user_id|group_id>") };
      return { ok: true, to: t };
    },
    sendText: async ({
      to,
      text,
      replyToId,
    }: {
      to: string;
      text: string;
      replyToId?: string | null;
    }) => {
      const config = getOneBotConfig((globalThis as any).__onebotApi);
      if (!config) {
        return { ok: false, error: new Error("OneBot not configured") };
      }
      const w = ws;
      if (!w || w.readyState !== WebSocket.OPEN) {
        return { ok: false, error: new Error("OneBot WebSocket not connected") };
      }
      const target = parseOneBotTarget(to);
      if (!target) {
        return { ok: false, error: new Error(`invalid target: ${to}`) };
      }
      const runtimeOptions = resolveOneBotRuntimeOptions((globalThis as any).__onebotApi?.config);
      await deliverTextWithQqMedia(
        text,
        target,
        runtimeOptions,
        (globalThis as any).__onebotApi?.logger,
        replyToId,
      );
      return { ok: true, provider: "onebot" };
    },
    sendMedia: async ({
      to,
      text,
      mediaUrl,
      replyToId,
    }: {
      to: string;
      text?: string;
      mediaUrl?: string;
      replyToId?: string | null;
    }) => {
      const config = getOneBotConfig((globalThis as any).__onebotApi);
      if (!config) {
        return { ok: false, error: new Error("OneBot not configured") };
      }
      const w = ws;
      if (!w || w.readyState !== WebSocket.OPEN) {
        return { ok: false, error: new Error("OneBot WebSocket not connected") };
      }
      const target = parseOneBotTarget(to);
      if (!target) {
        return { ok: false, error: new Error(`invalid target: ${to}`) };
      }
      const resolvedMediaUrl = String(mediaUrl ?? "").trim();
      if (!resolvedMediaUrl) {
        return { ok: false, error: new Error("mediaUrl is required") };
      }
      const runtimeOptions = resolveOneBotRuntimeOptions((globalThis as any).__onebotApi?.config);
      await sendMediaByKind(target, resolvedMediaUrl, runtimeOptions, {
        caption: text,
        replyToId,
      });
      return { ok: true, provider: "onebot" };
    },
  },
};

// ============ 处理入站 OneBot 消息 ============

async function processInboundMessage(api: any, msg: OneBotMessage): Promise<void> {
  await loadPluginSdk();

  const runtime = api.runtime;
  if (!runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    api.logger?.warn?.("[onebot] runtime.channel.reply not available");
    return;
  }

  const config = getOneBotConfig(api);
  if (!config) {
    api.logger?.warn?.("[onebot] not configured");
    return;
  }

  const cfg = api.config;
  const runtimeOptions = resolveOneBotRuntimeOptions(cfg);
  const mentionMediaCache = getGroupMentionMediaCache(runtimeOptions);
  const parsedInbound = parseOneBotInboundMessage(msg);
  const messageText = parsedInbound.text;
  const inboundMedia = await resolveInboundMediaForPrompt(
    parsedInbound.imageSources,
    runtimeOptions.imageCacheDir,
    runtimeOptions.imageCacheMaxAgeMs,
    api.logger,
  );
  let effectiveInboundMedia = inboundMedia;
  let hasEffectiveInboundMedia = inboundMedia.paths.length > 0;
  if (parsedInbound.imageSources.length > 0) {
    api.logger?.info?.(
      `[onebot] inbound image parsed: sources=${parsedInbound.imageSources.length} resolved=${inboundMedia.paths.length}`,
    );
  }

  const isGroup = msg.message_type === "group";
  const selfId = msg.self_id ?? 0;
  const requireMention = (cfg?.channels?.onebot as any)?.requireMention ?? true;
  const mentioned = isMentioned(msg, selfId);
  const userId = msg.user_id!;
  const groupId = msg.group_id;
  const ignoredByMention = isGroup && requireMention && !mentioned;
  const messageTimestampMs = resolveMessageTimestampMs(msg);

  if (isGroup && typeof groupId === "number" && typeof userId === "number" && runtimeOptions.groupChatLogEnabled) {
    const shouldLog = Boolean(messageText?.trim()) || parsedInbound.imageSources.length > 0 || Boolean(msg.raw_message?.trim());
    if (shouldLog) {
      appendGroupChatLog(
        {
          groupId,
          userId,
          selfId,
          messageId: typeof msg.message_id === "number" ? msg.message_id : undefined,
          mentioned,
          ignoredByMention,
          messageTimestampMs,
          receivedTimestampMs: Date.now(),
          text: messageText || "",
          rawMessage: typeof msg.raw_message === "string" ? msg.raw_message : undefined,
          imageSources: parsedInbound.imageSources,
          resolvedMediaCount: inboundMedia.paths.length,
        },
        {
          enabled: runtimeOptions.groupChatLogEnabled,
          logDir: runtimeOptions.groupChatLogDir,
          timeZone: runtimeOptions.groupChatLogTimeZone,
          maxTextLength: runtimeOptions.groupChatLogMaxTextLength,
          includeRawMessage: runtimeOptions.groupChatLogIncludeRawMessage,
        },
      ).catch((err: any) => {
        api.logger?.warn?.(`[onebot] append group chat log failed: ${err?.message || err}`);
      });
    }
  }

  if (ignoredByMention) {
    if (typeof groupId === "number" && typeof userId === "number" && hasEffectiveInboundMedia) {
      const cached = mentionMediaCache.record(groupId, userId, effectiveInboundMedia);
      if (cached) {
        api.logger?.info?.(
          `[onebot] cached inbound media for group:${groupId} user:${userId} count=${effectiveInboundMedia.paths.length}`,
        );
      }
    }
    api.logger?.info?.(`[onebot] ignoring group message without @mention`);
    return;
  }

  if (isGroup && requireMention && typeof groupId === "number" && typeof userId === "number" && hasEffectiveInboundMedia) {
    mentionMediaCache.record(groupId, userId, effectiveInboundMedia);
  }

  if (isGroup && mentioned && !hasEffectiveInboundMedia && typeof groupId === "number" && typeof userId === "number") {
    const cachedMedia = mentionMediaCache.consume(groupId, userId);
    if (cachedMedia && cachedMedia.paths.length > 0) {
      effectiveInboundMedia = cachedMedia;
      hasEffectiveInboundMedia = true;
      api.logger?.info?.(
        `[onebot] attached cached media for group:${groupId} user:${userId} count=${cachedMedia.paths.length}`,
      );
    }
  }

  const inboundMessageId = typeof msg.message_id === "number" ? msg.message_id : undefined;
  const replyMessageId = normalizeReplyToId(parsedInbound.replyMessageId);
  const quotedBody = await resolveQuotedMessageBody(replyMessageId, api.logger);
  if (!messageText?.trim() && !hasEffectiveInboundMedia && !quotedBody?.trim()) {
    api.logger?.info?.(`[onebot] ignoring empty message`);
    return;
  }
  const sharedGroupKey =
    isGroup && typeof groupId === "number" ? `onebot:group:${groupId}`.toLowerCase() : undefined;
  const sessionId = resolveExecutionSessionKey(
    isGroup,
    groupId,
    userId,
    inboundMessageId,
    messageTimestampMs,
  );
  const routeSessionKey = sharedGroupKey ?? sessionId;

  const route = runtime.channel.routing?.resolveAgentRoute?.({
    cfg,
    sessionKey: routeSessionKey,
    channel: "onebot",
    accountId: config.accountId ?? "default",
  }) ?? { agentId: "main" };

  const storePath =
    runtime.channel.session?.resolveStorePath?.(cfg?.session?.store, {
      agentId: route.agentId,
    }) ?? "";

  const envelopeOptions = runtime.channel.reply?.resolveEnvelopeFormatOptions?.(cfg) ?? {};
  const chatType = isGroup ? "group" : "direct";
  const fromLabel = String(userId);
  const senderDisplayLabel = resolveSenderDisplayLabel(msg, userId);
  const currentTarget: OneBotTarget =
    isGroup && groupId ? { type: "group", id: groupId } : { type: "user", id: userId };
  const conversationLabel =
    currentTarget.type === "group" ? `group:${currentTarget.id}` : `user:${currentTarget.id}`;
  const routeTo = `${currentTarget.type}:${currentTarget.id}`;
  let promptBody = messageText || quotedBody || "";
  let groupSharedContextInfo:
    | {
        store: GroupSharedContextStore;
        groupId: number;
        executionKey: string;
        currentText: string;
      }
    | null = null;

  if (isGroup && sharedGroupKey && typeof groupId === "number") {
    const sharedStore = getGroupSharedContextStore(runtimeOptions);
    const sharedTurn = sharedStore.beginTurn({
      groupId,
      executionKey: sessionId,
      senderLabel: senderDisplayLabel,
      userId,
      messageId: inboundMessageId != null ? String(inboundMessageId) : sessionId,
      timestamp: messageTimestampMs,
      text: messageText,
      imageCount: effectiveInboundMedia.paths.length,
      replyText: quotedBody,
    });
    promptBody = sharedTurn.promptContext;
    groupSharedContextInfo = {
      store: sharedStore,
      groupId,
      executionKey: sessionId,
      currentText: sharedTurn.currentText,
    };
  }

  const formattedBody =
    runtime.channel.reply?.formatInboundEnvelope?.({
      channel: "OneBot",
      from: fromLabel,
      timestamp: Date.now(),
      body: promptBody,
      chatType,
      sender: { name: senderDisplayLabel, id: String(userId) },
      envelope: envelopeOptions,
    }) ?? { content: [{ type: "text", text: promptBody }] };

  const formatHistoryEntry = (entry: any) =>
    runtime.channel.reply?.formatInboundEnvelope?.({
      channel: "OneBot",
      from: fromLabel,
      timestamp: entry.timestamp,
      body: entry.body,
      chatType,
      senderLabel: entry.sender,
      envelope: envelopeOptions,
    }) ?? { content: [{ type: "text", text: entry.body }] };

  const body =
    !isGroup && buildPendingHistoryContextFromMap
        ? buildPendingHistoryContextFromMap({
            historyMap: sessionHistories,
            historyKey: sessionId,
            limit: DEFAULT_HISTORY_LIMIT,
            currentMessage: formattedBody,
            formatEntry: formatHistoryEntry,
          })
        : formattedBody;

  if (!isGroup && recordPendingHistoryEntry) {
    recordPendingHistoryEntry({
      historyMap: sessionHistories,
      historyKey: sessionId,
      entry: {
        sender: fromLabel,
        body: messageText,
        timestamp: Date.now(),
        messageId: `onebot-${Date.now()}`,
      },
      limit: DEFAULT_HISTORY_LIMIT,
    });
  }

  const ctxPayload = {
    Body: body,
    BodyForAgent: promptBody,
    RawBody: messageText || groupSharedContextInfo?.currentText || quotedBody || "",
    MediaPath: hasEffectiveInboundMedia ? effectiveInboundMedia.paths[0] : undefined,
    MediaUrl: hasEffectiveInboundMedia ? effectiveInboundMedia.urls[0] : undefined,
    MediaType: hasEffectiveInboundMedia ? effectiveInboundMedia.types[0] : undefined,
    MediaPaths: hasEffectiveInboundMedia ? effectiveInboundMedia.paths : undefined,
    MediaUrls: hasEffectiveInboundMedia ? effectiveInboundMedia.urls : undefined,
    MediaTypes: hasEffectiveInboundMedia ? effectiveInboundMedia.types : undefined,
    From: isGroup ? `onebot:group:${groupId}` : `onebot:${userId}`,
    To:
      currentTarget.type === "group"
        ? `onebot:group:${currentTarget.id}`
        : `onebot:${currentTarget.id}`,
    SessionKey: sessionId,
    ParentSessionKey: sharedGroupKey,
    AccountId: config.accountId ?? "default",
    ChatType: chatType,
    ConversationLabel: conversationLabel,
    SenderName: fromLabel,
    SenderId: String(userId),
    Provider: "onebot",
    Surface: "onebot",
    MessageSid: inboundMessageId != null ? String(inboundMessageId) : `onebot-${Date.now()}`,
    ReplyToId: replyMessageId,
    ReplyToBody: quotedBody,
    ReplyToIsQuote: quotedBody ? true : undefined,
    Timestamp: Date.now(),
    OriginatingChannel: "onebot",
    OriginatingTo:
      currentTarget.type === "group"
        ? `onebot:group:${currentTarget.id}`
        : `onebot:${currentTarget.id}`,
    CommandAuthorized: true,
    _onebot: { userId, groupId, isGroup, sharedGroupKey },
  };

  if (runtime.channel.session?.recordInboundSession) {
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: sessionId,
      ctx: ctxPayload,
      updateLastRoute: {
        sessionKey: routeSessionKey,
        channel: "onebot",
        to: routeTo,
        accountId: config.accountId ?? "default",
      },
      onRecordError: (err: any) => api.logger?.warn?.(`[onebot] recordInboundSession: ${err}`),
    });
  }

  if (runtime.channel.activity?.record) {
    runtime.channel.activity.record({ channel: "onebot", accountId: config.accountId ?? "default", direction: "inbound" });
  }

  const groupReplyToId = isGroup && inboundMessageId != null ? inboundMessageId : undefined;
  let emojiAdded = false;
  const clearEmojiReaction = async () => {
    if (!emojiAdded || inboundMessageId == null) return;
    try {
      await setMsgEmojiLike(inboundMessageId, runtimeOptions.thinkingEmojiId, false);
    } catch {
      // ignore cleanup failures
    } finally {
      emojiAdded = false;
    }
  };

  if (runtimeOptions.thinkingEmojiEnabled && inboundMessageId != null) {
    try {
      await setMsgEmojiLike(inboundMessageId, runtimeOptions.thinkingEmojiId, true);
      emojiAdded = true;
    } catch (err: any) {
      api.logger?.warn?.(`[onebot] set thinking emoji failed: ${err?.message || err}`);
    }
  }

  const replySummaryAccumulator = createReplySummaryAccumulator();
  let fullReplyTextParts: string[] = [];
  let sharedContextFinalized = false;
  let bufferedReplyText = "";
  let bufferedReplyFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let bufferedReplyFlushPromise: Promise<void> | null = null;
  let resolveBufferedReplyFlush: (() => void) | null = null;

  const clearBufferedReplyFlushHandle = (): (() => void) | null => {
    if (bufferedReplyFlushTimer) {
      clearTimeout(bufferedReplyFlushTimer);
      bufferedReplyFlushTimer = null;
    }
    const resolver = resolveBufferedReplyFlush;
    bufferedReplyFlushPromise = null;
    resolveBufferedReplyFlush = null;
    return resolver;
  };

  const flushBufferedReplyText = async (): Promise<void> => {
    const text = bufferedReplyText;
    bufferedReplyText = "";
    const resolver = clearBufferedReplyFlushHandle();
    if (!text) {
      resolver?.();
      return;
    }
    try {
      await clearEmojiReaction();
      await deliverTextWithQqMedia(text, currentTarget, runtimeOptions, api.logger, groupReplyToId);
    } finally {
      resolver?.();
    }
  };

  const scheduleBufferedReplyText = (text: string): void => {
    bufferedReplyText = mergeBufferedReplyText(bufferedReplyText, text);
    if (!bufferedReplyFlushPromise) {
      bufferedReplyFlushPromise = new Promise<void>((resolve) => {
        resolveBufferedReplyFlush = resolve;
      });
    }
    if (bufferedReplyFlushTimer) {
      clearTimeout(bufferedReplyFlushTimer);
    }
    bufferedReplyFlushTimer = setTimeout(() => {
      void flushBufferedReplyText();
    }, STREAM_TEXT_FLUSH_DELAY_MS);
  };

  const waitBufferedReplyFlush = async (): Promise<void> => {
    if (bufferedReplyFlushPromise) {
      await bufferedReplyFlushPromise;
    }
  };

  const finalizeSharedContext = async (replyBody: string): Promise<void> => {
    if (!groupSharedContextInfo || sharedContextFinalized) return;
    sharedContextFinalized = true;
    groupSharedContextInfo.store.completeTurn({
      groupId: groupSharedContextInfo.groupId,
      executionKey: groupSharedContextInfo.executionKey,
      assistantText: replyBody,
      completedAt: Date.now(),
    });
  };

  const buildFullReplyForSharedContext = (): string => {
    const parts: string[] = [];
    const joined = fullReplyTextParts.join("\n\n").trim();
    if (joined) parts.push(joined);
    if (replySummaryAccumulator.imageCount > 0) {
      parts.push(`发送图片 ${replySummaryAccumulator.imageCount} 张`);
    }
    if (replySummaryAccumulator.videoCount > 0) {
      parts.push(`发送视频 ${replySummaryAccumulator.videoCount} 个`);
    }
    return parts.join("\n");
  };

  const failSharedContext = async (reason: string): Promise<void> => {
    if (!groupSharedContextInfo || sharedContextFinalized) return;
    sharedContextFinalized = true;
    groupSharedContextInfo.store.completeTurn({
      groupId: groupSharedContextInfo.groupId,
      executionKey: groupSharedContextInfo.executionKey,
      assistantText: reason,
      completedAt: Date.now(),
    });
  };

  api.logger?.info?.(`[onebot] dispatching message for session ${sessionId}`);

  try {
    await oneBotToolContextStorage.run(
      {
        target: currentTarget,
        sessionKey: sessionId,
        chatType,
      },
      async () => {
        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          dispatcherOptions: {
            deliver: async (
              payload: { text?: string; body?: string; mediaUrl?: string; mediaUrls?: string[] },
              info: { kind: string },
            ) => {
              const replyText = stripNoReplyMarker(
                typeof payload.text === "string" ? payload.text : typeof payload.body === "string" ? payload.body : "",
              );
              const mediaCandidates = [
                ...(Array.isArray(payload.mediaUrls)
                  ? payload.mediaUrls.filter((v) => typeof v === "string" && v.trim())
                  : []),
                ...(typeof payload.mediaUrl === "string" && payload.mediaUrl.trim() ? [payload.mediaUrl] : []),
              ];
              if (!replyText && mediaCandidates.length === 0) {
                if (info.kind === "final") {
                  await flushBufferedReplyText();
                  if (!isGroup && clearHistoryEntriesIfEnabled) {
                    clearHistoryEntriesIfEnabled({
                      historyMap: sessionHistories,
                      historyKey: sessionId,
                      limit: DEFAULT_HISTORY_LIMIT,
                    });
                  }
                  await finalizeSharedContext("");
                }
                return;
              }

              appendReplySummary(replySummaryAccumulator, replyText, mediaCandidates, runtimeOptions);
              if (replyText) fullReplyTextParts.push(replyText);

              try {
                if (mediaCandidates.length === 0) {
                  if (replyText) {
                    if (info.kind === "final") {
                      scheduleBufferedReplyText(replyText);
                      await waitBufferedReplyFlush();
                    } else {
                      scheduleBufferedReplyText(replyText);
                    }
                  }
                } else {
                  await flushBufferedReplyText();
                  let isFirstMedia = true;
                  for (const mediaUrl of mediaCandidates) {
                    await clearEmojiReaction();
                    await sendMediaByKind(currentTarget, mediaUrl, runtimeOptions, {
                      caption: isFirstMedia ? replyText : "",
                      replyToId: groupReplyToId,
                    });
                    isFirstMedia = false;
                  }
                }
                if (info.kind === "final") {
                  await flushBufferedReplyText();
                  if (!isGroup && clearHistoryEntriesIfEnabled) {
                    clearHistoryEntriesIfEnabled({
                      historyMap: sessionHistories,
                      historyKey: sessionId,
                      limit: DEFAULT_HISTORY_LIMIT,
                    });
                  }
                  await finalizeSharedContext(buildFullReplyForSharedContext());
                }
              } catch (e: any) {
                api.logger?.error?.(`[onebot] deliver failed: ${e?.message}`);
                const fullText = buildFullReplyForSharedContext();
                const failureSummary = fullText
                  ? `${fullText}\n处理失败：${normalizeCompactText(e?.message || e, 240)}`
                  : `处理失败：${normalizeCompactText(e?.message || e, 240)}`;
                await failSharedContext(failureSummary);
              }
            },
            onError: async (err: any, info: any) => {
              await flushBufferedReplyText();
              await clearEmojiReaction();
              api.logger?.error?.(`[onebot] ${info?.kind} reply failed: ${err}`);
              const fullText = buildFullReplyForSharedContext();
              const failureSummary = fullText
                ? `${fullText}\n处理失败：${normalizeCompactText(err?.message || err, 240)}`
                : `处理失败：${normalizeCompactText(err?.message || err, 240)}`;
              await failSharedContext(failureSummary);
            },
          },
          replyOptions: { disableBlockStreaming: !runtimeOptions.blockStreaming },
        });
      },
    );
  } catch (err: any) {
    await flushBufferedReplyText();
    await clearEmojiReaction();
    api.logger?.error?.(`[onebot] dispatch failed: ${err?.message}`);
    try {
      const { userId: uid, groupId: gid, isGroup: ig } = (ctxPayload as any)._onebot || {};
      if (ig && gid) {
        await sendGroupMsg(gid, `处理失败: ${err?.message?.slice(0, 80) || "未知错误"}`, {
          replyToId: groupReplyToId,
        });
      }
      else if (uid) await sendPrivateMsg(uid, `处理失败: ${err?.message?.slice(0, 80) || "未知错误"}`);
    } catch (_) {}
    const fullText = buildFullReplyForSharedContext();
    const failureSummary = fullText
      ? `${fullText}\n处理失败：${normalizeCompactText(err?.message || err, 240)}`
      : `处理失败：${normalizeCompactText(err?.message || err, 240)}`;
    await failSharedContext(failureSummary);
  } finally {
    await flushBufferedReplyText();
    if (groupSharedContextInfo && !sharedContextFinalized) {
      await finalizeSharedContext(
        fullReplyTextParts.length > 0 || hasReplySummaryContent(replySummaryAccumulator)
          ? buildFullReplyForSharedContext()
          : "",
      );
    }
    await clearEmojiReaction();
  }
}

// ============ 新成员入群欢迎 ============

async function handleGroupIncrease(api: any, msg: OneBotMessage): Promise<void> {
  const cfg = api.config;
  const gi = (cfg?.channels?.onebot as any)?.groupIncrease;
  if (!gi?.enabled || !gi?.message) return;

  const groupId = msg.group_id as number;
  const userId = msg.user_id as number;
  const w = ws;
  if (!w || w.readyState !== WebSocket.OPEN) return;

  const text = String(gi.message || "").replace(/\{userId\}/g, String(userId));
  if (!text.trim()) return;

  try {
    await sendGroupMsg(groupId, text);
    api.logger?.info?.(`[onebot] sent group welcome to ${groupId} for user ${userId}`);
  } catch (e: any) {
    api.logger?.error?.(`[onebot] group welcome failed: ${e?.message}`);
  }
}

// ============ WebSocket 连接 ============

async function connectForward(config: OneBotAccountConfig): Promise<WebSocket> {
  const addr = `ws://${config.host}:${config.port}`;
  const headers: Record<string, string> = {};
  if (config.accessToken) {
    headers["Authorization"] = `Bearer ${config.accessToken}`;
  }
  const w = new WebSocket(addr, { headers });
  await new Promise<void>((resolve, reject) => {
    w.on("open", () => resolve());
    w.on("error", reject);
  });
  return w;
}

async function createServerAndWait(config: OneBotAccountConfig): Promise<WebSocket> {
  const { WebSocketServer } = await import("ws");
  const server = createServer();
  httpServer = server;
  const wss = new WebSocketServer({
    server,
    path: config.path ?? "/onebot/v11/ws",
  });
  const host = config.host || "0.0.0.0";
  server.listen(config.port, host);

  wsServer = wss as any;

  return new Promise((resolve) => {
    wss.on("connection", (socket: WebSocket) => {
      resolve(socket as WebSocket);
    });
  });
}

// ============ 注册插件 ============

function getWs(): WebSocket | null {
  return ws;
}

export default function register(api: any): void {
  (globalThis as any).__onebotApi = api;
  (globalThis as any).__onebotGatewayConfig = api.config;

  api.registerChannel({ plugin: OneBotChannelPlugin });

  if (typeof api.registerCli === "function") {
    api.registerCli(
      (ctx: any) => {
        const prog = ctx.program;
        if (prog && typeof prog.command === "function") {
          const onebot = prog.command("onebot").description("OneBot 渠道配置");
          onebot.command("setup").description("交互式配置 OneBot 连接参数").action(async () => {
            const { runOneBotSetup } = await import("./setup");
            await runOneBotSetup();
          });
        }
      },
      { commands: ["onebot"] }
    );
  }

  if (typeof api.registerTool === "function") {
    api.registerTool({
      name: "onebot_send_text",
      description: "通过 OneBot 发送文本消息。target 格式：user:QQ号 或 group:群号",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "user:123456 或 group:789012" },
          text: { type: "string", description: "要发送的文本" },
        },
        required: ["target", "text"],
      },
      async execute(_id: string, params: { target: string; text: string }) {
        const w = getWs();
        if (!w || w.readyState !== WebSocket.OPEN) {
          return { content: [{ type: "text", text: "OneBot 未连接" }] };
        }
        const runtimeOptions = getRuntimeOptions();
        const target = resolveEffectiveToolTarget(params.target, runtimeOptions, (globalThis as any).__onebotApi?.logger);
        if (!target) {
          return { content: [{ type: "text", text: `目标格式错误: ${params.target}` }] };
        }
        try {
          await deliverTextWithQqMedia(params.text, target, runtimeOptions, (globalThis as any).__onebotApi?.logger);
          return { content: [{ type: "text", text: "发送成功" }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `发送失败: ${e?.message}` }] };
        }
      },
    });

    api.registerTool({
      name: "onebot_send_image",
      description: "通过 OneBot 发送图片。target 格式：user:QQ号 或 group:群号。image 为本地路径(file://)或 URL 或 base64://",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string" },
          image: { type: "string", description: "图片路径或 URL" },
        },
        required: ["target", "image"],
      },
      async execute(_id: string, params: { target: string; image: string }) {
        const w = getWs();
        if (!w || w.readyState !== WebSocket.OPEN) {
          return { content: [{ type: "text", text: "OneBot 未连接" }] };
        }
        const runtimeOptions = getRuntimeOptions();
        const target = resolveEffectiveToolTarget(params.target, runtimeOptions, (globalThis as any).__onebotApi?.logger);
        if (!target) {
          return { content: [{ type: "text", text: `目标格式错误: ${params.target}` }] };
        }
        try {
          if (target.type === "group") {
            await sendGroupImage(target.id, params.image, runtimeOptions.imageCacheDir);
          } else {
            await sendPrivateImage(target.id, params.image, runtimeOptions.imageCacheDir);
          }
          return { content: [{ type: "text", text: "图片发送成功" }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `发送失败: ${e?.message}` }] };
        }
      },
    });

    api.registerTool({
      name: "onebot_send_video",
      description:
        "通过 OneBot 发送视频。target 格式：user:QQ号 或 group:群号。video 为本地路径(file://)或 URL 或 base64://",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string" },
          video: { type: "string", description: "视频路径或 URL" },
        },
        required: ["target", "video"],
      },
      async execute(_id: string, params: { target: string; video: string }) {
        const w = getWs();
        if (!w || w.readyState !== WebSocket.OPEN) {
          return { content: [{ type: "text", text: "OneBot 未连接" }] };
        }
        const runtimeOptions = getRuntimeOptions();
        const target = resolveEffectiveToolTarget(params.target, runtimeOptions, (globalThis as any).__onebotApi?.logger);
        if (!target) {
          return { content: [{ type: "text", text: `目标格式错误: ${params.target}` }] };
        }
        try {
          if (target.type === "group") {
            await sendGroupVideo(target.id, params.video, runtimeOptions.videoCacheDir);
          } else {
            await sendPrivateVideo(target.id, params.video, runtimeOptions.videoCacheDir);
          }
          return { content: [{ type: "text", text: "视频发送成功" }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `发送失败: ${e?.message}` }] };
        }
      },
    });

    api.registerTool({
      name: "onebot_upload_file",
      description: "通过 OneBot 上传文件到群或私聊。target: user:QQ号 或 group:群号。file 为本地绝对路径，name 为显示文件名",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string" },
          file: { type: "string" },
          name: { type: "string" },
        },
        required: ["target", "file", "name"],
      },
      async execute(_id: string, params: { target: string; file: string; name: string }) {
        const w = getWs();
        if (!w || w.readyState !== WebSocket.OPEN) {
          return { content: [{ type: "text", text: "OneBot 未连接" }] };
        }
        const runtimeOptions = getRuntimeOptions();
        const target = resolveEffectiveToolTarget(params.target, runtimeOptions, (globalThis as any).__onebotApi?.logger);
        if (!target) {
          return { content: [{ type: "text", text: `目标格式错误: ${params.target}` }] };
        }
        try {
          if (target.type === "group") {
            await uploadGroupFileAction(target.id, params.file, params.name);
          } else {
            await uploadPrivateFileAction(target.id, params.file, params.name);
          }
          return { content: [{ type: "text", text: "文件上传成功" }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `上传失败: ${e?.message}` }] };
        }
      },
    });
  }

  api.registerService({
    id: "onebot-ws",
    start: async () => {
      const config = getOneBotConfig(api);
      if (!config) {
        api.logger?.warn?.("[onebot] no config, service will not connect");
        return;
      }
      startMediaCacheCleanupLoop();

      try {
        if (config.type === "forward-websocket") {
          ws = await connectForward(config);
        } else {
          ws = await createServerAndWait(config);
        }

        api.logger?.info?.("[onebot] WebSocket connected");

        ws!.on("message", (data: Buffer) => {
          try {
            const payload = JSON.parse(data.toString());
            if (payload.echo && pendingEcho.has(payload.echo)) {
              const h = pendingEcho.get(payload.echo);
              h?.resolve(payload);
              return;
            }
            if (payload.meta_event_type === "heartbeat") return;

            const msg = payload as OneBotMessage;
            if (msg.post_type === "message" && (msg.message_type === "private" || msg.message_type === "group")) {
              processInboundMessage(api, msg).catch((e) => {
                api.logger?.error?.(`[onebot] processInboundMessage: ${e?.message}`);
              });
            } else if (msg.post_type === "notice" && msg.notice_type === "group_increase") {
              handleGroupIncrease(api, msg).catch((e) => {
                api.logger?.error?.(`[onebot] handleGroupIncrease: ${e?.message}`);
              });
            }
          } catch (e: any) {
            api.logger?.error?.(`[onebot] parse message: ${e?.message}`);
          }
        });

        ws!.on("close", () => {
          api.logger?.info?.("[onebot] WebSocket closed");
        });

        ws!.on("error", (e: Error) => {
          api.logger?.error?.(`[onebot] WebSocket error: ${e?.message}`);
        });
      } catch (e: any) {
        api.logger?.error?.(`[onebot] start failed: ${e?.message}`);
      }
    },
    stop: async () => {
      if (ws) {
        ws.close();
        ws = null;
      }
      if (wsServer) {
        wsServer.close();
        wsServer = null;
      }
      if (httpServer) {
        httpServer.close();
        httpServer = null;
      }
      stopMediaCacheCleanupLoop();
      api.logger?.info?.("[onebot] service stopped");
    },
  });

  api.logger?.info?.(`[onebot] plugin loaded (version=${pluginVersion})`);
}
