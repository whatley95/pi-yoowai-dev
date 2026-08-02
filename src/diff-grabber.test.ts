import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyExclude,
  extractChangedFiles,
  splitDiffByFile,
  splitDiffByHunk,
  processDiff,
  DEFAULT_MAX_DIFF_CHARS,
  getGitDiff,
} from "./diff-grabber.js";
import { gitSpawnEnv } from "./git-env.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const hasGit = gitAvailable();

function gitOpts() {
  return { stdio: "pipe" as const, env: gitSpawnEnv() };
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, ...gitOpts() });
  execFileSync("git", ["config", "user.email", "wai-test@example.com"], { cwd: dir, ...gitOpts() });
  execFileSync("git", ["config", "user.name", "wai test"], { cwd: dir, ...gitOpts() });
}

function commitAll(dir: string): void {
  execFileSync("git", ["add", "."], { cwd: dir, ...gitOpts() });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], { cwd: dir, ...gitOpts() });
}

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

  it("parses quoted git paths with spaces", () => {
    const diff = 'diff --git "a/path with spaces.ts" "b/path with spaces.ts"\n+change';
    assert.deepEqual(extractChangedFiles(diff, "git"), ["path with spaces.ts"]);
    const byFile = splitDiffByFile(diff, "git");
    assert.ok(byFile["path with spaces.ts"]?.includes("+change"));
  });

  it("parses combined merge diff headers", () => {
    const diff = "diff --cc src/merged.ts\n+change";
    assert.deepEqual(extractChangedFiles(diff, "git"), ["src/merged.ts"]);
    const byFile = splitDiffByFile(diff, "git");
    assert.ok(byFile["src/merged.ts"]?.includes("+change"));
  });

  it("defaults to a large max diff char limit", () => {
    assert.equal(DEFAULT_MAX_DIFF_CHARS, 200_000);
  });

  it("does not truncate diffs larger than the old default", () => {
    const diff = "diff --git a/src/foo.ts b/src/foo.ts\n+" + "x".repeat(7000);
    const result = processDiff(diff, "git", DEFAULT_MAX_DIFF_CHARS);
    assert.equal(result.truncated, false);
    assert.ok(result.diff.length > 6000);
  });

  it("still truncates diffs that exceed the max char limit", () => {
    const diff = "diff --git a/src/foo.ts b/src/foo.ts\n+" + "x".repeat(300);
    const result = processDiff(diff, "git", 250);
    assert.equal(result.truncated, true);
    assert.ok(result.diff.endsWith("\n... diff truncated (too large)"));
  });

  it("does not exclude prefix-matching SVN blocks", () => {
    const diff = [
      "Index: src/a.ts",
      "===================================================================",
      "--- src/a.ts",
      "+++ src/a.ts",
      "change a",
      "Index: src/a.ts.bak",
      "===================================================================",
      "--- src/a.ts.bak",
      "+++ src/a.ts.bak",
      "change backup",
    ].join("\n");
    const filtered = applyExclude(diff, ["src/a.ts"]);
    assert.doesNotMatch(filtered, /change a/);
    assert.match(filtered, /change backup/);
  });

  it("splits a file diff by hunk", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-line2",
      "+line2a",
      " line3",
      "@@ -10,3 +10,3 @@",
      " line10",
      "-line11",
      "+line11a",
      " line12",
    ].join("\n");
    const hunks = splitDiffByHunk(diff);
    assert.equal(hunks.length, 2);
    assert.match(hunks[0], /@@ -1,3/);
    assert.match(hunks[1], /@@ -10,3/);
    assert.match(hunks[0], /line2a/);
    assert.match(hunks[1], /line11a/);
  });

  it("ignores ambient GIT_DIR/GIT_WORK_TREE redirectors from the parent environment", { skip: !hasGit }, () => {
    const root = mkdtempSync(join(tmpdir(), "wai-git-redirect-"));
    try {
      // repoA is the decoy the parent environment would redirect git into.
      const repoA = join(root, "repoA");
      mkdirSync(join(repoA, "src"), { recursive: true });
      initGitRepo(repoA);
      writeFileSync(join(repoA, "src", "a.ts"), "export const a = 1;\n", "utf-8");
      commitAll(repoA);

      // repoB is the real project under review (cwd).
      const repoB = join(root, "repoB");
      mkdirSync(join(repoB, "src"), { recursive: true });
      initGitRepo(repoB);
      writeFileSync(join(repoB, "src", "b.ts"), "export const b = 1;\n", "utf-8");
      commitAll(repoB);
      writeFileSync(join(repoB, "src", "b.ts"), "export const b = 2;\n", "utf-8"); // dirty

      // Simulate running inside a git hook of repoA.
      const savedDir = process.env.GIT_DIR;
      const savedTree = process.env.GIT_WORK_TREE;
      process.env.GIT_DIR = join(repoA, ".git");
      process.env.GIT_WORK_TREE = repoA;
      try {
        const result = getGitDiff(repoB, { maxDiffChars: 10_000 });
        assert.ok(
          result.changedFiles.includes("src/b.ts"),
          "the diff must come from cwd (repoB), not the GIT_DIR redirect target",
        );
        assert.ok(!result.changedFiles.includes("src/a.ts"), "repoA files must not leak into the diff");
        assert.ok(
          result.diff.includes("export const b = 2"),
          "the diff content must come from repoB, not the redirect target",
        );
      } finally {
        if (savedDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = savedDir;
        if (savedTree === undefined) delete process.env.GIT_WORK_TREE;
        else process.env.GIT_WORK_TREE = savedTree;
      }
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });
});
