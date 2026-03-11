/**
 * OpenClaw OneBot Channel Plugin
 *
 * 将 OneBot v11 协议（QQ/Lagrange.Core/go-cqhttp）接入 OpenClaw Gateway。
 * 支持正向 WebSocket 和反向 WebSocket 连接。
 */

import WebSocket from "ws";
import { getOneBotConfig, resolvePluginVersion } from "./config";
import { OneBotChannelPlugin } from "./channel";
import { registerTools } from "./tools/register";
import { processInboundMessage, handleGroupIncrease } from "./inbound/process";
import { startMediaCacheCleanupLoop, stopMediaCacheCleanupLoop } from "./outbound/send";
import {
  getWs,
  setWs,
  getPendingEcho,
  connectForward,
  createServerAndWait,
  closeAll,
} from "./ws/connection";
import type { OneBotMessage } from "./types";

const pluginVersion = resolvePluginVersion();

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

  registerTools(api);

  api.registerService({
    id: "onebot-ws",
    start: async () => {
      const config = getOneBotConfig(api);
      if (!config) {
        api.logger?.warn?.("[onebot] no config, service will not connect");
        return;
      }
      startMediaCacheCleanupLoop();

      try {
        if (config.type === "forward-websocket") {
          setWs(await connectForward(config));
        } else {
          setWs(await createServerAndWait(config));
        }

        api.logger?.info?.("[onebot] WebSocket connected");

        const ws = getWs()!;
        const pendingEcho = getPendingEcho();

        ws.on("message", (data: Buffer) => {
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
            } else if (msg.post_type === "notice" && (msg as any).notice_type === "offline_file") {
              // 私聊离线文件 → 构造合成消息走正常处理流程
              const fileData = (msg as any).file;
              if (fileData && typeof msg.user_id === "number") {
                const syntheticMsg: OneBotMessage = {
                  post_type: "message",
                  message_type: "private",
                  user_id: msg.user_id,
                  self_id: msg.self_id,
                  message_id: (msg as any).message_id,
                  time: msg.time,
                  message: [
                    { type: "file", data: {
                      name: fileData.name,
                      size: fileData.size,
                      url: fileData.url,
                      file_id: fileData.id,
                    }},
                  ],
                  raw_message: `[文件: ${fileData.name ?? "unknown"}]`,
                };
                processInboundMessage(api, syntheticMsg).catch((e) => {
                  api.logger?.error?.(`[onebot] processInboundMessage(offline_file): ${e?.message}`);
                });
              }
            }
          } catch (e: any) {
            api.logger?.error?.(`[onebot] parse message: ${e?.message}`);
          }
        });

        ws.on("close", () => {
          api.logger?.info?.("[onebot] WebSocket closed");
        });

        ws.on("error", (e: Error) => {
          api.logger?.error?.(`[onebot] WebSocket error: ${e?.message}`);
        });
      } catch (e: any) {
        api.logger?.error?.(`[onebot] start failed: ${e?.message}`);
      }
    },
    stop: async () => {
      closeAll();
      stopMediaCacheCleanupLoop();
      api.logger?.info?.("[onebot] service stopped");
    },
  });

  api.logger?.info?.(`[onebot] plugin loaded (version=${pluginVersion})`);
}
