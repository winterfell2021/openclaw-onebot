import WebSocket from "ws";
import { basename } from "node:path";
import { resolveImageForNapCat, cleanupImageCache } from "../media/image";
import { resolveVideoForNapCat, cleanupVideoCache } from "../media/video";
import { convertVideoToGif } from "../media/video-gif";
import { shouldFallbackToFileUpload, resolveUploadFileName, toExistingLocalPath } from "../media/image-fallback";
import { parseQqMediaSegments } from "../media/qqmedia";
import { getRuntimeOptions } from "../config";
import { getWs, sendOneBotAction } from "../ws/connection";
import {
  stripNoReplyMarker,
  normalizeReplyToId,
  normalizeCaptionText,
  resolveOutboundMediaKind,
} from "../utils";
import type { OneBotRuntimeOptions } from "../options";
import type { OneBotTarget } from "../target-policy";
import type { OneBotSendOptions, OutboundReplyId } from "../types";

let mediaCacheCleanupTimer: ReturnType<typeof setInterval> | null = null;

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

export async function sendPrivateMsg(userId: number, text: string, _options: OneBotSendOptions = {}): Promise<void> {
  const w = getWs();
  if (!w || w.readyState !== WebSocket.OPEN) {
    throw new Error("OneBot WebSocket not connected");
  }
  const payload = buildTextPayload({ type: "user", id: userId }, text);
  if (!payload) return;
  await sendOneBotAction(w, "send_private_msg", { user_id: userId, message: payload });
}

export async function sendGroupMsg(groupId: number, text: string, options: OneBotSendOptions = {}): Promise<void> {
  const w = getWs();
  if (!w || w.readyState !== WebSocket.OPEN) {
    throw new Error("OneBot WebSocket not connected");
  }
  const payload = buildTextPayload({ type: "group", id: groupId }, text, options.replyToId);
  if (!payload) return;
  await sendOneBotAction(w, "send_group_msg", { group_id: groupId, message: payload });
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

export function extractFirstImageFileRef(segments: any[]): string | null {
  for (const segment of segments) {
    if (segment?.type !== "image") continue;
    const data = segment?.data ?? {};
    if (typeof data.file === "string" && data.file.trim()) return data.file.trim();
    if (typeof data.url === "string" && data.url.trim()) return data.url.trim();
  }
  return null;
}

export function extractFirstVideoFileRef(segments: any[]): string | null {
  for (const segment of segments) {
    if (segment?.type !== "video") continue;
    const data = segment?.data ?? {};
    if (typeof data.file === "string" && data.file.trim()) return data.file.trim();
    if (typeof data.url === "string" && data.url.trim()) return data.url.trim();
  }
  return null;
}

export async function sendImageWithFallback(
  target: OneBotTarget,
  image: string,
  imageCacheDir?: string,
  options: OneBotSendOptions = {},
): Promise<void> {
  const w = getWs();
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

export async function sendVideoWithFallback(
  target: OneBotTarget,
  video: string,
  videoCacheDir?: string,
  options: OneBotSendOptions = {},
): Promise<void> {
  const w = getWs();
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

export async function sendGroupImage(
  groupId: number,
  image: string,
  imageCacheDir?: string,
  options: OneBotSendOptions = {},
): Promise<void> {
  await sendImageWithFallback({ type: "group", id: groupId }, image, imageCacheDir, options);
}

export async function sendPrivateImage(
  userId: number,
  image: string,
  imageCacheDir?: string,
  options: OneBotSendOptions = {},
): Promise<void> {
  await sendImageWithFallback({ type: "user", id: userId }, image, imageCacheDir, options);
}

export async function sendGroupVideo(
  groupId: number,
  video: string,
  videoCacheDir?: string,
  options: OneBotSendOptions = {},
): Promise<void> {
  await sendVideoWithFallback({ type: "group", id: groupId }, video, videoCacheDir, options);
}

export async function sendPrivateVideo(
  userId: number,
  video: string,
  videoCacheDir?: string,
  options: OneBotSendOptions = {},
): Promise<void> {
  await sendVideoWithFallback({ type: "user", id: userId }, video, videoCacheDir, options);
}

export async function sendMediaByKind(
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

export async function setMsgEmojiLike(messageId: number, emojiId: number, set: boolean): Promise<void> {
  const w = getWs();
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

export async function uploadGroupFileAction(groupId: number, file: string, name: string): Promise<void> {
  const w = getWs();
  if (!w || w.readyState !== WebSocket.OPEN) throw new Error("OneBot WebSocket not connected");
  await sendOneBotAction(w, "upload_group_file", { group_id: groupId, file, name });
}

export async function uploadPrivateFileAction(userId: number, file: string, name: string): Promise<void> {
  const w = getWs();
  if (!w || w.readyState !== WebSocket.OPEN) throw new Error("OneBot WebSocket not connected");
  await sendOneBotAction(w, "upload_private_file", { user_id: userId, file, name });
}

export async function deliverTextWithQqMedia(
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

function cleanupMediaCacheByOptions(options: OneBotRuntimeOptions): void {
  cleanupImageCache(options.imageCacheDir, options.imageCacheMaxAgeMs);
  cleanupVideoCache(options.videoCacheDir, options.videoCacheMaxAgeMs);
}

export function startMediaCacheCleanupLoop(): void {
  stopMediaCacheCleanupLoop();
  cleanupMediaCacheByOptions(getRuntimeOptions());
  mediaCacheCleanupTimer = setInterval(() => {
    cleanupMediaCacheByOptions(getRuntimeOptions());
  }, 60 * 60 * 1000);
}

export function stopMediaCacheCleanupLoop(): void {
  if (!mediaCacheCleanupTimer) return;
  clearInterval(mediaCacheCleanupTimer);
  mediaCacheCleanupTimer = null;
}
