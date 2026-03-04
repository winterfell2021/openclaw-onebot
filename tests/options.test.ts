import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveOneBotRuntimeOptions } from "../src/options";

describe("resolveOneBotRuntimeOptions", () => {
  it("默认关闭 thinking emoji，默认开启 qqimg", () => {
    const options = resolveOneBotRuntimeOptions({ channels: { onebot: {} } });
    assert.equal(options.thinkingEmojiEnabled, false);
    assert.equal(options.qqimgTagEnabled, true);
    assert.equal(options.thinkingEmojiId, 60);
  });

  it("支持读取自定义配置", () => {
    const options = resolveOneBotRuntimeOptions({
      channels: {
        onebot: {
          thinkingEmojiEnabled: true,
          thinkingEmojiId: 123,
          qqimgTagEnabled: false,
          qqimgTagCloseVariants: ["img"],
          imageCacheDir: "/tmp/abc",
        },
      },
    });
    assert.equal(options.thinkingEmojiEnabled, true);
    assert.equal(options.thinkingEmojiId, 123);
    assert.equal(options.qqimgTagEnabled, false);
    assert.deepEqual(options.qqimgTagCloseVariants, ["img"]);
    assert.equal(options.imageCacheDir, "/tmp/abc");
  });
});
