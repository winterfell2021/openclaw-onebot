import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOneBotRuntimeOptions, type OneBotRuntimeOptions } from "./options";
import type { OneBotTarget } from "./target-policy";
import type { OneBotAccountConfig } from "./types";

export function getOneBotConfig(api: any, accountId?: string): OneBotAccountConfig | null {
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

export function listAccountIds(api: any): string[] {
  const cfg = api?.config ?? (globalThis as any).__onebotGatewayConfig;
  const accounts = cfg?.channels?.onebot?.accounts;
  if (accounts && Object.keys(accounts).length > 0) {
    return Object.keys(accounts);
  }
  if (cfg?.channels?.onebot?.host) return ["default"];
  return [];
}

export function parseOneBotTarget(input: string): OneBotTarget | null {
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

export function resolvePluginVersion(): string {
  try {
    const currentFilePath = fileURLToPath(import.meta.url);
    const currentDir = dirname(currentFilePath);
    const packageJsonPath = resolve(currentDir, "../package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    const version = pkg?.version;
    if (typeof version === "string" && version.trim()) {
      return version.trim();
    }
  } catch {
    // ignore
  }
  return "unknown";
}

export function getRuntimeOptions(): OneBotRuntimeOptions {
  return resolveOneBotRuntimeOptions((globalThis as any).__onebotApi?.config);
}
