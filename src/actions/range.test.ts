import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getVcsInfo, resolveGitCommit, resolveEmptyTree } from "../diff-grabber.js";
import { gitSpawnEnv } from "../git-env.js";
import { resolveRangeBase, updateRangeState, pinAttemptedRange, rebuiltDiff } from "./range.js";
import {
  getLastReviewedCommit,
  getPendingReviewCommit,
  setLastReviewedCommit,
  setPendingReviewCommit,
} from "../session-state.js";

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

interface Repo {
  cwd: string;
  revParse: (rev: string) => string;
  commit: (files: Record<string, string>) => void;
}

function makeRepo(): Repo {
  const cwd = mkdtempSync(join(tmpdir(), "wai-range-"));
  execFileSync("git", ["init"], { cwd, ...gitOpts() });
  execFileSync("git", ["config", "user.email", "t@t.co"], { cwd, ...gitOpts() });
  execFileSync("git", ["config", "user.name", "t"], { cwd, ...gitOpts() });
  writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
  const repo: Repo = {
    cwd,
    revParse: (rev: string) =>
      execFileSync("git", ["rev-parse", rev], { cwd, ...gitOpts() })
        .toString()
        .trim(),
    commit: (files: Record<string, string>) => {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(cwd, name), content);
      }
      execFileSync("git", ["add", "."], { cwd, ...gitOpts() });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "wip"], { cwd, ...gitOpts() });
    },
  };
  return repo;
}

const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("resolveRangeBase", () => {
  it("fresh clean tree without anchors falls back to HEAD~1 (absolute)", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "v1\n" });
    repo.commit({ "a.txt": "v2\n" });
    const vcs = getVcsInfo(repo.cwd);
    assert.equal(vcs.dirty, false);
    const range = resolveRangeBase(repo.cwd, "incremental", vcs, undefined, undefined, {});
    assert.equal(range.since, repo.revParse("HEAD~1"));
  });

  it("root commit falls back to the empty tree", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "v1\n" });
    const vcs = getVcsInfo(repo.cwd);
    const range = resolveRangeBase(repo.cwd, "incremental", vcs, undefined, undefined, {});
    assert.equal(range.since, resolveEmptyTree(repo.cwd));
  });

  it("incremental prefers the pending anchor over the accepted baseline", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "v1\n" }); // C0
    repo.commit({ "a.txt": "v2\n" }); // C1 — accepted baseline
    const baseline = repo.revParse("HEAD");
    repo.commit({ "b.txt": "x\n" }); // C2 — failed round (pending pinned at baseline)
    const vcs = getVcsInfo(repo.cwd);
    setLastReviewedCommit(repo.cwd, baseline);
    setPendingReviewCommit(repo.cwd, baseline);
    // Incremental: pending (== baseline here) wins; both point at C1.
    assert.equal(resolveRangeBase(repo.cwd, "incremental", vcs, baseline, baseline, {}).since, baseline);
  });

  it("holistic prefers the accepted baseline over the pending anchor", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "v1\n" });
    repo.commit({ "a.txt": "v2\n" }); // C1 — accepted baseline
    const baseline = repo.revParse("HEAD");
    repo.commit({ "b.txt": "x\n" }); // C2
    const vcs = getVcsInfo(repo.cwd);
    // Diverged state (restart edge): pending points at an OLDER commit than
    // the baseline. Holistic must pick the baseline.
    setLastReviewedCommit(repo.cwd, baseline);
    setPendingReviewCommit(repo.cwd, repo.revParse("HEAD~1"));
    assert.equal(resolveRangeBase(repo.cwd, "holistic", vcs, baseline, repo.revParse("HEAD~1"), {}).since, baseline);
  });

  it("dirty trees diff against the best base, not bare HEAD", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "v1\n" }); // C0
    repo.commit({ "a.txt": "v2\n" }); // C1
    const baseline = repo.revParse("HEAD");
    writeFileSync(join(repo.cwd, "a.txt"), "wip\n"); // dirty
    const vcs = getVcsInfo(repo.cwd);
    assert.equal(vcs.dirty, true);
    assert.equal(resolveRangeBase(repo.cwd, "incremental", vcs, baseline, undefined, {}).revision, baseline);
    // Without any anchor: HEAD.
    assert.equal(
      resolveRangeBase(repo.cwd, "incremental", vcs, undefined, undefined, {}).revision,
      repo.revParse("HEAD"),
    );
  });

  it("invalid persisted anchors are ignored", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "v1\n" });
    repo.commit({ "a.txt": "v2\n" });
    const vcs = getVcsInfo(repo.cwd);
    const range = resolveRangeBase(repo.cwd, "incremental", vcs, "not-a-sha", "deadbeefdeadbeef", {});
    assert.equal(range.since, repo.revParse("HEAD~1"));
  });

  it("explicit svn override disables all git range behavior", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "v1\n" });
    repo.commit({ "a.txt": "v2\n" });
    const vcs = getVcsInfo(repo.cwd);
    const range = resolveRangeBase(repo.cwd, "incremental", vcs, repo.revParse("HEAD"), undefined, { vcs: "svn" });
    assert.equal(range.since, undefined);
    assert.equal(range.revision, "HEAD");
  });

  it("explicit user ranges are kept and absolutized", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "v1\n" });
    repo.commit({ "a.txt": "v2\n" });
    const vcs = getVcsInfo(repo.cwd);
    const range = resolveRangeBase(repo.cwd, "incremental", vcs, undefined, undefined, { since: "HEAD~1" });
    assert.equal(range.since, repo.revParse("HEAD~1"));
    assert.equal(resolveGitCommit(repo.cwd, range.since!), range.since);
  });
});

describe("rebuiltDiff", () => {
  it("concatenates per-file diffs in changedFiles order and detects per-file truncation", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "a1\n", "b.txt": "b1\n" });
    repo.commit({ "a.txt": "A_MARKER\n", "b.txt": "B_MARKER\n" });
    const result = rebuiltDiff(repo.cwd, { maxDiffChars: 200000, since: "HEAD~1" }, ["a.txt", "b.txt"]);
    assert.ok(result.diff.includes("A_MARKER"), "a.txt's diff must be included");
    assert.ok(result.diff.includes("B_MARKER"), "b.txt's diff must be included");
    assert.ok(
      result.diff.indexOf("A_MARKER") < result.diff.indexOf("B_MARKER"),
      "changedFiles order must be preserved",
    );
    assert.equal(result.perFileTruncated, false);
  });

  it("omits missing files and reports them in the omitted list", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "a1\n" });
    repo.commit({ "a.txt": "A_MARKER\n" });
    const result = rebuiltDiff(repo.cwd, { maxDiffChars: 200000, since: "HEAD~1" }, ["a.txt", "missing.txt"]);
    assert.ok(result.diff.includes("A_MARKER"));
    assert.ok(!result.diff.includes("missing.txt"), "a failed refetch must be omitted");
    assert.equal(result.perFileTruncated, false);
    assert.deepEqual(result.omitted, ["missing.txt"], "omitted files must be reported");
  });

  it(
    "a capped multi-file rebuild includes a never-committed (untracked) file when untracked:true is passed",
    { skip: !hasGit },
    () => {
      const repo = makeRepo();
      tmpDirs.push(repo.cwd);
      repo.commit({ "a.txt": "a1\n", "b.txt": "b1\n", "c.txt": "c1\n" });
      // Enough tracked content to exceed the low cap on the combined diff, so
      // this is a REAL capped rebuild, plus a never-committed file.
      const filler = "y".repeat(700);
      repo.commit({
        "a.txt": `TRACKED_A\n${filler}\n`,
        "b.txt": `TRACKED_B\n${filler}\n`,
        "c.txt": `TRACKED_C\n${filler}\n`,
      });
      writeFileSync(join(repo.cwd, "newfile.ts"), "UNTRACKED_MARKER\n");
      const result = rebuiltDiff(repo.cwd, { maxDiffChars: 2000, since: "HEAD~1", untracked: true }, [
        "a.txt",
        "b.txt",
        "c.txt",
        "newfile.ts",
      ]);
      assert.ok(result.diff.includes("newfile.ts"), "the untracked file's PATH must be in the rebuilt diff");
      assert.ok(result.diff.includes("UNTRACKED_MARKER"), "the untracked file's content must be included");
      assert.ok(
        result.diff.includes("TRACKED_A") && result.diff.includes("TRACKED_B") && result.diff.includes("TRACKED_C"),
        "all tracked files must be in the rebuilt diff",
      );
      // Without untracked:true, the never-committed file is not part of the diff.
      const withoutUntracked = rebuiltDiff(repo.cwd, { maxDiffChars: 2000, since: "HEAD~1" }, [
        "a.txt",
        "b.txt",
        "c.txt",
        "newfile.ts",
      ]);
      assert.ok(!withoutUntracked.diff.includes("UNTRACKED_MARKER"));
    },
  );

  it("reports perFileTruncated when an individual file's diff is capped", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "a1\n" });
    const filler = "y".repeat(4000);
    repo.commit({ "a.txt": `A_HEAD\n${filler}\nA_TAIL\n` });
    const result = rebuiltDiff(repo.cwd, { maxDiffChars: 1000, since: "HEAD~1" }, ["a.txt"]);
    assert.equal(result.perFileTruncated, true, "a per-file cap must be reported");
  });
});

describe("updateRangeState / pinAttemptedRange", () => {
  it("pass advances the baseline and clears the pending anchor", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "v1\n" });
    repo.commit({ "a.txt": "v2\n" });
    const vcs = getVcsInfo(repo.cwd);
    setPendingReviewCommit(repo.cwd, repo.revParse("HEAD~1"));
    updateRangeState(repo.cwd, vcs, { since: repo.revParse("HEAD~1") }, { verdict: "pass" });
    assert.equal(getLastReviewedCommit(repo.cwd), vcs.revision);
    assert.equal(getPendingReviewCommit(repo.cwd), undefined);
  });

  it("non-pass pins the pending anchor at the resolved range start", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "v1\n" });
    repo.commit({ "a.txt": "v2\n" });
    const vcs = getVcsInfo(repo.cwd);
    updateRangeState(repo.cwd, vcs, { since: "HEAD~1" }, { verdict: "needs-work" });
    assert.equal(getPendingReviewCommit(repo.cwd), repo.revParse("HEAD~1"));
  });

  it("inconclusive verdict-slip results move nothing", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "v1\n" });
    repo.commit({ "a.txt": "v2\n" });
    const vcs = getVcsInfo(repo.cwd);
    setPendingReviewCommit(repo.cwd, repo.revParse("HEAD~1"));
    updateRangeState(repo.cwd, vcs, { since: repo.revParse("HEAD~1") }, { verdict: "needs-work", inconclusive: true });
    assert.equal(getLastReviewedCommit(repo.cwd), undefined);
    assert.equal(getPendingReviewCommit(repo.cwd), repo.revParse("HEAD~1"), "unchanged");
  });

  it("coverage-inconclusive results pin with pinOnInconclusive", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "v1\n" });
    repo.commit({ "a.txt": "v2\n" });
    const vcs = getVcsInfo(repo.cwd);
    updateRangeState(
      repo.cwd,
      vcs,
      { since: "HEAD~1" },
      { verdict: "needs-work", inconclusive: true },
      { pinOnInconclusive: true },
    );
    assert.equal(getPendingReviewCommit(repo.cwd), repo.revParse("HEAD~1"));
  });

  it("scoped reviews never touch range state, even on pass", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "v1\n" });
    repo.commit({ "a.txt": "v2\n" });
    const vcs = getVcsInfo(repo.cwd);
    setPendingReviewCommit(repo.cwd, repo.revParse("HEAD~1"));
    updateRangeState(repo.cwd, vcs, { since: repo.revParse("HEAD~1"), files: ["a.txt"] }, { verdict: "pass" });
    assert.equal(getLastReviewedCommit(repo.cwd), undefined);
    assert.equal(getPendingReviewCommit(repo.cwd), repo.revParse("HEAD~1"));
  });

  it("explicit svn override never touches git range state", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "v1\n" });
    repo.commit({ "a.txt": "v2\n" });
    const vcs = getVcsInfo(repo.cwd);
    updateRangeState(repo.cwd, vcs, { since: repo.revParse("HEAD~1"), vcs: "svn" }, { verdict: "pass" });
    assert.equal(getLastReviewedCommit(repo.cwd), undefined);
  });

  it("pinAttemptedRange pins like a needs-work result", { skip: !hasGit }, () => {
    const repo = makeRepo();
    tmpDirs.push(repo.cwd);
    repo.commit({ "a.txt": "v1\n" });
    repo.commit({ "a.txt": "v2\n" });
    const vcs = getVcsInfo(repo.cwd);
    pinAttemptedRange(repo.cwd, vcs, { since: "HEAD~1" });
    assert.equal(getPendingReviewCommit(repo.cwd), repo.revParse("HEAD~1"));
  });
});
