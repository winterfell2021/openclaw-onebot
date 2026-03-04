import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseQqimgSegments } from "../src/qqimg";

describe("parseQqimgSegments", () => {
  it("按原顺序拆分文本与图片", () => {
    const parts = parseQqimgSegments(
      "前文<qqimg>https://example.com/a.jpg</qqimg>中段<qqimg>/tmp/b.png</img>后文",
    );
    assert.deepEqual(parts, [
      { type: "text", content: "前文" },
      { type: "image", content: "https://example.com/a.jpg" },
      { type: "text", content: "中段" },
      { type: "image", content: "/tmp/b.png" },
      { type: "text", content: "后文" },
    ]);
  });

  it("无标签时保留原文本", () => {
    const parts = parseQqimgSegments("仅文本");
    assert.deepEqual(parts, [{ type: "text", content: "仅文本" }]);
  });
});
