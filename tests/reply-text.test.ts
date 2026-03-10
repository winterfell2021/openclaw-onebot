import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeBufferedReplyText } from "../src/reply-text";

describe("mergeBufferedReplyText", () => {
  it("保留回复中的换行", () => {
    const merged = mergeBufferedReplyText("第一行\n第二", "第一行\n第二行\n第三行");
    assert.equal(merged, "第一行\n第二行\n第三行");
  });

  it("可拼接增量文本且不额外插入空格", () => {
    const merged = mergeBufferedReplyText("第一段", "\n第二段");
    assert.equal(merged, "第一段\n第二段");
  });

  it("可去重重叠前缀", () => {
    const merged = mergeBufferedReplyText("你好，世", "世界");
    assert.equal(merged, "你好，世界");
  });
});
