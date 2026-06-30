import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSafeRelativePath, resolveProjectPath, validateRevision } from "./path-security.js";

describe("path-security", () => {
  const cwd = mkdtempSync(join(tmpdir(), "yoo-path-test-"));
  writeFileSync(join(cwd, "safe.txt"), "ok");

  it("rejects absolute paths", () => {
    assert.equal(isSafeRelativePath("/etc/passwd"), false);
  });

  it("rejects parent traversal", () => {
    assert.equal(isSafeRelativePath("../secret.txt"), false);
    assert.equal(isSafeRelativePath("src/../../secret.txt"), false);
  });

  it("accepts safe relative paths", () => {
    assert.equal(isSafeRelativePath("src/index.ts"), true);
    assert.equal(isSafeRelativePath("safe.txt"), true);
  });

  it("resolves only safe project paths", () => {
    assert.equal(resolveProjectPath(cwd, "safe.txt"), join(cwd, "safe.txt"));
    assert.equal(resolveProjectPath(cwd, "../outside.txt"), null);
  });

  it("validates revisions conservatively", () => {
    assert.equal(validateRevision("HEAD~1"), "HEAD~1");
    assert.equal(validateRevision("abc123"), "abc123");
    assert.equal(validateRevision("origin/main"), "origin/main");
    assert.equal(validateRevision("../.."), undefined);
    assert.equal(validateRevision("-flag"), undefined);
  });

  it("cleans up temp dir", () => {
    rmSync(cwd, { recursive: true, force: true });
    assert.ok(true);
  });
});
