import WebSocket from "ws";
import { getWs } from "../ws/connection";
import { getRuntimeOptions } from "../config";
import { resolveEffectiveToolTarget } from "./context";
import {
  deliverTextWithQqMedia,
  sendGroupImage,
  sendPrivateImage,
  sendGroupVideo,
  sendPrivateVideo,
  uploadGroupFileAction,
  uploadPrivateFileAction,
} from "../outbound/send";

export function registerTools(api: any): void {
  if (typeof api.registerTool !== "function") return;

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
      const runtimeOptions = getRuntimeOptions();
      const target = resolveEffectiveToolTarget(params.target, runtimeOptions, (globalThis as any).__onebotApi?.logger);
      if (!target) {
        return { content: [{ type: "text", text: `目标格式错误: ${params.target}` }] };
      }
      try {
        await deliverTextWithQqMedia(params.text, target, runtimeOptions, (globalThis as any).__onebotApi?.logger);
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
      const runtimeOptions = getRuntimeOptions();
      const target = resolveEffectiveToolTarget(params.target, runtimeOptions, (globalThis as any).__onebotApi?.logger);
      if (!target) {
        return { content: [{ type: "text", text: `目标格式错误: ${params.target}` }] };
      }
      try {
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
    name: "onebot_send_video",
    description:
      "通过 OneBot 发送视频。target 格式：user:QQ号 或 group:群号。video 为本地路径(file://)或 URL 或 base64://",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string" },
        video: { type: "string", description: "视频路径或 URL" },
      },
      required: ["target", "video"],
    },
    async execute(_id: string, params: { target: string; video: string }) {
      const w = getWs();
      if (!w || w.readyState !== WebSocket.OPEN) {
        return { content: [{ type: "text", text: "OneBot 未连接" }] };
      }
      const runtimeOptions = getRuntimeOptions();
      const target = resolveEffectiveToolTarget(params.target, runtimeOptions, (globalThis as any).__onebotApi?.logger);
      if (!target) {
        return { content: [{ type: "text", text: `目标格式错误: ${params.target}` }] };
      }
      try {
        if (target.type === "group") {
          await sendGroupVideo(target.id, params.video, runtimeOptions.videoCacheDir);
        } else {
          await sendPrivateVideo(target.id, params.video, runtimeOptions.videoCacheDir);
        }
        return { content: [{ type: "text", text: "视频发送成功" }] };
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
      const runtimeOptions = getRuntimeOptions();
      const target = resolveEffectiveToolTarget(params.target, runtimeOptions, (globalThis as any).__onebotApi?.logger);
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
