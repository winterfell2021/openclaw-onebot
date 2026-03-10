import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GroupMentionMediaCache } from "../src/group-media-cache";

const SAMPLE_MEDIA = {
  paths: ["/tmp/a.png"],
  urls: ["https://example.com/a.png"],
  types: ["image/png"],
};

describe("GroupMentionMediaCache", () => {
  it("24 小时内可写入并一次性消费同一群同一用户的图片上下文", () => {
    const cache = new GroupMentionMediaCache(24 * 60 * 60 * 1000, 10);
    const now = 1000;

    assert.equal(cache.record(123, 456, SAMPLE_MEDIA, now), true);
    const consumed = cache.consume(123, 456, now + 7 * 60 * 1000);
    assert.deepEqual(consumed, SAMPLE_MEDIA);

    const consumedAgain = cache.consume(123, 456, now + 7 * 60 * 1000 + 1);
    assert.equal(consumedAgain, null);
  });

  it("不同用户缓存互不影响", () => {
    const cache = new GroupMentionMediaCache(24 * 60 * 60 * 1000, 10);
    const now = 2000;

    cache.record(123, 111, { ...SAMPLE_MEDIA }, now);
    cache.record(123, 222, { ...SAMPLE_MEDIA, paths: ["/tmp/b.png"] }, now);

    assert.equal(cache.consume(123, 111, now + 1)?.paths[0], "/tmp/a.png");
    assert.equal(cache.consume(123, 222, now + 1)?.paths[0], "/tmp/b.png");
  });

  it("新图会覆盖旧图", () => {
    const cache = new GroupMentionMediaCache(24 * 60 * 60 * 1000, 10);
    const now = 2500;

    cache.record(123, 456, SAMPLE_MEDIA, now);
    cache.record(
      123,
      456,
      {
        paths: ["/tmp/new.png"],
        urls: ["https://example.com/new.png"],
        types: ["image/png"],
      },
      now + 10,
    );

    assert.deepEqual(cache.consume(123, 456, now + 20), {
      paths: ["/tmp/new.png"],
      urls: ["https://example.com/new.png"],
      types: ["image/png"],
    });
  });

  it("过期后不可消费", () => {
    const cache = new GroupMentionMediaCache(24 * 60 * 60 * 1000, 10);
    const now = 3000;

    cache.record(123, 456, SAMPLE_MEDIA, now);
    assert.equal(cache.consume(123, 456, now + 24 * 60 * 60 * 1000 + 1), null);
  });
});
