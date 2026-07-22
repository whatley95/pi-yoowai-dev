import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordIssues, getPastIssuesForFiles, clearMemory } from "./review-memory.js";
import type { ReviewIssue } from "./types.js";

describe("review-memory", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wai-test-"));

  it("records and retrieves issues for files", () => {
    const issues: ReviewIssue[] = [
      { severity: "high", file: "src/app.ts", line: 10, issue: "bug", suggestion: "fix it" },
    ];
    recordIssues(cwd, issues);
    const past = getPastIssuesForFiles(cwd, ["src/app.ts"]);
    assert.match(past, /bug/);
  });

  it("normalizes Windows paths", () => {
    const issues: ReviewIssue[] = [{ severity: "medium", file: "SRC\\App.TS", issue: "style", suggestion: "format" }];
    recordIssues(cwd, issues);
    const past = getPastIssuesForFiles(cwd, ["src/app.ts"]);
    assert.match(past, /style/);
  });

  it("clears memory", () => {
    clearMemory(cwd);
    const past = getPastIssuesForFiles(cwd, ["src/app.ts"]);
    assert.equal(past, "");
  });

  it("cleans up temp dir", () => {
    rmSync(cwd, { recursive: true, force: true });
    assert.ok(true);
  });

  it("deduplicates identical issues", () => {
    const dir = mkdtempSync(join(tmpdir(), "wai-test-dedup-"));
    try {
      const issue: ReviewIssue = { severity: "medium", file: "src/a.ts", issue: "missing type", suggestion: "add it" };
      recordIssues(dir, [issue]);
      recordIssues(dir, [issue]);
      const past = getPastIssuesForFiles(dir, ["src/a.ts"]);
      const matches = past.match(/missing type/g);
      assert.equal(matches?.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ranks issues by semantic similarity when a query is provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "wai-test-semantic-"));
    try {
      const issues: ReviewIssue[] = [
        { severity: "medium", file: "src/a.ts", issue: "variable naming unclear", suggestion: "rename" },
        { severity: "high", file: "src/a.ts", issue: "race condition in async handler", suggestion: "add lock" },
      ];
      recordIssues(dir, issues);
      const past = getPastIssuesForFiles(dir, ["src/a.ts"], "async concurrency bug");
      assert.match(past, /race condition/);
      // The top-ranked issue should be the concurrency-related one.
      assert.ok(past.indexOf("race condition") < past.indexOf("naming"), "concurrency issue should rank higher");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
