import WebSocket from "ws";
import { createServer } from "http";
import type { OneBotAccountConfig } from "../types";

let ws: WebSocket | null = null;
let wsServer: import("ws").WebSocketServer | null = null;
let httpServer: import("http").Server | null = null;
const pendingEcho = new Map<string, { resolve: (v: any) => void; reject: (err: Error) => void }>();
let echoCounter = 0;

export function getWs(): WebSocket | null {
  return ws;
}

export function setWs(value: WebSocket | null): void {
  ws = value;
}

export function getWsServer(): import("ws").WebSocketServer | null {
  return wsServer;
}

export function getHttpServer(): import("http").Server | null {
  return httpServer;
}

export function getPendingEcho(): Map<string, { resolve: (v: any) => void; reject: (err: Error) => void }> {
  return pendingEcho;
}

function nextEcho(): string {
  return `onebot-${Date.now()}-${++echoCounter}`;
}

export function oneBotActionError(action: string, resp: any): Error {
  const code = typeof resp?.retcode === "number" ? resp.retcode : "unknown";
  const detail = resp?.msg || resp?.message || resp?.wording || "";
  return new Error(`OneBot action ${action} failed: retcode=${code}${detail ? ` ${detail}` : ""}`);
}

export function isOneBotActionOk(resp: any): boolean {
  if (typeof resp?.retcode === "number" && resp.retcode !== 0) return false;
  if (typeof resp?.status === "string" && resp.status.toLowerCase() !== "ok") return false;
  return true;
}

export function sendOneBotAction(wsocket: WebSocket, action: string, params: Record<string, unknown>): Promise<any> {
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
        if (!isOneBotActionOk(v)) {
          reject(oneBotActionError(action, v));
          return;
        }
        resolve(v);
      },
      reject,
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

export async function connectForward(config: OneBotAccountConfig): Promise<WebSocket> {
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

export async function createServerAndWait(config: OneBotAccountConfig): Promise<WebSocket> {
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

export function closeAll(): void {
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
}
