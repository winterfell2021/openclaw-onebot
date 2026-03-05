const DEFAULT_THINKING_EMOJI_ID = 60;
const DEFAULT_IMAGE_CACHE_DIR = "/data/.openclaw/workspace/.onebot-image-cache";
const DEFAULT_VIDEO_CACHE_DIR = "/data/.openclaw/workspace/.onebot-video-cache";
const DEFAULT_IMAGE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VIDEO_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_QQIMG_CLOSE_VARIANTS = ["qqimg", "img"];
const DEFAULT_QQVIDEO_CLOSE_VARIANTS = ["qqvideo", "video"];
const DEFAULT_BLOCK_STREAMING = true;
const DEFAULT_GROUP_TOOL_TARGET_POLICY = "force-current-group";
const DEFAULT_IMAGE_FAILURE_FALLBACK = "upload-file";
const DEFAULT_IMAGE_FAILURE_FALLBACK_NOTICE = false;
const DEFAULT_VIDEO_FAILURE_FALLBACK = "upload-file";
const DEFAULT_VIDEO_FAILURE_FALLBACK_NOTICE = false;
const DEFAULT_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_AUTO_DETECT_VIDEO_FROM_MEDIA_URLS = true;
const DEFAULT_VIDEO_GIF_TIMEOUT_MS = 20 * 1000;
const DEFAULT_VIDEO_GIF_FPS = 10;
const DEFAULT_VIDEO_GIF_WIDTH = 480;
const DEFAULT_GROUP_CHAT_LOG_ENABLED = true;
const DEFAULT_GROUP_CHAT_LOG_DIR = "/data/.openclaw/workspace/.onebot-group-chat-logs";
const DEFAULT_GROUP_CHAT_LOG_TIME_ZONE = "Asia/Shanghai";
const DEFAULT_GROUP_CHAT_LOG_MAX_TEXT_LENGTH = 2000;
const DEFAULT_GROUP_CHAT_LOG_INCLUDE_RAW_MESSAGE = false;

export type GroupToolTargetPolicy = "force-current-group" | "respect-target";
export type ImageFailureFallback = "none" | "upload-file";
export type VideoFailureFallback = "none" | "upload-file" | "gif";

export interface OneBotRuntimeOptions {
  thinkingEmojiEnabled: boolean;
  thinkingEmojiId: number;
  qqimgTagEnabled: boolean;
  qqimgTagCloseVariants: string[];
  qqvideoTagEnabled: boolean;
  qqvideoTagCloseVariants: string[];
  blockStreaming: boolean;
  imageCacheDir: string;
  imageCacheMaxAgeMs: number;
  videoCacheDir: string;
  videoCacheMaxAgeMs: number;
  videoMaxBytes: number;
  autoDetectVideoFromMediaUrls: boolean;
  videoGifTimeoutMs: number;
  videoGifFps: number;
  videoGifWidth: number;
  groupChatLogEnabled: boolean;
  groupChatLogDir: string;
  groupChatLogTimeZone: string;
  groupChatLogMaxTextLength: number;
  groupChatLogIncludeRawMessage: boolean;
  groupToolTargetPolicy: GroupToolTargetPolicy;
  imageFailureFallback: ImageFailureFallback;
  imageFailureFallbackNotice: boolean;
  videoFailureFallback: VideoFailureFallback;
  videoFailureFallbackNotice: boolean;
}

export function resolveOneBotRuntimeOptions(cfg: any): OneBotRuntimeOptions {
  const onebotCfg = cfg?.channels?.onebot ?? {};

  const rawEmojiId = Number(onebotCfg.thinkingEmojiId);
  const thinkingEmojiId = Number.isFinite(rawEmojiId) ? rawEmojiId : DEFAULT_THINKING_EMOJI_ID;
  const rawCacheMaxAgeMs = Number(
    onebotCfg.imageCacheMaxAgeMs || process.env.ONEBOT_IMAGE_CACHE_MAX_AGE_MS,
  );
  const imageCacheMaxAgeMs =
    Number.isFinite(rawCacheMaxAgeMs) && rawCacheMaxAgeMs > 0
      ? Math.floor(rawCacheMaxAgeMs)
      : DEFAULT_IMAGE_CACHE_MAX_AGE_MS;
  const rawVideoCacheMaxAgeMs = Number(
    onebotCfg.videoCacheMaxAgeMs || process.env.ONEBOT_VIDEO_CACHE_MAX_AGE_MS,
  );
  const videoCacheMaxAgeMs =
    Number.isFinite(rawVideoCacheMaxAgeMs) && rawVideoCacheMaxAgeMs > 0
      ? Math.floor(rawVideoCacheMaxAgeMs)
      : DEFAULT_VIDEO_CACHE_MAX_AGE_MS;
  const rawVideoMaxBytes = Number(onebotCfg.videoMaxBytes || process.env.ONEBOT_VIDEO_MAX_BYTES);
  const videoMaxBytes =
    Number.isFinite(rawVideoMaxBytes) && rawVideoMaxBytes > 0
      ? Math.floor(rawVideoMaxBytes)
      : DEFAULT_VIDEO_MAX_BYTES;
  const rawVideoGifTimeoutMs = Number(
    onebotCfg.videoGifTimeoutMs || process.env.ONEBOT_VIDEO_GIF_TIMEOUT_MS,
  );
  const videoGifTimeoutMs =
    Number.isFinite(rawVideoGifTimeoutMs) && rawVideoGifTimeoutMs > 0
      ? Math.floor(rawVideoGifTimeoutMs)
      : DEFAULT_VIDEO_GIF_TIMEOUT_MS;
  const rawVideoGifFps = Number(onebotCfg.videoGifFps || process.env.ONEBOT_VIDEO_GIF_FPS);
  const videoGifFps =
    Number.isFinite(rawVideoGifFps) && rawVideoGifFps > 0
      ? Math.floor(rawVideoGifFps)
      : DEFAULT_VIDEO_GIF_FPS;
  const rawVideoGifWidth = Number(onebotCfg.videoGifWidth || process.env.ONEBOT_VIDEO_GIF_WIDTH);
  const videoGifWidth =
    Number.isFinite(rawVideoGifWidth) && rawVideoGifWidth > 0
      ? Math.floor(rawVideoGifWidth)
      : DEFAULT_VIDEO_GIF_WIDTH;
  const rawGroupChatLogMaxTextLength = Number(
    onebotCfg.groupChatLogMaxTextLength || process.env.ONEBOT_GROUP_CHAT_LOG_MAX_TEXT_LENGTH,
  );
  const groupChatLogMaxTextLength =
    Number.isFinite(rawGroupChatLogMaxTextLength) && rawGroupChatLogMaxTextLength > 0
      ? Math.floor(rawGroupChatLogMaxTextLength)
      : DEFAULT_GROUP_CHAT_LOG_MAX_TEXT_LENGTH;

  const closeVariants = Array.isArray(onebotCfg.qqimgTagCloseVariants)
    ? onebotCfg.qqimgTagCloseVariants
        .map((v: unknown) => String(v || "").trim().toLowerCase())
        .filter(Boolean)
    : DEFAULT_QQIMG_CLOSE_VARIANTS;
  const videoCloseVariants = Array.isArray(onebotCfg.qqvideoTagCloseVariants)
    ? onebotCfg.qqvideoTagCloseVariants
        .map((v: unknown) => String(v || "").trim().toLowerCase())
        .filter(Boolean)
    : DEFAULT_QQVIDEO_CLOSE_VARIANTS;

  return {
    thinkingEmojiEnabled: onebotCfg.thinkingEmojiEnabled === true,
    thinkingEmojiId,
    qqimgTagEnabled: onebotCfg.qqimgTagEnabled !== false,
    qqimgTagCloseVariants: closeVariants.length > 0 ? closeVariants : DEFAULT_QQIMG_CLOSE_VARIANTS,
    qqvideoTagEnabled: onebotCfg.qqvideoTagEnabled !== false,
    qqvideoTagCloseVariants:
      videoCloseVariants.length > 0 ? videoCloseVariants : DEFAULT_QQVIDEO_CLOSE_VARIANTS,
    blockStreaming: onebotCfg.blockStreaming === false ? false : DEFAULT_BLOCK_STREAMING,
    imageCacheDir: String(onebotCfg.imageCacheDir || process.env.ONEBOT_IMAGE_CACHE_DIR || DEFAULT_IMAGE_CACHE_DIR),
    imageCacheMaxAgeMs,
    videoCacheDir: String(onebotCfg.videoCacheDir || process.env.ONEBOT_VIDEO_CACHE_DIR || DEFAULT_VIDEO_CACHE_DIR),
    videoCacheMaxAgeMs,
    videoMaxBytes,
    autoDetectVideoFromMediaUrls:
      onebotCfg.autoDetectVideoFromMediaUrls === false
        ? false
        : DEFAULT_AUTO_DETECT_VIDEO_FROM_MEDIA_URLS,
    videoGifTimeoutMs,
    videoGifFps,
    videoGifWidth,
    groupChatLogEnabled:
      onebotCfg.groupChatLogEnabled === false ? false : DEFAULT_GROUP_CHAT_LOG_ENABLED,
    groupChatLogDir: String(
      onebotCfg.groupChatLogDir || process.env.ONEBOT_GROUP_CHAT_LOG_DIR || DEFAULT_GROUP_CHAT_LOG_DIR,
    ),
    groupChatLogTimeZone: String(
      onebotCfg.groupChatLogTimeZone ||
        process.env.ONEBOT_GROUP_CHAT_LOG_TIME_ZONE ||
        DEFAULT_GROUP_CHAT_LOG_TIME_ZONE,
    ),
    groupChatLogMaxTextLength,
    groupChatLogIncludeRawMessage:
      onebotCfg.groupChatLogIncludeRawMessage === true
        ? true
        : DEFAULT_GROUP_CHAT_LOG_INCLUDE_RAW_MESSAGE,
    groupToolTargetPolicy:
      onebotCfg.groupToolTargetPolicy === "respect-target"
        ? "respect-target"
        : DEFAULT_GROUP_TOOL_TARGET_POLICY,
    imageFailureFallback:
      onebotCfg.imageFailureFallback === "none" ? "none" : DEFAULT_IMAGE_FAILURE_FALLBACK,
    imageFailureFallbackNotice:
      onebotCfg.imageFailureFallbackNotice === true ? true : DEFAULT_IMAGE_FAILURE_FALLBACK_NOTICE,
    videoFailureFallback:
      onebotCfg.videoFailureFallback === "none"
        ? "none"
        : onebotCfg.videoFailureFallback === "gif"
          ? "gif"
          : DEFAULT_VIDEO_FAILURE_FALLBACK,
    videoFailureFallbackNotice:
      onebotCfg.videoFailureFallbackNotice === true ? true : DEFAULT_VIDEO_FAILURE_FALLBACK_NOTICE,
  };
}
