import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveImageForNapCat } from "../src/image";

function fileUriToPath(uri: string): string {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6pQn0AAAAASUVORK5CYII=";

describe("resolveImageForNapCat", () => {
  it("本地文件会复制到缓存目录并返回 file:// URI", async () => {
    const root = mkdtempSync(join(tmpdir(), "onebot-image-test-"));
    const srcFile = join(root, "input.jpg");
    const cacheDir = join(root, "cache");
    writeFileSync(srcFile, Buffer.from(TINY_PNG_BASE64, "base64"));

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

  it("本地文件不是有效图片时应报错", async () => {
    const root = mkdtempSync(join(tmpdir(), "onebot-image-invalid-"));
    const srcFile = join(root, "broken.jpg");
    const cacheDir = join(root, "cache");
    writeFileSync(srcFile, Buffer.from("x"));

    try {
      await assert.rejects(
        () => resolveImageForNapCat(srcFile, cacheDir),
        /图片格式无效或损坏/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
