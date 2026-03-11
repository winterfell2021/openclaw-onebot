import WebSocket from "ws";
import { getWs, sendOneBotAction } from "../ws/connection";
import { normalizeReplyToId, buildInboundSharedBody } from "../utils";
import { parseOneBotInboundMessage } from "../inbound/media";
import type { OneBotMessage, ResolvedQuotedMessage } from "../types";

export function isMentioned(msg: OneBotMessage, selfId: number): boolean {
  const arr = msg.message;
  if (!Array.isArray(arr)) return false;
  const selfStr = String(selfId);
  return arr.some((m) => m?.type === "at" && String((m?.data as any)?.qq || (m?.data as any)?.id) === selfStr);
}

export const FORWARD_MSG_MAX_NODES = 30;
export const FORWARD_MSG_MAX_TEXT_LENGTH = 3000;

export async function resolveForwardMessageText(
  forwardId: string,
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void },
): Promise<string | undefined> {
  const w = getWs();
  if (!forwardId || !w || w.readyState !== WebSocket.OPEN) return undefined;

  try {
    const response = await sendOneBotAction(w, "get_forward_msg", {
      message_id: forwardId,
      id: forwardId,
    });
    const data = response?.data;
    const messages: any[] =
      Array.isArray(data?.messages) ? data.messages :
      Array.isArray(data?.message) ? data.message :
      Array.isArray(data) ? data : [];

    if (messages.length === 0) {
      logger?.warn?.(`[onebot] get_forward_msg returned empty for id=${forwardId}`);
      return undefined;
    }

    const lines: string[] = [];
    const nodeCount = Math.min(messages.length, FORWARD_MSG_MAX_NODES);
    let totalLength = 0;

    for (let i = 0; i < nodeCount; i++) {
      const node = messages[i];
      if (!node || typeof node !== "object") continue;

      const sender = node.sender ?? node.user_info ?? {};
      const nickname = String(sender.nickname ?? sender.card ?? sender.user_id ?? "未知").trim();
      const content = Array.isArray(node.message) ? node.message :
                       Array.isArray(node.content) ? node.content : [];

      const textParts: string[] = [];
      let imageCount = 0;
      for (const seg of content) {
        if (!seg || typeof seg !== "object") continue;
        if (seg.type === "text" && typeof seg.data?.text === "string") {
          textParts.push(seg.data.text);
        } else if (seg.type === "image") {
          imageCount++;
        }
      }

      const text = textParts.join("").trim();
      const suffix = imageCount > 0 ? ` [图片${imageCount}张]` : "";
      const line = `${nickname}：${text || (imageCount > 0 ? "" : "（空）")}${suffix}`;
      totalLength += line.length;
      if (totalLength > FORWARD_MSG_MAX_TEXT_LENGTH) {
        lines.push(`...（共 ${messages.length} 条消息，已截断）`);
        break;
      }
      lines.push(line);
    }

    if (messages.length > nodeCount && totalLength <= FORWARD_MSG_MAX_TEXT_LENGTH) {
      lines.push(`...（共 ${messages.length} 条消息，仅展示前 ${nodeCount} 条）`);
    }

    const result = lines.join("\n");
    logger?.info?.(`[onebot] resolved forward message: ${messages.length} nodes, ${result.length} chars`);
    return result;
  } catch (err: any) {
    logger?.warn?.(`[onebot] resolve forward message failed: ${err?.message || err}`);
    return undefined;
  }
}

export async function resolveQuotedMessage(
  replyMessageId: string | number | undefined,
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void },
): Promise<ResolvedQuotedMessage | undefined> {
  const normalizedReplyId = normalizeReplyToId(replyMessageId);
  const w = getWs();
  if (!normalizedReplyId || !w || w.readyState !== WebSocket.OPEN) {
    return undefined;
  }

  try {
    const response = await sendOneBotAction(w, "get_msg", {
      message_id: normalizedReplyId,
    });
    const messageData = response?.data && typeof response.data === "object" ? response.data : response;
    const quoted = parseOneBotInboundMessage(messageData as any);

    // If the quoted message is a forward message, resolve its content
    if (quoted.forwardId) {
      const forwardText = await resolveForwardMessageText(quoted.forwardId, logger);
      if (forwardText) {
        return {
          body: `[转发的聊天记录]\n${forwardText}`,
          imageSources: quoted.imageSources,
        };
      }
    }

    return {
      body: buildInboundSharedBody(quoted.text, quoted.imageSources.length),
      imageSources: quoted.imageSources,
    };
  } catch (err: any) {
    logger?.warn?.(`[onebot] resolve quoted message failed: ${err?.message || err}`);
    return undefined;
  }
}
