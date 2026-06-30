import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordIssues, getPastIssuesForFiles, clearMemory } from "./review-memory.js";
import type { ReviewIssue } from "./types.js";

describe("review-memory", () => {
  const cwd = mkdtempSync(join(tmpdir(), "yoo-test-"));

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
});
