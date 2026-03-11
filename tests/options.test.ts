import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveOneBotRuntimeOptions } from "../src/options";

describe("resolveOneBotRuntimeOptions", () => {
  it("默认关闭 thinking emoji，默认开启 qqimg", () => {
    const options = resolveOneBotRuntimeOptions({ channels: { onebot: {} } });
    assert.equal(options.thinkingEmojiEnabled, false);
    assert.equal(options.qqimgTagEnabled, true);
    assert.equal(options.qqvideoTagEnabled, true);
    assert.equal(options.blockStreaming, true);
    assert.equal(options.thinkingEmojiId, 60);
    assert.equal(options.videoCacheDir, "/data/.openclaw/workspace/.onebot-video-cache");
    assert.equal(options.videoCacheMaxAgeMs, 24 * 60 * 60 * 1000);
    assert.equal(options.videoMaxBytes, 50 * 1024 * 1024);
    assert.equal(options.autoDetectVideoFromMediaUrls, true);
    assert.equal(options.videoGifTimeoutMs, 20 * 1000);
    assert.equal(options.videoGifFps, 10);
    assert.equal(options.videoGifWidth, 480);
    assert.equal(options.groupChatLogEnabled, true);
    assert.equal(options.groupChatLogDir, "/data/.openclaw/workspace/.onebot-group-chat-logs");
    assert.equal(options.groupChatLogTimeZone, "Asia/Shanghai");
    assert.equal(options.groupChatLogMaxTextLength, 2000);
    assert.equal(options.groupChatLogIncludeRawMessage, false);
    assert.equal(options.groupMentionMediaTtlMs, 5 * 60 * 1000);
    assert.equal(options.groupToolTargetPolicy, "force-current-group");
    assert.equal(options.imageFailureFallback, "upload-file");
    assert.equal(options.imageFailureFallbackNotice, false);
    assert.equal(options.videoFailureFallback, "upload-file");
    assert.equal(options.videoFailureFallbackNotice, false);
  });

  it("支持读取自定义配置", () => {
    const options = resolveOneBotRuntimeOptions({
      channels: {
        onebot: {
          thinkingEmojiEnabled: true,
          thinkingEmojiId: 123,
          qqimgTagEnabled: false,
          qqimgTagCloseVariants: ["img"],
          qqvideoTagEnabled: false,
          qqvideoTagCloseVariants: ["video"],
          blockStreaming: false,
          imageCacheDir: "/tmp/abc",
          imageCacheMaxAgeMs: 1000,
          videoCacheDir: "/tmp/video",
          videoCacheMaxAgeMs: 2000,
          videoMaxBytes: 1024,
          autoDetectVideoFromMediaUrls: false,
          videoGifTimeoutMs: 4000,
          videoGifFps: 8,
          videoGifWidth: 320,
          groupChatLogEnabled: false,
          groupChatLogDir: "/tmp/group-log",
          groupChatLogTimeZone: "UTC",
          groupChatLogMaxTextLength: 300,
          groupChatLogIncludeRawMessage: true,
          groupMentionMediaTtlMs: 5000,
          groupToolTargetPolicy: "respect-target",
          imageFailureFallback: "none",
          imageFailureFallbackNotice: true,
          videoFailureFallback: "gif",
          videoFailureFallbackNotice: true,
        },
      },
    });
    assert.equal(options.thinkingEmojiEnabled, true);
    assert.equal(options.thinkingEmojiId, 123);
    assert.equal(options.qqimgTagEnabled, false);
    assert.deepEqual(options.qqimgTagCloseVariants, ["img"]);
    assert.equal(options.qqvideoTagEnabled, false);
    assert.deepEqual(options.qqvideoTagCloseVariants, ["video"]);
    assert.equal(options.blockStreaming, false);
    assert.equal(options.imageCacheDir, "/tmp/abc");
    assert.equal(options.imageCacheMaxAgeMs, 1000);
    assert.equal(options.videoCacheDir, "/tmp/video");
    assert.equal(options.videoCacheMaxAgeMs, 2000);
    assert.equal(options.videoMaxBytes, 1024);
    assert.equal(options.autoDetectVideoFromMediaUrls, false);
    assert.equal(options.videoGifTimeoutMs, 4000);
    assert.equal(options.videoGifFps, 8);
    assert.equal(options.videoGifWidth, 320);
    assert.equal(options.groupChatLogEnabled, false);
    assert.equal(options.groupChatLogDir, "/tmp/group-log");
    assert.equal(options.groupChatLogTimeZone, "UTC");
    assert.equal(options.groupChatLogMaxTextLength, 300);
    assert.equal(options.groupChatLogIncludeRawMessage, true);
    assert.equal(options.groupMentionMediaTtlMs, 5000);
    assert.equal(options.groupToolTargetPolicy, "respect-target");
    assert.equal(options.imageFailureFallback, "none");
    assert.equal(options.imageFailureFallbackNotice, true);
    assert.equal(options.videoFailureFallback, "gif");
    assert.equal(options.videoFailureFallbackNotice, true);
  });
});
