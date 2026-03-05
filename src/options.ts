const DEFAULT_THINKING_EMOJI_ID = 60;
const DEFAULT_IMAGE_CACHE_DIR = "/data/.openclaw/workspace/.onebot-image-cache";
const DEFAULT_IMAGE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_QQIMG_CLOSE_VARIANTS = ["qqimg", "img"];
const DEFAULT_GROUP_TOOL_TARGET_POLICY = "force-current-group";
const DEFAULT_IMAGE_FAILURE_FALLBACK = "upload-file";
const DEFAULT_IMAGE_FAILURE_FALLBACK_NOTICE = false;

export type GroupToolTargetPolicy = "force-current-group" | "respect-target";
export type ImageFailureFallback = "none" | "upload-file";

export interface OneBotRuntimeOptions {
  thinkingEmojiEnabled: boolean;
  thinkingEmojiId: number;
  qqimgTagEnabled: boolean;
  qqimgTagCloseVariants: string[];
  imageCacheDir: string;
  imageCacheMaxAgeMs: number;
  groupToolTargetPolicy: GroupToolTargetPolicy;
  imageFailureFallback: ImageFailureFallback;
  imageFailureFallbackNotice: boolean;
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

  const closeVariants = Array.isArray(onebotCfg.qqimgTagCloseVariants)
    ? onebotCfg.qqimgTagCloseVariants
        .map((v: unknown) => String(v || "").trim().toLowerCase())
        .filter(Boolean)
    : DEFAULT_QQIMG_CLOSE_VARIANTS;

  return {
    thinkingEmojiEnabled: onebotCfg.thinkingEmojiEnabled === true,
    thinkingEmojiId,
    qqimgTagEnabled: onebotCfg.qqimgTagEnabled !== false,
    qqimgTagCloseVariants: closeVariants.length > 0 ? closeVariants : DEFAULT_QQIMG_CLOSE_VARIANTS,
    imageCacheDir: String(onebotCfg.imageCacheDir || process.env.ONEBOT_IMAGE_CACHE_DIR || DEFAULT_IMAGE_CACHE_DIR),
    imageCacheMaxAgeMs,
    groupToolTargetPolicy:
      onebotCfg.groupToolTargetPolicy === "respect-target"
        ? "respect-target"
        : DEFAULT_GROUP_TOOL_TARGET_POLICY,
    imageFailureFallback:
      onebotCfg.imageFailureFallback === "none" ? "none" : DEFAULT_IMAGE_FAILURE_FALLBACK,
    imageFailureFallbackNotice:
      onebotCfg.imageFailureFallbackNotice === true ? true : DEFAULT_IMAGE_FAILURE_FALLBACK_NOTICE,
  };
}
