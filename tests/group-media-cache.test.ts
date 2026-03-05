import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GroupMentionMediaCache } from "../src/group-media-cache";

const SAMPLE_MEDIA = {
  paths: ["/tmp/a.png"],
  urls: ["https://example.com/a.png"],
  types: ["image/png"],
};

describe("GroupMentionMediaCache", () => {
  it("可写入并一次性消费同一群同一用户的图片上下文", () => {
    const cache = new GroupMentionMediaCache(5 * 60 * 1000, 10);
    const now = 1000;

    assert.equal(cache.record(123, 456, SAMPLE_MEDIA, now), true);
    const consumed = cache.consume(123, 456, now + 1);
    assert.deepEqual(consumed, SAMPLE_MEDIA);

    const consumedAgain = cache.consume(123, 456, now + 2);
    assert.equal(consumedAgain, null);
  });

  it("不同用户缓存互不影响", () => {
    const cache = new GroupMentionMediaCache(5 * 60 * 1000, 10);
    const now = 2000;

    cache.record(123, 111, { ...SAMPLE_MEDIA }, now);
    cache.record(123, 222, { ...SAMPLE_MEDIA, paths: ["/tmp/b.png"] }, now);

    assert.equal(cache.consume(123, 111, now + 1)?.paths[0], "/tmp/a.png");
    assert.equal(cache.consume(123, 222, now + 1)?.paths[0], "/tmp/b.png");
  });

  it("过期后不可消费", () => {
    const cache = new GroupMentionMediaCache(100, 10);
    const now = 3000;

    cache.record(123, 456, SAMPLE_MEDIA, now);
    assert.equal(cache.consume(123, 456, now + 101), null);
  });
});

