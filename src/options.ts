const DEFAULT_THINKING_EMOJI_ID = 60;
const DEFAULT_IMAGE_CACHE_DIR = "/data/.openclaw/workspace/.onebot-image-cache";
const DEFAULT_QQIMG_CLOSE_VARIANTS = ["qqimg", "img"];

export interface OneBotRuntimeOptions {
  thinkingEmojiEnabled: boolean;
  thinkingEmojiId: number;
  qqimgTagEnabled: boolean;
  qqimgTagCloseVariants: string[];
  imageCacheDir: string;
}

export function resolveOneBotRuntimeOptions(cfg: any): OneBotRuntimeOptions {
  const onebotCfg = cfg?.channels?.onebot ?? {};

  const rawEmojiId = Number(onebotCfg.thinkingEmojiId);
  const thinkingEmojiId = Number.isFinite(rawEmojiId) ? rawEmojiId : DEFAULT_THINKING_EMOJI_ID;

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
  };
}
