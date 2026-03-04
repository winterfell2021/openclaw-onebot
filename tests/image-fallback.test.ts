import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  normalizeFileUriToPath,
  resolveUploadFileName,
  shouldFallbackToFileUpload,
  toExistingLocalPath,
} from "../src/image-fallback";

describe("image-fallback helpers", () => {
  it("rich media 错误时触发 upload-file 兜底", () => {
    const err = new Error("OneBot action send_group_msg failed: rich media transfer failed");
    assert.equal(shouldFallbackToFileUpload(err, "upload-file"), true);
    assert.equal(shouldFallbackToFileUpload(err, "none"), false);
  });

  it("file URI 与本地路径解析正确", () => {
    const root = mkdtempSync(join(tmpdir(), "onebot-fallback-test-"));
    const img = join(root, "a.jpg");
    writeFileSync(img, Buffer.from("abc"));

    try {
      assert.equal(normalizeFileUriToPath(`file://${img}`), img);
      assert.equal(toExistingLocalPath(`file://${img}`), img);
      assert.equal(resolveUploadFileName(img), "a.jpg");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
