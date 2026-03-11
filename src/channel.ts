import WebSocket from "ws";
import { getOneBotConfig, listAccountIds, parseOneBotTarget } from "./config";
import { resolveOneBotRuntimeOptions } from "./options";
import { getWs } from "./ws/connection";
import { deliverTextWithQqMedia, sendMediaByKind } from "./outbound/send";

export const OneBotChannelPlugin = {
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
    sendText: async ({
      to,
      text,
      replyToId,
    }: {
      to: string;
      text: string;
      replyToId?: string | null;
    }) => {
      const config = getOneBotConfig((globalThis as any).__onebotApi);
      if (!config) {
        return { ok: false, error: new Error("OneBot not configured") };
      }
      const w = getWs();
      if (!w || w.readyState !== WebSocket.OPEN) {
        return { ok: false, error: new Error("OneBot WebSocket not connected") };
      }
      const target = parseOneBotTarget(to);
      if (!target) {
        return { ok: false, error: new Error(`invalid target: ${to}`) };
      }
      const runtimeOptions = resolveOneBotRuntimeOptions((globalThis as any).__onebotApi?.config);
      await deliverTextWithQqMedia(
        text,
        target,
        runtimeOptions,
        (globalThis as any).__onebotApi?.logger,
        replyToId,
      );
      return { ok: true, provider: "onebot" };
    },
    sendMedia: async ({
      to,
      text,
      mediaUrl,
      replyToId,
    }: {
      to: string;
      text?: string;
      mediaUrl?: string;
      replyToId?: string | null;
    }) => {
      const config = getOneBotConfig((globalThis as any).__onebotApi);
      if (!config) {
        return { ok: false, error: new Error("OneBot not configured") };
      }
      const w = getWs();
      if (!w || w.readyState !== WebSocket.OPEN) {
        return { ok: false, error: new Error("OneBot WebSocket not connected") };
      }
      const target = parseOneBotTarget(to);
      if (!target) {
        return { ok: false, error: new Error(`invalid target: ${to}`) };
      }
      const resolvedMediaUrl = String(mediaUrl ?? "").trim();
      if (!resolvedMediaUrl) {
        return { ok: false, error: new Error("mediaUrl is required") };
      }
      const runtimeOptions = resolveOneBotRuntimeOptions((globalThis as any).__onebotApi?.config);
      await sendMediaByKind(target, resolvedMediaUrl, runtimeOptions, {
        caption: text,
        replyToId,
      });
      return { ok: true, provider: "onebot" };
    },
  },
};
