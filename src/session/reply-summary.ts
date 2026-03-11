import { normalizeCompactText, mergeTextFragments, resolveOutboundMediaKind } from "../utils";
import type { OneBotRuntimeOptions } from "../options";
import type { ReplySummaryAccumulator } from "../types";

export function createReplySummaryAccumulator(): ReplySummaryAccumulator {
  return {
    text: "",
    imageCount: 0,
    videoCount: 0,
  };
}

export function appendReplySummary(
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

export function buildReplySummary(accumulator: ReplySummaryAccumulator): string {
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

export function hasReplySummaryContent(accumulator: ReplySummaryAccumulator): boolean {
  return Boolean(normalizeCompactText(accumulator.text) || accumulator.imageCount > 0 || accumulator.videoCount > 0);
}
