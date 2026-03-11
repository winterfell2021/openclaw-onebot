import { dirname, join } from "node:path";
import { GroupSharedContextStore } from "../group/shared-context";
import type { OneBotRuntimeOptions } from "../options";

// 尝试加载 plugin-sdk（兼容 openclaw 与 clawdbot）- 懒加载
let sdkLoaded = false;
let buildPendingHistoryContextFromMap: any;
let recordPendingHistoryEntry: any;
let clearHistoryEntriesIfEnabled: any;

export async function loadPluginSdk(): Promise<void> {
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

export function getBuildPendingHistoryContextFromMap(): any {
  return buildPendingHistoryContextFromMap;
}

export function getRecordPendingHistoryEntry(): any {
  return recordPendingHistoryEntry;
}

export function getClearHistoryEntriesIfEnabled(): any {
  return clearHistoryEntriesIfEnabled;
}

export const DEFAULT_HISTORY_LIMIT = 20;
export const DEFAULT_GROUP_SHARED_HISTORY_LIMIT = DEFAULT_HISTORY_LIMIT * 2;
const GROUP_SHARED_CONTEXT_DIRNAME = ".onebot-group-shared-context";

export const sessionHistories = new Map<string, Array<{ sender: string; body: string; timestamp: number; messageId: string }>>();
const groupSharedContextStores = new Map<string, GroupSharedContextStore>();

export function resolveExecutionSessionKey(
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

export function resolveGroupSharedContextDir(runtimeOptions: OneBotRuntimeOptions): string {
  return join(dirname(runtimeOptions.groupChatLogDir), GROUP_SHARED_CONTEXT_DIRNAME);
}

export function getGroupSharedContextStore(runtimeOptions: OneBotRuntimeOptions): GroupSharedContextStore {
  const rootDir = resolveGroupSharedContextDir(runtimeOptions);
  let store = groupSharedContextStores.get(rootDir);
  if (!store) {
    store = new GroupSharedContextStore(rootDir, DEFAULT_GROUP_SHARED_HISTORY_LIMIT);
    groupSharedContextStores.set(rootDir, store);
  }
  return store;
}
