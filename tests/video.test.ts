import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveVideoForNapCat } from "../src/video";

function fileUriToPath(uri: string): string {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
}

function tinyMp4Buffer(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
}

describe("resolveVideoForNapCat", () => {
  it("本地视频会复制到缓存目录并返回 file:// URI", async () => {
    const root = mkdtempSync(join(tmpdir(), "onebot-video-test-"));
    const srcFile = join(root, "input.mp4");
    const cacheDir = join(root, "cache");
    writeFileSync(srcFile, tinyMp4Buffer());

    try {
      const uri = await resolveVideoForNapCat(srcFile, cacheDir);
      assert.ok(uri.startsWith("file://"));
      const resolvedPath = fileUriToPath(uri);
      assert.ok(existsSync(resolvedPath), "缓存文件不存在");
      assert.ok(resolvedPath.includes("/cache/"), "未写入缓存目录");
      assert.equal(readdirSync(cacheDir).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("不存在的本地路径会转成 file:// URI", async () => {
    const root = mkdtempSync(join(tmpdir(), "onebot-video-missing-"));
    const missingPath = join(root, "missing.mp4");
    const cacheDir = join(root, "cache");

    try {
      const uri = await resolveVideoForNapCat(missingPath, cacheDir);
      assert.equal(uri, `file://${missingPath.replace(/\\\\/g, "/")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("超过大小限制时应报错", async () => {
    const root = mkdtempSync(join(tmpdir(), "onebot-video-limit-"));
    const srcFile = join(root, "large.mp4");
    const cacheDir = join(root, "cache");
    writeFileSync(srcFile, Buffer.alloc(1024));

    try {
      await assert.rejects(
        () => resolveVideoForNapCat(srcFile, cacheDir, { maxBytes: 100 }),
        /视频超过大小限制/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

