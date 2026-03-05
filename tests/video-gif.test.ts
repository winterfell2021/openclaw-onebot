import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convertVideoToGif } from "../src/video-gif";

describe("convertVideoToGif", () => {
  it("输入文件不存在时应报错", async () => {
    await assert.rejects(
      () => convertVideoToGif("/tmp/not-exists-video.mp4", "/tmp"),
      /待转换视频不存在/,
    );
  });
});

