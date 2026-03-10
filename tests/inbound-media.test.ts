import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseOneBotInboundMessage, resolveInboundMediaForPrompt } from "../src/inbound-media";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6pQn0AAAAASUVORK5CYII=";

describe("parseOneBotInboundMessage", () => {
  it("可同时解析文本与图片段", () => {
    const parsed = parseOneBotInboundMessage({
      message: [
        { type: "text", data: { text: "看图：" } },
        { type: "image", data: { url: "https://example.com/a.jpg" } },
        { type: "text", data: { text: "这是重点" } },
      ],
      raw_message: "看图：[CQ:image,file=a.jpg,url=https://example.com/a.jpg]",
    });

    assert.equal(parsed.text, "看图：这是重点");
    assert.deepEqual(parsed.imageSources, ["https://example.com/a.jpg"]);
  });

  it("存在消息段时不回退 raw_message，避免 CQ 码污染正文", () => {
    const parsed = parseOneBotInboundMessage({
      message: [{ type: "image", data: { url: "https://example.com/c.jpg" } }],
      raw_message: "[CQ:image,file=c.jpg,url=https://example.com/c.jpg]",
    });

    assert.equal(parsed.text, "");
    assert.deepEqual(parsed.imageSources, ["https://example.com/c.jpg"]);
  });

  it("消息数组缺失时可回退解析 CQ 图片段", () => {
    const parsed = parseOneBotInboundMessage({
      raw_message: "[CQ:image,file=foo.jpg,url=https://example.com/b.jpg]",
    });

    assert.equal(parsed.text, "[CQ:image,file=foo.jpg,url=https://example.com/b.jpg]");
    assert.deepEqual(parsed.imageSources, ["https://example.com/b.jpg"]);
    assert.equal(parsed.replyMessageId, undefined);
  });

  it("可解析 reply 段的消息 id", () => {
    const parsed = parseOneBotInboundMessage({
      message: [
        { type: "reply", data: { id: "123456" } },
        { type: "text", data: { text: "@机器人 看这个" } },
      ],
    });

    assert.equal(parsed.replyMessageId, 123456);
    assert.equal(parsed.text, "@机器人 看这个");
    assert.deepEqual(parsed.imageSources, []);
  });

  it("混合 text image reply 时保持兼容", () => {
    const parsed = parseOneBotInboundMessage({
      message: [
        { type: "reply", data: { message_id: 9988 } },
        { type: "text", data: { text: "这个图呢" } },
        { type: "image", data: { file: "https://example.com/d.png" } },
      ],
      raw_message: "[CQ:reply,id=9988]这个图呢[CQ:image,file=d.png,url=https://example.com/d.png]",
    });

    assert.equal(parsed.replyMessageId, 9988);
    assert.equal(parsed.text, "这个图呢");
    assert.deepEqual(parsed.imageSources, ["https://example.com/d.png"]);
  });

  it("reply 消息 id 为非数字字符串时也可保留原值", () => {
    const parsed = parseOneBotInboundMessage({
      message: [
        { type: "reply", data: { message_id: "abc-42" } },
        { type: "text", data: { text: "引用字符串 id" } },
      ],
    });

    assert.equal(parsed.replyMessageId, "abc-42");
    assert.equal(parsed.text, "引用字符串 id");
  });
});

describe("resolveInboundMediaForPrompt", () => {
  it("data-url 图片会落盘为本地可读路径", async () => {
    const root = mkdtempSync(join(tmpdir(), "onebot-inbound-media-"));
    const cacheDir = join(root, "cache");
    const dataUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;

    try {
      const resolved = await resolveInboundMediaForPrompt([dataUrl], cacheDir);
      assert.equal(resolved.paths.length, 1);
      assert.equal(resolved.urls.length, 1);
      assert.equal(resolved.types[0], "image/png");
      assert.ok(existsSync(resolved.paths[0]!), "图片未落盘");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("无效图片 source 会被忽略", async () => {
    const root = mkdtempSync(join(tmpdir(), "onebot-inbound-media-invalid-"));
    const cacheDir = join(root, "cache");

    try {
      const resolved = await resolveInboundMediaForPrompt(["abc.image-token"], cacheDir);
      assert.equal(resolved.paths.length, 0);
      assert.equal(resolved.urls.length, 0);
      assert.equal(resolved.types.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
