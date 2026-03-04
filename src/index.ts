/**
 * OpenClaw OneBot Channel Plugin
 *
 * 将 OneBot v11 协议（QQ/Lagrange.Core/go-cqhttp）接入 OpenClaw Gateway。
 * 支持正向 WebSocket 和反向 WebSocket 连接。
 */

import WebSocket from "ws";
import { createServer } from "http";
import { cleanupImageCache, resolveImageForNapCat } from "./image";
import { resolveOneBotRuntimeOptions, type OneBotRuntimeOptions } from "./options";
import { parseQqimgSegments } from "./qqimg";

// 尝试加载 plugin-sdk（兼容 openclaw 与 clawdbot）- 懒加载
let sdkLoaded = false;
let buildPendingHistoryContextFromMap: any;
let recordPendingHistoryEntry: any;
let clearHistoryEntriesIfEnabled: any;

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

interface OneBotTarget {
  type: "group" | "user";
  id: number;
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

let imageCacheCleanupTimer: ReturnType<typeof setInterval> | null = null;

function startImageCacheCleanupLoop(cacheDir: string): void {
  stopImageCacheCleanupLoop();
  cleanupImageCache(cacheDir);
  imageCacheCleanupTimer = setInterval(() => {
    cleanupImageCache(cacheDir);
  }, 60 * 60 * 1000);
}

function stopImageCacheCleanupLoop(): void {
  if (!imageCacheCleanupTimer) return;
  clearInterval(imageCacheCleanupTimer);
  imageCacheCleanupTimer = null;
}

async function deliverTextWithQqimg(
  text: string,
  target: OneBotTarget,
  options: OneBotRuntimeOptions,
  logger?: { error?: (msg: string) => void },
): Promise<void> {
  const cleaned = stripNoReplyMarker(text);
  if (!cleaned) return;

  if (!options.qqimgTagEnabled) {
    if (target.type === "group") await sendGroupMsg(target.id, cleaned);
    else await sendPrivateMsg(target.id, cleaned);
    return;
  }

  const queue = parseQqimgSegments(cleaned, options.qqimgTagCloseVariants);
  for (const item of queue) {
    try {
      if (item.type === "text") {
        if (target.type === "group") await sendGroupMsg(target.id, item.content);
        else await sendPrivateMsg(target.id, item.content);
      } else {
        if (target.type === "group") await sendGroupImage(target.id, item.content, options.imageCacheDir);
        else await sendPrivateImage(target.id, item.content, options.imageCacheDir);
      }
    } catch (err: any) {
      logger?.error?.(`[onebot] send ${item.type} failed: ${err?.message || err}`);
    }
  }
}

// ============ 从 OneBot 消息提取文本 ============

function getRawText(msg: OneBotMessage): string {
  if (!msg) return "";
  if (typeof msg.raw_message === "string" && msg.raw_message) {
    return msg.raw_message;
  }
  const arr = msg.message;
  if (!Array.isArray(arr)) return "";
  return arr
    .filter((m) => m?.type === "text")
    .map((m) => (m?.data as any)?.text ?? "")
    .join("");
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
const pendingEcho = new Map<string, { resolve: (v: any) => void }>();
let echoCounter = 0;

function nextEcho(): string {
  return `onebot-${Date.now()}-${++echoCounter}`;
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
        resolve(v);
      },
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

async function sendPrivateMsg(userId: number, text: string): Promise<void> {
  const w = ws;
  if (!w || w.readyState !== WebSocket.OPEN) {
    throw new Error("OneBot WebSocket not connected");
  }
  await sendOneBotAction(w, "send_private_msg", { user_id: userId, message: text });
}

async function sendGroupMsg(groupId: number, text: string): Promise<void> {
  const w = ws;
  if (!w || w.readyState !== WebSocket.OPEN) {
    throw new Error("OneBot WebSocket not connected");
  }
  await sendOneBotAction(w, "send_group_msg", { group_id: groupId, message: text });
}

/** 发送图片：message 可为 file 路径（file://、http://、base64://）或消息段数组 */
async function sendGroupImage(groupId: number, image: string, imageCacheDir?: string): Promise<void> {
  const w = ws;
  if (!w || w.readyState !== WebSocket.OPEN) throw new Error("OneBot WebSocket not connected");
  const seg = image.startsWith("[")
    ? JSON.parse(image)
    : [{ type: "image", data: { file: await resolveImageForNapCat(image, imageCacheDir || resolveOneBotRuntimeOptions((globalThis as any).__onebotApi?.config).imageCacheDir) } }];
  await sendOneBotAction(w, "send_group_msg", { group_id: groupId, message: seg });
}

async function sendPrivateImage(userId: number, image: string, imageCacheDir?: string): Promise<void> {
  const w = ws;
  if (!w || w.readyState !== WebSocket.OPEN) throw new Error("OneBot WebSocket not connected");
  const seg = image.startsWith("[")
    ? JSON.parse(image)
    : [{ type: "image", data: { file: await resolveImageForNapCat(image, imageCacheDir || resolveOneBotRuntimeOptions((globalThis as any).__onebotApi?.config).imageCacheDir) } }];
  await sendOneBotAction(w, "send_private_msg", { user_id: userId, message: seg });
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
    sendText: async ({ to, text }: { to: string; text: string }) => {
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
      await deliverTextWithQqimg(text, target, runtimeOptions, (globalThis as any).__onebotApi?.logger);
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
  const messageText = getRawText(msg);
  if (!messageText?.trim()) {
    api.logger?.info?.(`[onebot] ignoring empty message`);
    return;
  }

  const isGroup = msg.message_type === "group";
  const selfId = msg.self_id ?? 0;
  const requireMention = (cfg?.channels?.onebot as any)?.requireMention ?? true;

  if (isGroup && requireMention && !isMentioned(msg, selfId)) {
    api.logger?.info?.(`[onebot] ignoring group message without @mention`);
    return;
  }

  const userId = msg.user_id!;
  const groupId = msg.group_id;
  const sessionId = isGroup
    ? `onebot:group:${groupId}`.toLowerCase()
    : `onebot:${userId}`.toLowerCase();

  const route = runtime.channel.routing?.resolveAgentRoute?.({
    cfg,
    sessionKey: sessionId,
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

  const formattedBody =
    runtime.channel.reply?.formatInboundEnvelope?.({
      channel: "OneBot",
      from: fromLabel,
      timestamp: Date.now(),
      body: messageText,
      chatType,
      sender: { name: fromLabel, id: String(userId) },
      envelope: envelopeOptions,
    }) ?? { content: [{ type: "text", text: messageText }] };

  const body = buildPendingHistoryContextFromMap
    ? buildPendingHistoryContextFromMap({
        historyMap: sessionHistories,
        historyKey: sessionId,
        limit: DEFAULT_HISTORY_LIMIT,
        currentMessage: formattedBody,
        formatEntry: (entry: any) =>
          runtime.channel.reply?.formatInboundEnvelope?.({
            channel: "OneBot",
            from: fromLabel,
            timestamp: entry.timestamp,
            body: entry.body,
            chatType,
            senderLabel: entry.sender,
            envelope: envelopeOptions,
          }) ?? { content: [{ type: "text", text: entry.body }] },
      })
    : formattedBody;

  if (recordPendingHistoryEntry) {
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
    RawBody: messageText,
    From: isGroup ? `onebot:group:${groupId}` : `onebot:${userId}`,
    To: `onebot:${userId}`,
    SessionKey: sessionId,
    AccountId: config.accountId ?? "default",
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: fromLabel,
    SenderId: String(userId),
    Provider: "onebot",
    Surface: "onebot",
    MessageSid: `onebot-${Date.now()}`,
    Timestamp: Date.now(),
    OriginatingChannel: "onebot",
    OriginatingTo: `onebot:${userId}`,
    CommandAuthorized: true,
    _onebot: { userId, groupId, isGroup },
  };

  if (runtime.channel.session?.recordInboundSession) {
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: sessionId,
      ctx: ctxPayload,
      updateLastRoute: !isGroup ? { sessionKey: sessionId, channel: "onebot", to: String(userId), accountId: config.accountId ?? "default" } : undefined,
      onRecordError: (err: any) => api.logger?.warn?.(`[onebot] recordInboundSession: ${err}`),
    });
  }

  if (runtime.channel.activity?.record) {
    runtime.channel.activity.record({ channel: "onebot", accountId: config.accountId ?? "default", direction: "inbound" });
  }

  const runtimeOptions = resolveOneBotRuntimeOptions(cfg);

  const inboundMessageId = typeof msg.message_id === "number" ? msg.message_id : undefined;
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

  api.logger?.info?.(`[onebot] dispatching message for session ${sessionId}`);

  try {
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
            ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls.filter((v) => typeof v === "string" && v.trim()) : []),
            ...(typeof payload.mediaUrl === "string" && payload.mediaUrl.trim() ? [payload.mediaUrl] : []),
          ];
          if (!replyText && mediaCandidates.length === 0) return;

          await clearEmojiReaction();
          const { userId: uid, groupId: gid, isGroup: ig } = (ctxPayload as any)._onebot || {};
          const target = ig && gid ? ({ type: "group", id: gid } as const) : uid ? ({ type: "user", id: uid } as const) : null;
          if (!target) return;
          try {
            if (replyText) {
              await deliverTextWithQqimg(replyText, target, runtimeOptions, api.logger);
            }
            for (const mediaUrl of mediaCandidates) {
              if (target.type === "group") {
                await sendGroupImage(target.id, mediaUrl, runtimeOptions.imageCacheDir);
              } else {
                await sendPrivateImage(target.id, mediaUrl, runtimeOptions.imageCacheDir);
              }
            }
            if (info.kind === "final" && clearHistoryEntriesIfEnabled) {
              clearHistoryEntriesIfEnabled({
                historyMap: sessionHistories,
                historyKey: sessionId,
                limit: DEFAULT_HISTORY_LIMIT,
              });
            }
          } catch (e: any) {
            api.logger?.error?.(`[onebot] deliver failed: ${e?.message}`);
          }
        },
        onError: async (err: any, info: any) => {
          await clearEmojiReaction();
          api.logger?.error?.(`[onebot] ${info?.kind} reply failed: ${err}`);
        },
      },
      replyOptions: { disableBlockStreaming: true },
    });
  } catch (err: any) {
    await clearEmojiReaction();
    api.logger?.error?.(`[onebot] dispatch failed: ${err?.message}`);
    try {
      const { userId: uid, groupId: gid, isGroup: ig } = (ctxPayload as any)._onebot || {};
      if (ig && gid) await sendGroupMsg(gid, `处理失败: ${err?.message?.slice(0, 80) || "未知错误"}`);
      else if (uid) await sendPrivateMsg(uid, `处理失败: ${err?.message?.slice(0, 80) || "未知错误"}`);
    } catch (_) {}
  } finally {
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
        const target = parseOneBotTarget(params.target);
        if (!target) {
          return { content: [{ type: "text", text: `目标格式错误: ${params.target}` }] };
        }
        try {
          const runtimeOptions = resolveOneBotRuntimeOptions((globalThis as any).__onebotApi?.config);
          await deliverTextWithQqimg(params.text, target, runtimeOptions, (globalThis as any).__onebotApi?.logger);
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
        const target = parseOneBotTarget(params.target);
        if (!target) {
          return { content: [{ type: "text", text: `目标格式错误: ${params.target}` }] };
        }
        try {
          const runtimeOptions = resolveOneBotRuntimeOptions((globalThis as any).__onebotApi?.config);
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
        const target = parseOneBotTarget(params.target);
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
      const runtimeOptions = resolveOneBotRuntimeOptions(api.config);
      startImageCacheCleanupLoop(runtimeOptions.imageCacheDir);

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
      stopImageCacheCleanupLoop();
      api.logger?.info?.("[onebot] service stopped");
    },
  });

  api.logger?.info?.("[onebot] plugin loaded");
}
