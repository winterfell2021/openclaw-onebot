import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const DEFAULT_TIMEOUT_MS = 20 * 1000;
const DEFAULT_FPS = 10;
const DEFAULT_WIDTH = 480;

export interface VideoToGifOptions {
  timeoutMs?: number;
  fps?: number;
  width?: number;
}

function resolvePositiveInt(input: number | undefined, fallback: number): number {
  if (Number.isFinite(input) && Number(input) > 0) {
    return Math.floor(Number(input));
  }
  return fallback;
}

export async function convertVideoToGif(
  inputPath: string,
  outputDir: string,
  options: VideoToGifOptions = {},
): Promise<string> {
  if (!inputPath || !existsSync(inputPath)) {
    throw new Error(`待转换视频不存在: ${inputPath}`);
  }

  mkdirSync(outputDir, { recursive: true });
  const timeoutMs = resolvePositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const fps = resolvePositiveInt(options.fps, DEFAULT_FPS);
  const width = resolvePositiveInt(options.width, DEFAULT_WIDTH);
  const outputPath = join(
    outputDir,
    `video-gif-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.gif`,
  );

  const args = [
    "-y",
    "-i",
    inputPath,
    "-vf",
    `fps=${fps},scale=${width}:-1:flags=lanczos`,
    "-loop",
    "0",
    outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    let finished = false;
    let timedOut = false;

    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      if (stderr.length > 8192) return;
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
    });

    child.on("error", (err: any) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (err?.code === "ENOENT") {
        reject(new Error("ffmpeg 不可用，请确认容器内已安装 ffmpeg"));
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`视频转 GIF 超时(${timeoutMs}ms)`));
        return;
      }
      if (code === 0 && existsSync(outputPath)) {
        resolve();
        return;
      }
      const detail = stderr.trim().slice(-300);
      reject(new Error(`视频转 GIF 失败(code=${code ?? "unknown"}): ${detail || "无详细日志"}`));
    });
  });

  return outputPath;
}

