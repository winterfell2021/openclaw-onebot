import { dirname } from "node:path";
import { resolveOneBotRuntimeOptions } from "../options";
import { getOneBotConfig, getRuntimeOptions } from "../config";
import {
  normalizeReplyToId,
  normalizeCompactText,
  resolveMessageTimestampMs,
  resolveSenderDisplayLabel,
  stripNoReplyMarker,
  STREAM_TEXT_FLUSH_DELAY_MS,
  mergeBufferedReplyText,
} from "../utils";
import { appendGroupChatLog } from "../group/chat-log";
import { parseOneBotInboundMessage, resolveInboundMediaForPrompt } from "../inbound/media";
import { GroupMentionMediaCache } from "../group/media-cache";
import { isMentioned, resolveQuotedMessage, resolveForwardMessageText } from "../inbound/resolve";
import { resolveInboundFiles, buildFileInfoPromptText } from "../inbound/files";
import {
  sendGroupMsg,
  sendPrivateMsg,
  sendMediaByKind,
  setMsgEmojiLike,
  deliverTextWithQqMedia,
} from "../outbound/send";
import {
  loadPluginSdk,
  getBuildPendingHistoryContextFromMap,
  getRecordPendingHistoryEntry,
  getClearHistoryEntriesIfEnabled,
  sessionHistories,
  DEFAULT_HISTORY_LIMIT,
  resolveExecutionSessionKey,
  getGroupSharedContextStore,
} from "../session/history";
import {
  createReplySummaryAccumulator,
  appendReplySummary,
  hasReplySummaryContent,
} from "../session/reply-summary";
import { oneBotToolContextStorage } from "../tools/context";
import type { OneBotMessage } from "../types";
import type { OneBotTarget } from "../target-policy";
import type { GroupSharedContextStore } from "../group/shared-context";

let groupMentionMediaCache: GroupMentionMediaCache | null = null;
let groupMentionMediaCacheTtlMs = 0;

function getGroupMentionMediaCache(runtimeOptions: { groupMentionMediaTtlMs: number }): GroupMentionMediaCache {
  if (!groupMentionMediaCache || groupMentionMediaCacheTtlMs !== runtimeOptions.groupMentionMediaTtlMs) {
    groupMentionMediaCache = new GroupMentionMediaCache(runtimeOptions.groupMentionMediaTtlMs);
    groupMentionMediaCacheTtlMs = runtimeOptions.groupMentionMediaTtlMs;
  }
  return groupMentionMediaCache;
}

export async function processInboundMessage(api: any, msg: OneBotMessage): Promise<void> {
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

  const senderDisplayLabelForLog = resolveSenderDisplayLabel(msg, userId);

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
          senderLabel: senderDisplayLabelForLog,
          cachedImagePaths: inboundMedia.paths.length > 0 ? inboundMedia.paths : undefined,
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
  const resolvedQuoted = await resolveQuotedMessage(replyMessageId, api.logger);
  let quotedBody = resolvedQuoted?.body;

  // Resolve forward message if the inbound message itself is a forward
  let forwardBody: string | undefined;
  if (parsedInbound.forwardId) {
    forwardBody = await resolveForwardMessageText(parsedInbound.forwardId, api.logger);
    if (forwardBody) {
      forwardBody = `[转发的聊天记录]\n${forwardBody}`;
    }
  }

  // Resolve images from the quoted message so the AI can see them
  if (resolvedQuoted && resolvedQuoted.imageSources.length > 0) {
    const quotedMedia = await resolveInboundMediaForPrompt(
      resolvedQuoted.imageSources,
      runtimeOptions.imageCacheDir,
      runtimeOptions.imageCacheMaxAgeMs,
      api.logger,
    );
    if (quotedMedia.paths.length > 0) {
      effectiveInboundMedia = {
        paths: [...quotedMedia.paths, ...effectiveInboundMedia.paths],
        urls: [...quotedMedia.urls, ...effectiveInboundMedia.urls],
        types: [...quotedMedia.types, ...effectiveInboundMedia.types],
      };
      hasEffectiveInboundMedia = true;
      // 把引用消息的图片本地路径追加到 quotedBody，让 AI 能看到
      const pathList = quotedMedia.paths.map((p) => `[引用图片: ${p}]`).join("\n");
      quotedBody = quotedBody ? `${quotedBody}\n${pathList}` : pathList;
      api.logger?.info?.(
        `[onebot] resolved ${quotedMedia.paths.length} image(s) from quoted message`,
      );
    }
  }

  // 解析入站文件（私聊/群聊均支持）
  const workspaceDir = runtimeOptions.groupChatLogDir
    ? dirname(runtimeOptions.groupChatLogDir)
    : "/data/.openclaw/workspace";
  const resolvedFiles = await resolveInboundFiles(parsedInbound.fileInfos, workspaceDir, api.logger);
  const fileInfoText = buildFileInfoPromptText(resolvedFiles);

  if (!messageText?.trim() && !hasEffectiveInboundMedia && !quotedBody?.trim() && !forwardBody?.trim() && !resolvedFiles.length) {
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

  // Session management commands should target the parent (shared) session in group chats
  const SESSION_COMMANDS = new Set(["/compact", "/reset", "/new"]);
  const isSessionCommand = isGroup && !!sharedGroupKey &&
    typeof messageText === "string" &&
    SESSION_COMMANDS.has(messageText.trim().toLowerCase());
  const effectiveSessionId = isSessionCommand ? sharedGroupKey! : sessionId;

  if (isSessionCommand) {
    api.logger?.info?.(`[onebot] session command "${messageText!.trim()}" redirected to parent session ${sharedGroupKey}`);
  }

  const routeSessionKey = sharedGroupKey ?? effectiveSessionId;

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
  const senderDisplayLabel = senderDisplayLabelForLog;
  const currentTarget: OneBotTarget =
    isGroup && groupId ? { type: "group", id: groupId } : { type: "user", id: userId };
  const conversationLabel =
    currentTarget.type === "group" ? `group:${currentTarget.id}` : `user:${currentTarget.id}`;
  const routeTo = `${currentTarget.type}:${currentTarget.id}`;
  let promptBody = messageText || quotedBody || forwardBody || "";
  if (forwardBody && messageText) {
    promptBody = `${messageText}\n\n${forwardBody}`;
  }
  if (quotedBody && forwardBody && !messageText) {
    promptBody = quotedBody;
  }
  if (fileInfoText) {
    promptBody = promptBody ? `${promptBody}\n${fileInfoText}` : fileInfoText;
  }
  let groupSharedContextInfo:
    | {
        store: GroupSharedContextStore;
        groupId: number;
        executionKey: string;
        currentText: string;
      }
    | null = null;

  if (isGroup && sharedGroupKey && typeof groupId === "number" && !isSessionCommand) {
    const sharedStore = getGroupSharedContextStore(runtimeOptions);
    const sharedTurn = sharedStore.beginTurn({
      groupId,
      executionKey: effectiveSessionId,
      senderLabel: senderDisplayLabel,
      userId,
      messageId: inboundMessageId != null ? String(inboundMessageId) : effectiveSessionId,
      timestamp: messageTimestampMs,
      text: messageText,
      imageCount: effectiveInboundMedia.paths.length,
      replyText: quotedBody,
    });
    promptBody = sharedTurn.promptContext;
    groupSharedContextInfo = {
      store: sharedStore,
      groupId,
      executionKey: effectiveSessionId,
      currentText: sharedTurn.currentText,
    };
  }

  const buildPendingHistoryContextFromMap = getBuildPendingHistoryContextFromMap();
  const recordPendingHistoryEntry = getRecordPendingHistoryEntry();
  const clearHistoryEntriesIfEnabled = getClearHistoryEntriesIfEnabled();

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
            historyKey: effectiveSessionId,
            limit: DEFAULT_HISTORY_LIMIT,
            currentMessage: formattedBody,
            formatEntry: formatHistoryEntry,
          })
        : formattedBody;

  if (!isGroup && recordPendingHistoryEntry) {
    recordPendingHistoryEntry({
      historyMap: sessionHistories,
      historyKey: effectiveSessionId,
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
    SessionKey: effectiveSessionId,
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
      sessionKey: effectiveSessionId,
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

  api.logger?.info?.(`[onebot] dispatching message for session ${effectiveSessionId}`);

  try {
    await oneBotToolContextStorage.run(
      {
        target: currentTarget,
        sessionKey: effectiveSessionId,
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
                      historyKey: effectiveSessionId,
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
                      historyKey: effectiveSessionId,
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

export async function handleGroupIncrease(api: any, msg: OneBotMessage): Promise<void> {
  const cfg = api.config;
  const gi = (cfg?.channels?.onebot as any)?.groupIncrease;
  if (!gi?.enabled || !gi?.message) return;

  const groupId = msg.group_id as number;
  const userId = msg.user_id as number;

  const text = String(gi.message || "").replace(/\{userId\}/g, String(userId));
  if (!text.trim()) return;

  try {
    await sendGroupMsg(groupId, text);
    api.logger?.info?.(`[onebot] sent group welcome to ${groupId} for user ${userId}`);
  } catch (e: any) {
    api.logger?.error?.(`[onebot] group welcome failed: ${e?.message}`);
  }
}
