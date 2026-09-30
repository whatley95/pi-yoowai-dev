import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyExclude,
  extractChangedFiles,
  splitDiffByFile,
  splitDiffByHunk,
  processDiff,
  DEFAULT_MAX_DIFF_CHARS,
  getGitDiff,
  getSvnDiff,
  getVcsInfo,
  isPiStatePath,
  listGitUntrackedFiles,
  resolveGitCommit,
  resolveEmptyTree,
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
function svnAvailable(): boolean {
  try {
    execFileSync("svn", ["--version", "--quiet"], { stdio: "pipe" });
    execFileSync("svnadmin", ["--version", "--quiet"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const hasSvn = svnAvailable();

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
  it("recognizes only the project-root Pi state directory", () => {
    assert.equal(isPiStatePath(".pi/yoowai/log.txt"), true);
    assert.equal(isPiStatePath(".\\.pi\\yoowai\\log.txt"), true);
    assert.equal(isPiStatePath(".pi"), true);
    assert.equal(isPiStatePath(".piano/file.txt"), false);
    assert.equal(isPiStatePath("src/.pi/file.txt"), false);
  });

  it("excludes tracked and untracked Pi state from Git diffs and dirty status", { skip: !hasGit }, () => {
    const cwd = mkdtempSync(join(tmpdir(), "wai-pi-state-git-"));
    try {
      initGitRepo(cwd);
      mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
      writeFileSync(join(cwd, "app.txt"), "before\n");
      writeFileSync(join(cwd, ".pi", "yoowai", "state.log"), "before\n");
      commitAll(cwd);

      writeFileSync(join(cwd, ".pi", "yoowai", "state.log"), "STATE_MARKER\n" + "x".repeat(10_000));
      writeFileSync(join(cwd, ".pi", "yoowai", "extra.log"), "EXTRA_MARKER\n" + "x".repeat(10_000));
      assert.equal(getVcsInfo(cwd).dirty, false);
      assert.deepEqual(listGitUntrackedFiles(cwd), []);

      writeFileSync(join(cwd, "app.txt"), "APP_MARKER\n");
      const working = getGitDiff(cwd, { untracked: true, maxDiffChars: 500 });
      const ranged = getGitDiff(cwd, { revision: "HEAD", untracked: true, maxDiffChars: 500 });
      for (const result of [working, ranged]) {
        assert.equal(result.truncated, false);
        assert.deepEqual(result.changedFiles, ["app.txt"]);
        assert.match(result.diff, /APP_MARKER/);
        assert.doesNotMatch(result.diff, /STATE_MARKER|EXTRA_MARKER|\.pi\//);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("excludes Pi state before SVN diff assembly and truncation", { skip: !hasSvn }, () => {
    const root = mkdtempSync(join(tmpdir(), "wai-pi-state-svn-"));
    const repository = join(root, "repository");
    const cwd = join(root, "checkout");
    try {
      execFileSync("svnadmin", ["create", repository], { stdio: "pipe" });
      execFileSync("svn", ["checkout", pathToFileURL(repository).href, cwd], { stdio: "pipe" });
      mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
      writeFileSync(join(cwd, "app.txt"), "before\n");
      writeFileSync(join(cwd, ".pi", "yoowai", "state.log"), "before\n");
      execFileSync("svn", ["add", "app.txt", ".pi"], { cwd, stdio: "pipe" });
      execFileSync("svn", ["commit", "-m", "base"], { cwd, stdio: "pipe" });

      writeFileSync(join(cwd, "app.txt"), "APP_MARKER\n");
      writeFileSync(join(cwd, ".pi", "yoowai", "state.log"), "STATE_MARKER\n" + "x".repeat(10_000));
      writeFileSync(join(cwd, ".pi", "yoowai", "extra.log"), "EXTRA_MARKER\n" + "x".repeat(10_000));
      const result = getSvnDiff(cwd, { untracked: true, maxDiffChars: 500 });
      assert.equal(result.truncated, false);
      assert.deepEqual(result.changedFiles, ["app.txt"]);
      assert.match(result.diff, /APP_MARKER/);
      assert.doesNotMatch(result.diff, /STATE_MARKER|EXTRA_MARKER|\.pi\//);
      const unsafe = getSvnDiff(cwd, { files: ["app.txt", join(root, "outside.txt")] });
      assert.deepEqual(unsafe.changedFiles, []);
      assert.match(unsafe.unavailableReason ?? "", /outside the current project/);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("captures scoped SVN additions and unversioned descendants without noise", { skip: !hasSvn }, () => {
    const root = mkdtempSync(join(tmpdir(), "wai-scoped-svn-"));
    const repository = join(root, "repository");
    const cwd = join(root, "checkout");
    try {
      execFileSync("svnadmin", ["create", repository], { stdio: "pipe" });
      execFileSync("svn", ["checkout", pathToFileURL(repository).href, cwd], { stdio: "pipe" });
      mkdirSync(join(cwd, "src"));
      writeFileSync(join(cwd, "src", "tracked.ts"), "before\n");
      execFileSync("svn", ["add", "src"], { cwd, stdio: "pipe" });
      execFileSync("svn", ["commit", "-m", "base"], { cwd, stdio: "pipe" });
      writeFileSync(join(cwd, "src", "tracked.ts"), "TRACKED_MARKER\n");
      writeFileSync(join(cwd, "src", "added.ts"), "ADDED_MARKER\n");
      execFileSync("svn", ["add", "src/added.ts"], { cwd, stdio: "pipe" });
      mkdirSync(join(cwd, "src", "new"));
      const requested = ["src/tracked.ts", "src/added.ts"];
      for (let i = 0; i < 5; i++) {
        const file = `src/new/file${i}.ts`;
        requested.push(file);
        writeFileSync(join(cwd, file), `NEW_MARKER_${i}\n`);
      }
      mkdirSync(join(cwd, "noise"));
      for (let i = 0; i < 225; i++) writeFileSync(join(cwd, "noise", `${i}.txt`), "NOISE_MARKER\n");

      const result = getSvnDiff(cwd, { files: requested, untracked: true });
      assert.equal(result.unavailableReason, undefined);
      assert.deepEqual([...result.changedFiles].sort(), [...requested].sort());
      assert.match(result.diff, /TRACKED_MARKER/);
      assert.match(result.diff, /ADDED_MARKER/);
      for (let i = 0; i < 5; i++) assert.match(result.diff, new RegExp(`NEW_MARKER_${i}`));
      assert.doesNotMatch(result.diff, /NOISE_MARKER/);

      const directory = getSvnDiff(cwd, { files: ["./src/"], exclude: ["./src/new/"], untracked: true });
      assert.deepEqual([...directory.changedFiles].sort(), ["src/added.ts", "src/tracked.ts"]);
      assert.doesNotMatch(directory.diff, /NEW_MARKER|NOISE_MARKER/);
      execFileSync("svn", ["add", "src/new"], { cwd, stdio: "pipe" });
      const scheduled = getSvnDiff(cwd, { files: ["src/new/"], exclude: ["src/new/file4.ts"], untracked: true });
      assert.deepEqual([...scheduled.changedFiles].sort(), requested.slice(2, -1).sort());
      for (let i = 0; i < 4; i++) {
        assert.equal(scheduled.diff.split(`NEW_MARKER_${i}`).length - 1, 1, "each addition must appear once");
      }
      assert.doesNotMatch(scheduled.diff, /NEW_MARKER_4|NOISE_MARKER/);
      if (process.platform === "win32") {
        const windows = getSvnDiff(cwd, {
          files: requested.map((file) => file.replaceAll("/", "\\")),
          untracked: true,
        });
        assert.deepEqual([...windows.changedFiles].sort(), [...requested].sort());
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("normalizes SVN header paths for extraction and splitting", () => {
    const path = process.platform === "win32" ? ".\\src\\new\\file.ts" : "./src/new/file.ts";
    const diff = `Index: ${path}\n===================================================================\n+content`;
    assert.deepEqual(extractChangedFiles(diff, "svn"), ["src/new/file.ts"]);
    assert.deepEqual(Object.keys(splitDiffByFile(diff, "svn")), ["src/new/file.ts"]);
    assert.equal(applyExclude(diff, ["./src/new/"]), "");
  });

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

  it("resolveGitCommit peels revisions to commit SHAs and rejects non-commits", { skip: !hasGit }, () => {
    const cwd = mkdtempSync(join(tmpdir(), "wai-dg-resolve-"));
    try {
      execFileSync("git", ["init"], { cwd, ...gitOpts() });
      execFileSync("git", ["config", "user.email", "t@t.co"], { cwd, ...gitOpts() });
      execFileSync("git", ["config", "user.name", "t"], { cwd, ...gitOpts() });
      writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
      execFileSync("git", ["add", "."], { cwd, ...gitOpts() });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], { cwd, ...gitOpts() });
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, ...gitOpts() })
        .toString()
        .trim();
      const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd, ...gitOpts() })
        .toString()
        .trim();

      // Relative and absolute commit revisions resolve; the tree does not.
      assert.equal(resolveGitCommit(cwd, "HEAD"), commit);
      assert.equal(resolveGitCommit(cwd, "HEAD~0"), commit);
      assert.equal(resolveGitCommit(cwd, tree), undefined, "a tree SHA must not resolve as a commit");
      assert.equal(resolveGitCommit(cwd, "nope"), undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resolveEmptyTree materializes the empty-tree SHA usable as a diff base", { skip: !hasGit }, () => {
    const cwd = mkdtempSync(join(tmpdir(), "wai-dg-empty-"));
    try {
      execFileSync("git", ["init"], { cwd, ...gitOpts() });
      const empty = resolveEmptyTree(cwd);
      assert.ok(empty, "the empty tree must resolve");
      // The object must exist (hash-object -w) and be diffable.
      execFileSync("git", ["cat-file", "-e", `${empty}^{tree}`], { cwd, ...gitOpts() });
      writeFileSync(join(cwd, "a.ts"), "export const rootMarker = 1;\n");
      execFileSync("git", ["add", "."], { cwd, ...gitOpts() });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "root"], { cwd, ...gitOpts() });
      const diff = execFileSync("git", ["diff", `${empty}..HEAD`], { cwd, ...gitOpts() }).toString();
      assert.ok(diff.includes("rootMarker"), "the root commit must be diffable against the empty tree");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
