import { test } from "node:test";
import assert from "node:assert/strict";
import { isBinaryContent, isGeneratedFile } from "./file-policy.js";
import { isReviewableFile } from "./file-loader.js";

test("build products and IDE metadata share a platform-independent review policy", () => {
  for (const file of [
    "target/classes/App.class",
    "module\\target\\maven-status\\inputFiles.lst",
    ".idea/workspace.xml",
    "target/app.jar",
    ".svn/pristine/abc.svn-base",
    "app.pyc",
  ]) {
    assert.equal(isGeneratedFile(file), true, file);
    assert.equal(isReviewableFile(file), false, file);
  }
  for (const file of [
    "src/main/java/App.java",
    "src/target.ts",
    "docs/building.md",
    "images/logo.png",
    "lib/app.jar",
  ]) {
    assert.equal(isGeneratedFile(file), false, file);
  }
});

test("binary detection rejects null bytes and invalid UTF-8 without corrupting Unicode source", () => {
  assert.equal(isBinaryContent(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 61])), true);
  assert.equal(isBinaryContent(Buffer.from([0xff, 0xfe, 65])), true);
  assert.equal(isBinaryContent(Buffer.from("const message = '你好';\n")), false);
});
