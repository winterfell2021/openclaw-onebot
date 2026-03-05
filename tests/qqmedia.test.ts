import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseQqMediaSegments } from "../src/qqmedia";

describe("parseQqMediaSegments", () => {
  it("按顺序解析文本、图片和视频标签", () => {
    const parts = parseQqMediaSegments(
      "前文<qqimg>https://example.com/a.jpg</qqimg>中段<qqvideo>https://example.com/v.mp4</video>后文",
    );
    assert.deepEqual(parts, [
      { type: "text", content: "前文" },
      { type: "image", content: "https://example.com/a.jpg" },
      { type: "text", content: "中段" },
      { type: "video", content: "https://example.com/v.mp4" },
      { type: "text", content: "后文" },
    ]);
  });

  it("无标签时保留原文本", () => {
    const parts = parseQqMediaSegments("仅文本");
    assert.deepEqual(parts, [{ type: "text", content: "仅文本" }]);
  });

  it("支持自定义结束标签白名单", () => {
    const parts = parseQqMediaSegments(
      "A<qqvideo>/tmp/1.mov</movie>B<qqimg>/tmp/2.png</pic>C",
      { imageCloseVariants: ["pic"], videoCloseVariants: ["movie"] },
    );
    assert.deepEqual(parts, [
      { type: "text", content: "A" },
      { type: "video", content: "/tmp/1.mov" },
      { type: "text", content: "B" },
      { type: "image", content: "/tmp/2.png" },
      { type: "text", content: "C" },
    ]);
  });
});

