import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PERSIST_DIR = "/data/.openclaw/workspace/.onebot-group-shared-context";
const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_SUMMARY_MAX_CHARS = 240;

export interface GroupSharedTurnRecord {
  groupId: number;
  arrivalSeq: number;
  senderLabel: string;
  userId: number;
  messageId: string;
  timestamp: number;
  userText: string;
  replyText?: string;
  assistantText: string;
}

interface PendingGroupSharedTurn {
  executionKey: string;
  groupId: number;
  arrivalSeq: number;
  senderLabel: string;
  userId: number;
  messageId: string;
  timestamp: number;
  userText: string;
  replyText?: string;
  summaryText: string;
  assistantText?: string;
  completed: boolean;
  completedAt?: number;
}

interface PersistedGroupSharedState {
  turns: GroupSharedTurnRecord[];
}

interface GroupSharedGroupState {
  hydrated: boolean;
  nextArrivalSeq: number;
  turns: GroupSharedTurnRecord[];
  inflight: Map<string, PendingGroupSharedTurn>;
}

export interface BeginGroupSharedTurnParams {
  groupId: number;
  executionKey: string;
  senderLabel: string;
  userId: number;
  messageId: string;
  timestamp: number;
  text: string;
  imageCount?: number;
  replyText?: string;
}

export interface BeginGroupSharedTurnResult {
  arrivalSeq: number;
  currentText: string;
  promptContext: string;
}

export interface CompleteGroupSharedTurnParams {
  groupId: number;
  executionKey: string;
  assistantText: string;
  completedAt?: number;
}

export interface ClearGroupSharedContextOptions {
  removePersisted?: boolean;
}

function normalizeLineText(value: unknown): string {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collapseWhitespace(value: string): string {
  return normalizeLineText(value)
    .replace(/\s*\n+\s*/g, " / ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function truncateText(value: string, maxChars = DEFAULT_SUMMARY_MAX_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildUserText(text: string, imageCount = 0, replyText?: string): string {
  const sections: string[] = [];
  const normalizedReply = normalizeLineText(replyText);
  const normalizedText = normalizeLineText(text);

  if (normalizedReply) {
    sections.push(`引用消息：${normalizedReply}`);
  }
  if (normalizedText) {
    sections.push(`消息：${normalizedText}`);
  }
  if (imageCount > 0) {
    sections.push(`附图：${imageCount} 张`);
  }
  if (sections.length === 0) {
    sections.push("消息：（空消息）");
  }
  return sections.join("\n");
}

function buildPendingSummary(turn: PendingGroupSharedTurn): string {
  const collapsed = collapseWhitespace(turn.userText).replace(/^消息：/, "");
  return `发送者：${turn.senderLabel}；消息：${truncateText(collapsed)}`;
}

function formatCommittedTurn(turn: GroupSharedTurnRecord, index: number): string {
  const assistantText = normalizeLineText(turn.assistantText) || "（无可见回复）";
  return [
    `【历史 ${index}】`,
    `发送者：${turn.senderLabel}`,
    turn.userText,
    `助手回复：${assistantText}`,
  ].join("\n");
}

function parsePersistedTurns(value: unknown): GroupSharedTurnRecord[] {
  if (!Array.isArray((value as PersistedGroupSharedState | undefined)?.turns)) {
    return [];
  }
  const turns = (value as PersistedGroupSharedState).turns;
  const output: GroupSharedTurnRecord[] = [];
  for (const item of turns) {
    if (!item || typeof item !== "object") continue;
    const groupId = Number((item as GroupSharedTurnRecord).groupId);
    const arrivalSeq = Number((item as GroupSharedTurnRecord).arrivalSeq);
    const userId = Number((item as GroupSharedTurnRecord).userId);
    const timestamp = Number((item as GroupSharedTurnRecord).timestamp);
    const senderLabel = normalizeLineText((item as GroupSharedTurnRecord).senderLabel);
    const messageId = normalizeLineText((item as GroupSharedTurnRecord).messageId);
    const userText = normalizeLineText((item as GroupSharedTurnRecord).userText);
    const assistantText = normalizeLineText((item as GroupSharedTurnRecord).assistantText);
    const replyText = normalizeLineText((item as GroupSharedTurnRecord).replyText);
    if (
      !Number.isSafeInteger(groupId) ||
      !Number.isSafeInteger(arrivalSeq) ||
      !Number.isSafeInteger(userId) ||
      !Number.isFinite(timestamp) ||
      !senderLabel ||
      !messageId
    ) {
      continue;
    }
    output.push({
      groupId,
      arrivalSeq,
      senderLabel,
      userId,
      messageId,
      timestamp,
      userText,
      replyText: replyText || undefined,
      assistantText,
    });
  }
  return output;
}

export class GroupSharedContextStore {
  private readonly groupStates = new Map<number, GroupSharedGroupState>();

  constructor(
    private readonly persistDir = DEFAULT_PERSIST_DIR,
    private readonly historyLimit = DEFAULT_HISTORY_LIMIT,
  ) {}

  beginTurn(params: BeginGroupSharedTurnParams): BeginGroupSharedTurnResult {
    const state = this.ensureGroupState(params.groupId);
    if (state.inflight.has(params.executionKey)) {
      throw new Error(`duplicate group execution key: ${params.executionKey}`);
    }

    const arrivalSeq = state.nextArrivalSeq++;
    const userText = buildUserText(params.text, params.imageCount ?? 0, params.replyText);
    const pending: PendingGroupSharedTurn = {
      executionKey: params.executionKey,
      groupId: params.groupId,
      arrivalSeq,
      senderLabel: normalizeLineText(params.senderLabel) || String(params.userId),
      userId: params.userId,
      messageId: normalizeLineText(params.messageId) || `group-${params.groupId}-${arrivalSeq}`,
      timestamp: params.timestamp,
      userText,
      replyText: normalizeLineText(params.replyText) || undefined,
      summaryText: "",
      completed: false,
    };
    pending.summaryText = buildPendingSummary(pending);
    state.inflight.set(params.executionKey, pending);

    return {
      arrivalSeq,
      currentText: pending.userText,
      promptContext: this.buildPromptContext(params.groupId, params.executionKey),
    };
  }

  buildPromptContext(groupId: number, executionKey: string): string {
    const state = this.ensureGroupState(groupId);
    const currentTurn = state.inflight.get(executionKey);
    if (!currentTurn) return "";

    const sections: string[] = [];
    if (state.turns.length > 0) {
      const historyBody = state.turns
        .slice(-this.historyLimit)
        .map((turn, index) => formatCommittedTurn(turn, index + 1))
        .join("\n\n");
      sections.push(`已提交的群共享历史：\n${historyBody}`);
    }

    const earlierInflight = [...state.inflight.values()]
      .filter((turn) => turn.executionKey !== executionKey && turn.arrivalSeq < currentTurn.arrivalSeq)
      .sort((left, right) => left.arrivalSeq - right.arrivalSeq);
    if (earlierInflight.length > 0) {
      sections.push(
        `更早到达但仍在处理的消息摘要：\n${earlierInflight.map((turn) => `- ${turn.summaryText}`).join("\n")}`,
      );
    }

    sections.push(
      [
        "【当前处理消息】",
        `发送者：${currentTurn.senderLabel}`,
        currentTurn.userText,
      ].join("\n"),
    );
    return sections.join("\n\n");
  }

  completeTurn(params: CompleteGroupSharedTurnParams): GroupSharedTurnRecord[] {
    const state = this.ensureGroupState(params.groupId);
    const pending = state.inflight.get(params.executionKey);
    if (!pending) return [];

    pending.completed = true;
    pending.completedAt = params.completedAt ?? Date.now();
    pending.assistantText = normalizeLineText(params.assistantText);
    return this.flushCompletedTurns(state);
  }

  hydrateGroup(groupId: number): GroupSharedTurnRecord[] {
    return [...this.ensureGroupState(groupId).turns];
  }

  getSnapshot(groupId: number): {
    turns: GroupSharedTurnRecord[];
    inflight: Array<{
      executionKey: string;
      arrivalSeq: number;
      senderLabel: string;
      summaryText: string;
      completed: boolean;
    }>;
    nextArrivalSeq: number;
  } {
    const state = this.ensureGroupState(groupId);
    return {
      turns: [...state.turns],
      inflight: [...state.inflight.values()]
        .sort((left, right) => left.arrivalSeq - right.arrivalSeq)
        .map((turn) => ({
          executionKey: turn.executionKey,
          arrivalSeq: turn.arrivalSeq,
          senderLabel: turn.senderLabel,
          summaryText: turn.summaryText,
          completed: turn.completed,
        })),
      nextArrivalSeq: state.nextArrivalSeq,
    };
  }

  clearGroup(groupId: number, options: ClearGroupSharedContextOptions = {}): void {
    this.groupStates.delete(groupId);
    if (!options.removePersisted || !this.persistDir) return;
    const filePath = this.resolveFilePath(groupId);
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
  }

  private ensureGroupState(groupId: number): GroupSharedGroupState {
    let state = this.groupStates.get(groupId);
    if (!state) {
      state = {
        hydrated: false,
        nextArrivalSeq: 1,
        turns: [],
        inflight: new Map<string, PendingGroupSharedTurn>(),
      };
      this.groupStates.set(groupId, state);
    }
    if (state.hydrated) return state;

    const persistedTurns = this.readPersistedTurns(groupId);
    state.turns = persistedTurns.slice(-this.historyLimit);
    state.nextArrivalSeq =
      persistedTurns.reduce((maxSeq, turn) => Math.max(maxSeq, turn.arrivalSeq), 0) + 1;
    state.hydrated = true;
    return state;
  }

  private flushCompletedTurns(state: GroupSharedGroupState): GroupSharedTurnRecord[] {
    const committedTurns: GroupSharedTurnRecord[] = [];
    const orderedInflight = [...state.inflight.values()].sort((left, right) => left.arrivalSeq - right.arrivalSeq);
    for (const turn of orderedInflight) {
      if (!turn.completed) break;
      const committedTurn: GroupSharedTurnRecord = {
        groupId: turn.groupId,
        arrivalSeq: turn.arrivalSeq,
        senderLabel: turn.senderLabel,
        userId: turn.userId,
        messageId: turn.messageId,
        timestamp: turn.timestamp,
        userText: turn.userText,
        replyText: turn.replyText,
        assistantText: normalizeLineText(turn.assistantText),
      };
      state.turns.push(committedTurn);
      if (state.turns.length > this.historyLimit) {
        state.turns.splice(0, state.turns.length - this.historyLimit);
      }
      state.inflight.delete(turn.executionKey);
      committedTurns.push(committedTurn);
    }
    if (committedTurns.length > 0) {
      this.persistTurns(committedTurns[0]!.groupId, state.turns);
    }
    return committedTurns;
  }

  private readPersistedTurns(groupId: number): GroupSharedTurnRecord[] {
    if (!this.persistDir) return [];
    const filePath = this.resolveFilePath(groupId);
    if (!existsSync(filePath)) return [];
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      return parsePersistedTurns(raw);
    } catch {
      return [];
    }
  }

  private persistTurns(groupId: number, turns: GroupSharedTurnRecord[]): void {
    if (!this.persistDir) return;
    mkdirSync(this.persistDir, { recursive: true });
    writeFileSync(
      this.resolveFilePath(groupId),
      `${JSON.stringify({ turns }, null, 2)}\n`,
      "utf-8",
    );
  }

  private resolveFilePath(groupId: number): string {
    return join(this.persistDir, `group-${groupId}.json`);
  }
}
