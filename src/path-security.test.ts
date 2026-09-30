import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSafeRelativePath, normalizeReviewPath, resolveProjectPath, validateRevision } from "./path-security.js";

describe("path-security", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wai-path-test-"));
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

  it("normalizes review scopes using the host path semantics", () => {
    assert.equal(normalizeReviewPath("./src/nested/../file.ts"), "src/file.ts");
    assert.equal(normalizeReviewPath("./src/"), "src");
    assert.equal(normalizeReviewPath("./"), ".");
    assert.equal(normalizeReviewPath("src\\file.ts"), process.platform === "win32" ? "src/file.ts" : "src\\file.ts");
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

  it("rejects external junctions for existing files and missing descendants", () => {
    const outside = mkdtempSync(join(tmpdir(), "wai-path-outside-"));
    const link = join(cwd, "external");
    try {
      writeFileSync(join(outside, "secret.txt"), "outside marker");
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      assert.equal(resolveProjectPath(cwd, "external/secret.txt"), null);
      assert.equal(resolveProjectPath(cwd, "external/new/file.txt"), null);
    } finally {
      rmSync(link, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows internal links and a project root reached through a junction", () => {
    const internal = join(cwd, "internal");
    const aliasRoot = mkdtempSync(join(tmpdir(), "wai-path-alias-"));
    const alias = join(aliasRoot, "project");
    mkdirSync(internal);
    writeFileSync(join(internal, "ok.txt"), "inside marker");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    try {
      symlinkSync(internal, join(cwd, "internal-link"), linkType);
      symlinkSync(cwd, alias, linkType);
      assert.equal(resolveProjectPath(cwd, "internal-link/ok.txt"), join(cwd, "internal-link", "ok.txt"));
      assert.equal(resolveProjectPath(alias, "safe.txt"), join(alias, "safe.txt"));
      assert.equal(resolveProjectPath(cwd, "missing/child.txt"), join(cwd, "missing", "child.txt"));
    } finally {
      rmSync(aliasRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on broken links", () => {
    const link = join(cwd, "broken");
    symlinkSync(join(cwd, "missing-target"), link, process.platform === "win32" ? "junction" : "dir");
    assert.equal(resolveProjectPath(cwd, "broken"), null);
    assert.equal(resolveProjectPath(cwd, "broken/child.txt"), null);
  });

  it("cleans up temp dir", () => {
    rmSync(cwd, { recursive: true, force: true });
    assert.ok(true);
  });
});
