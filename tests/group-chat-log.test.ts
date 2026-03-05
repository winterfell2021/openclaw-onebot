import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendGroupChatLog } from "../src/group-chat-log";

describe("appendGroupChatLog", () => {
  it("按日期与群号写入 jsonl 文件", async () => {
    const root = mkdtempSync(join(tmpdir(), "onebot-group-log-"));
    try {
      const messageTimestampMs = Date.UTC(2026, 2, 5, 3, 0, 0);
      const filePath = await appendGroupChatLog(
        {
          groupId: 615223376,
          userId: 123456789,
          selfId: 625451674,
          messageId: 1001,
          mentioned: false,
          ignoredByMention: true,
          messageTimestampMs,
          receivedTimestampMs: messageTimestampMs + 1000,
          text: "你好，记录一下风格",
          rawMessage: "[CQ:at,qq=625451674]你好，记录一下风格",
          imageSources: ["https://example.com/a.jpg"],
          resolvedMediaCount: 1,
        },
        {
          enabled: true,
          logDir: root,
          timeZone: "Asia/Shanghai",
          maxTextLength: 2000,
          includeRawMessage: true,
        },
      );
      assert.ok(filePath, "未返回日志路径");
      const content = readFileSync(filePath!, "utf-8").trim();
      assert.ok(content.length > 0, "日志内容为空");
      const row = JSON.parse(content);
      assert.equal(row.groupId, 615223376);
      assert.equal(row.userId, 123456789);
      assert.equal(row.ignoredByMention, true);
      assert.equal(row.text, "你好，记录一下风格");
      assert.equal(Array.isArray(row.imageSources), true);
      assert.equal(row.date, "2026-03-05");
      assert.equal(typeof row.rawMessage, "string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("可按配置关闭写入", async () => {
    const root = mkdtempSync(join(tmpdir(), "onebot-group-log-disabled-"));
    try {
      const filePath = await appendGroupChatLog(
        {
          groupId: 1,
          userId: 2,
          mentioned: false,
          ignoredByMention: false,
          messageTimestampMs: Date.now(),
          receivedTimestampMs: Date.now(),
          text: "abc",
          imageSources: [],
          resolvedMediaCount: 0,
        },
        {
          enabled: false,
          logDir: root,
          timeZone: "Asia/Shanghai",
          maxTextLength: 10,
          includeRawMessage: false,
        },
      );
      assert.equal(filePath, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

