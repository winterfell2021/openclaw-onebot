import type { OneBotTarget } from "./target-policy";

export interface OneBotMessage {
  post_type: string;
  message_type?: "private" | "group";
  message_id?: number;
  user_id?: number;
  group_id?: number;
  sender?: {
    card?: string;
    nickname?: string;
    user_id?: number;
    [key: string]: unknown;
  };
  message?: Array<{ type: string; data?: Record<string, unknown> }>;
  raw_message?: string;
  self_id?: number;
  time?: number;
  [key: string]: unknown;
}

export interface OneBotAccountConfig {
  accountId?: string;
  type: "forward-websocket" | "backward-websocket";
  host: string;
  port: number;
  accessToken?: string;
  path?: string;
  enabled?: boolean;
}

export type OutboundMediaKind = "image" | "video";
export type OutboundReplyId = string | number;

export interface OneBotSendOptions {
  replyToId?: OutboundReplyId | null;
  caption?: string;
}

export interface OneBotToolExecutionContext {
  target: OneBotTarget | null;
  sessionKey: string;
  chatType: "group" | "direct";
}

export interface ResolvedInboundFile {
  name: string;
  size: number;
  localPath: string;
}

export interface ResolvedQuotedMessage {
  body: string;
  imageSources: string[];
}

export interface ReplySummaryAccumulator {
  text: string;
  imageCount: number;
  videoCount: number;
}
