/**
 * OneBot TUI 配置向导
 * openclaw onebot setup
 */
import {
  cancel as clackCancel,
  intro as clackIntro,
  isCancel,
  note as clackNote,
  outro as clackOutro,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const OPENCLAW_HOME = join(homedir(), ".openclaw");
const CONFIG_PATH = join(OPENCLAW_HOME, "openclaw.json");

function guardCancel<T>(v: T | symbol): T {
  if (isCancel(v)) {
    clackCancel("已取消。");
    process.exit(0);
  }
  return v as T;
}

export async function runOneBotSetup(): Promise<void> {
  const type = guardCancel(
    await clackSelect({
      message: "连接类型",
      options: [
        { value: "forward-websocket", label: "forward-websocket（正向，主动连接 OneBot）" },
        { value: "backward-websocket", label: "backward-websocket（反向，OneBot 连接本机）" },
      ],
      initialValue: process.env.LAGRANGE_WS_TYPE === "backward-websocket" ? "backward-websocket" : "forward-websocket",
    })
  );

  const host = guardCancel(
    await clackText({
      message: "主机地址",
      initialValue: process.env.LAGRANGE_WS_HOST || "127.0.0.1",
    })
  );

  const portStr = guardCancel(
    await clackText({
      message: "端口",
      initialValue: process.env.LAGRANGE_WS_PORT || "3001",
    })
  );

  const accessToken = guardCancel(
    await clackText({
      message: "Access Token（可选，留空回车跳过）",
      initialValue: process.env.LAGRANGE_WS_ACCESS_TOKEN || "",
    })
  );

  const port = parseInt(String(portStr).trim(), 10);
  if (!Number.isFinite(port)) {
    console.error("端口必须为数字");
    process.exit(1);
  }

  let existing: any = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      existing = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch {}
  }

  const channels = existing.channels || {};
  channels.onebot = {
    ...(channels.onebot || {}),
    type,
    host: String(host).trim(),
    port,
    ...(accessToken?.trim() ? { accessToken: String(accessToken).trim() } : {}),
    enabled: true,
    requireMention: true,
    thinkingEmojiEnabled: false,
    thinkingEmojiId: 60,
    qqimgTagEnabled: true,
    qqimgTagCloseVariants: ["qqimg", "img"],
    qqvideoTagEnabled: true,
    qqvideoTagCloseVariants: ["qqvideo", "video"],
    blockStreaming: true,
    imageCacheDir: "/data/.openclaw/workspace/.onebot-image-cache",
    imageCacheMaxAgeMs: 86400000,
    videoCacheDir: "/data/.openclaw/workspace/.onebot-video-cache",
    videoCacheMaxAgeMs: 86400000,
    videoMaxBytes: 52428800,
    autoDetectVideoFromMediaUrls: true,
    videoGifTimeoutMs: 20000,
    videoGifFps: 10,
    videoGifWidth: 480,
    groupChatLogEnabled: true,
    groupChatLogDir: "/data/.openclaw/workspace/.onebot-group-chat-logs",
    groupChatLogTimeZone: "Asia/Shanghai",
    groupChatLogMaxTextLength: 2000,
    groupChatLogIncludeRawMessage: false,
    groupToolTargetPolicy: "force-current-group",
    imageFailureFallback: "upload-file",
    imageFailureFallbackNotice: false,
    videoFailureFallback: "upload-file",
    videoFailureFallbackNotice: false,
  };

  const next = { ...existing, channels };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");

  clackNote(`配置已保存到 ${CONFIG_PATH}`, "完成");
  clackOutro("运行 openclaw gateway restart 使配置生效");
}
