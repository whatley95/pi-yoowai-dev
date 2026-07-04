import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyExclude, extractChangedFiles, splitDiffByFile } from "./diff-grabber.js";

describe("diff-grabber helpers", () => {
  it("excludes matching SVN blocks", () => {
    const diff = [
      "Index: src/a.ts",
      "===================================================================",
      "--- src/a.ts",
      "+++ src/a.ts",
      "change a",
      "Index: src/b.ts",
      "===================================================================",
      "--- src/b.ts",
      "+++ src/b.ts",
      "change b",
    ].join("\n");
    const filtered = applyExclude(diff, ["src/a.ts"]);
    assert.match(filtered, /src\/b\.ts/);
    assert.doesNotMatch(filtered, /change a/);
  });

  it("extracts git changed files", () => {
    const diff = "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts";
    const files = extractChangedFiles(diff, "git");
    assert.deepEqual(files, ["src/foo.ts"]);
  });

  it("extracts svn changed files", () => {
    const diff = "Index: src/bar.ts\n===================================================================\nchange";
    const files = extractChangedFiles(diff, "svn");
    assert.deepEqual(files, ["src/bar.ts"]);
  });

  it("splits git diff by file", () => {
    const diff = ["diff --git a/src/a.ts b/src/a.ts", "change a", "diff --git a/src/b.ts b/src/b.ts", "change b"].join(
      "\n",
    );
    const byFile = splitDiffByFile(diff, "git");
    assert.ok(byFile["src/a.ts"]?.includes("change a"));
    assert.ok(byFile["src/b.ts"]?.includes("change b"));
    assert.ok(!byFile["src/a.ts"]?.includes("change b"));
  });

  it("splits svn diff by file", () => {
    const diff = [
      "Index: src/a.ts",
      "===================================================================",
      "change a",
      "Index: src/b.ts",
      "===================================================================",
      "change b",
    ].join("\n");
    const byFile = splitDiffByFile(diff, "svn");
    assert.ok(byFile["src/a.ts"]?.includes("change a"));
    assert.ok(byFile["src/b.ts"]?.includes("change b"));
  });

  it("returns empty record for empty diff", () => {
    const byFile = splitDiffByFile("", "git");
    assert.deepEqual(Object.keys(byFile), []);
  });
});
