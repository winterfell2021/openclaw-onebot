import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GroupSharedContextStore } from "../src/group-shared-context";

describe("GroupSharedContextStore", () => {
  it("乱序完成时仍按 arrivalSeq 顺序提交", () => {
    const store = new GroupSharedContextStore("", 10);

    const first = store.beginTurn({
      groupId: 1001,
      executionKey: "run-a",
      senderLabel: "Alice（1）",
      userId: 1,
      messageId: "msg-a",
      timestamp: 1000,
      text: "第一个问题",
    });
    const second = store.beginTurn({
      groupId: 1001,
      executionKey: "run-b",
      senderLabel: "Bob（2）",
      userId: 2,
      messageId: "msg-b",
      timestamp: 1001,
      text: "第二个问题",
    });

    assert.equal(first.arrivalSeq, 1);
    assert.equal(second.arrivalSeq, 2);
    assert.equal(store.completeTurn({ groupId: 1001, executionKey: "run-b", assistantText: "回答 B" }).length, 0);

    const committed = store.completeTurn({ groupId: 1001, executionKey: "run-a", assistantText: "回答 A" });
    assert.equal(committed.length, 2);
    assert.equal(committed[0]?.senderLabel, "Alice（1）");
    assert.equal(committed[0]?.assistantText, "回答 A");
    assert.equal(committed[1]?.senderLabel, "Bob（2）");
    assert.equal(committed[1]?.assistantText, "回答 B");
  });

  it("更早到达的处理中摘要与当前消息都带强发送者标签", () => {
    const store = new GroupSharedContextStore("", 10);

    store.beginTurn({
      groupId: 2002,
      executionKey: "run-a",
      senderLabel: "纯田真奈（1453427037）",
      userId: 1,
      messageId: "msg-a",
      timestamp: 2000,
      text: "第一个问题很长，需要处理中",
    });
    const second = store.beginTurn({
      groupId: 2002,
      executionKey: "run-b",
      senderLabel: "反田叶月（365674704）",
      userId: 2,
      messageId: "msg-b",
      timestamp: 2001,
      text: "第二个问题",
    });

    assert.match(second.promptContext, /更早到达但仍在处理的消息摘要/);
    assert.match(second.promptContext, /发送者：纯田真奈（1453427037）；消息：第一个问题很长，需要处理中/);
    assert.match(second.promptContext, /【当前处理消息】/);
    assert.match(second.promptContext, /发送者：反田叶月（365674704）/);
    assert.match(second.promptContext, /消息：第二个问题/);
  });

  it("引用消息会进入 prompt 片段", () => {
    const store = new GroupSharedContextStore("", 10);

    const result = store.beginTurn({
      groupId: 3003,
      executionKey: "run-a",
      senderLabel: "Alice（1）",
      userId: 1,
      messageId: "msg-a",
      timestamp: 3000,
      text: "你怎么看",
      replyText: "上一条提到需要先查日志",
    });

    assert.match(result.currentText, /引用消息：上一条提到需要先查日志/);
    assert.match(result.currentText, /消息：你怎么看/);
    assert.match(result.promptContext, /引用消息：上一条提到需要先查日志/);
    assert.match(result.promptContext, /发送者：Alice（1）/);
  });

  it("已提交历史包含强发送者标签与助手回复标签", () => {
    const store = new GroupSharedContextStore("", 10);

    store.beginTurn({
      groupId: 3503,
      executionKey: "run-a",
      senderLabel: "纯田真奈（1453427037）",
      userId: 1453427037,
      messageId: "msg-a",
      timestamp: 3500,
      text: "先记录一下",
    });
    store.completeTurn({
      groupId: 3503,
      executionKey: "run-a",
      assistantText: "已经记住了",
    });

    const next = store.beginTurn({
      groupId: 3503,
      executionKey: "run-b",
      senderLabel: "反田叶月（365674704）",
      userId: 365674704,
      messageId: "msg-b",
      timestamp: 3501,
      text: "继续这个话题",
    });

    assert.match(next.promptContext, /已提交的群共享历史/);
    assert.match(next.promptContext, /【历史 1】/);
    assert.match(next.promptContext, /发送者：纯田真奈（1453427037）/);
    assert.match(next.promptContext, /消息：先记录一下/);
    assert.match(next.promptContext, /助手回复：已经记住了/);
    assert.match(next.promptContext, /【当前处理消息】/);
    assert.match(next.promptContext, /发送者：反田叶月（365674704）/);
    assert.match(next.promptContext, /消息：继续这个话题/);
  });

  it("可持久化并恢复已提交历史", () => {
    const persistDir = mkdtempSync(join(tmpdir(), "onebot-group-context-"));
    try {
      const store = new GroupSharedContextStore(persistDir, 10);
      store.beginTurn({
        groupId: 4004,
        executionKey: "run-a",
        senderLabel: "Alice（1）",
        userId: 1,
        messageId: "msg-a",
        timestamp: 4000,
        text: "先记录一下",
      });
      store.completeTurn({
        groupId: 4004,
        executionKey: "run-a",
        assistantText: "已经记住了",
      });

      const filePath = join(persistDir, "group-4004.json");
      assert.ok(existsSync(filePath), "群共享上下文未落盘");

      const reloaded = new GroupSharedContextStore(persistDir, 10);
      const snapshot = reloaded.getSnapshot(4004);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.turns[0]?.assistantText, "已经记住了");

      const next = reloaded.beginTurn({
        groupId: 4004,
        executionKey: "run-b",
        senderLabel: "Bob（2）",
        userId: 2,
        messageId: "msg-b",
        timestamp: 4001,
        text: "继续这个话题",
      });
      assert.match(next.promptContext, /已提交的群共享历史/);
      assert.match(next.promptContext, /发送者：Alice（1）/);
      assert.match(next.promptContext, /已经记住了/);
    } finally {
      rmSync(persistDir, { recursive: true, force: true });
    }
  });

  it("回退到纯 QQ 号时格式稳定", () => {
    const store = new GroupSharedContextStore("", 10);

    const result = store.beginTurn({
      groupId: 4504,
      executionKey: "run-a",
      senderLabel: "1453427037",
      userId: 1453427037,
      messageId: "msg-a",
      timestamp: 4500,
      text: "只有 QQ 号",
    });

    assert.match(result.promptContext, /【当前处理消息】/);
    assert.match(result.promptContext, /发送者：1453427037/);
    assert.match(result.promptContext, /消息：只有 QQ 号/);
  });

  it("可清理群上下文与持久化文件", () => {
    const persistDir = mkdtempSync(join(tmpdir(), "onebot-group-context-clear-"));
    try {
      const store = new GroupSharedContextStore(persistDir, 10);
      store.beginTurn({
        groupId: 5005,
        executionKey: "run-a",
        senderLabel: "Alice（1）",
        userId: 1,
        messageId: "msg-a",
        timestamp: 5000,
        text: "准备清理",
      });
      store.completeTurn({
        groupId: 5005,
        executionKey: "run-a",
        assistantText: "好",
      });

      const filePath = join(persistDir, "group-5005.json");
      assert.ok(existsSync(filePath), "预期持久化文件存在");

      store.clearGroup(5005, { removePersisted: true });
      assert.equal(store.getSnapshot(5005).turns.length, 0);
      assert.equal(existsSync(filePath), false);
    } finally {
      rmSync(persistDir, { recursive: true, force: true });
    }
  });
});
