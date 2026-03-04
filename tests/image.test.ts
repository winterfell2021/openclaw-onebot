import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveImageForNapCat } from "../src/image";

function fileUriToPath(uri: string): string {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
}

describe("resolveImageForNapCat", () => {
  it("本地文件会复制到缓存目录并返回 file:// URI", async () => {
    const root = mkdtempSync(join(tmpdir(), "onebot-image-test-"));
    const srcFile = join(root, "input.jpg");
    const cacheDir = join(root, "cache");
    writeFileSync(srcFile, Buffer.from("test-image-content"));

    try {
      const uri = await resolveImageForNapCat(srcFile, cacheDir);
      assert.ok(uri.startsWith("file://"));
      const resolvedPath = fileUriToPath(uri);
      assert.ok(existsSync(resolvedPath), "缓存文件不存在");
      assert.ok(resolvedPath.includes("/cache/"), "未写入缓存目录");
      assert.equal(readdirSync(cacheDir).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("不存在的本地路径也会转成 file:// URI", async () => {
    const root = mkdtempSync(join(tmpdir(), "onebot-image-missing-"));
    const missingPath = join(root, "missing.png");
    const cacheDir = join(root, "cache");

    try {
      const uri = await resolveImageForNapCat(missingPath, cacheDir);
      assert.equal(uri, `file://${missingPath.replace(/\\\\/g, "/")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
