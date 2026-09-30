import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { captureWorkspace, workspaceMatches } from "./workspace-fingerprint.js";
import { applyReviewOutcome, getEditTracker, recordFileEdit } from "./session-state.js";

function svnAvailable(): boolean {
  try {
    execFileSync("svn", ["--version", "--quiet"], { stdio: "pipe" });
    execFileSync("svnadmin", ["--version", "--quiet"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

test("SVN fingerprints detect edits and exclude Pi state", { skip: !svnAvailable() }, () => {
  const root = mkdtempSync(join(tmpdir(), "wai-svn-fingerprint-"));
  const repository = join(root, "repository");
  const cwd = join(root, "checkout");
  try {
    execFileSync("svnadmin", ["create", repository], { stdio: "pipe" });
    execFileSync("svn", ["checkout", pathToFileURL(repository).href, cwd], { stdio: "pipe" });
    writeFileSync(join(cwd, "a&b.txt"), "old\n");
    execFileSync("svn", ["add", "a&b.txt"], { cwd, stdio: "pipe" });
    execFileSync("svn", ["commit", "-m", "base"], { cwd, stdio: "pipe" });

    const clean = captureWorkspace(cwd);
    assert.equal(clean.status, "ready");
    assert.equal(clean.status === "ready" && clean.dirty, false);
    mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "yoowai", "log.txt"), "runtime state\n");
    assert.deepEqual(captureWorkspace(cwd), clean);
    mkdirSync(join(cwd, "target", "classes"), { recursive: true });
    writeFileSync(join(cwd, "target", "classes", "App.class"), Buffer.from([0, 1, 2]));
    mkdirSync(join(cwd, ".idea"));
    writeFileSync(join(cwd, ".idea", "workspace.xml"), "local settings\n");
    assert.deepEqual(captureWorkspace(cwd), clean, "build output cannot invalidate source certification");

    recordFileEdit(cwd, "a&b.txt");
    assert.equal(
      applyReviewOutcome(cwd, {
        action: "review",
        review: { verdict: "pass", issues: [], suggestions: [], consensus: true },
        workspaceFingerprint: clean.status === "ready" ? clean.fingerprint : undefined,
      }),
      true,
    );
    writeFileSync(join(cwd, "a&b.txt"), "new\n");
    assert.equal(workspaceMatches(cwd, clean), false);
    const changed = captureWorkspace(cwd);
    assert.equal(changed.status, "ready");
    assert.equal(changed.status === "ready" && changed.dirty, true);
    recordFileEdit(cwd, "a&b.txt");
    assert.equal(
      applyReviewOutcome(cwd, {
        action: "review",
        review: { verdict: "pass", issues: [], suggestions: [], consensus: true },
        workspaceFingerprint: clean.status === "ready" ? clean.fingerprint : undefined,
      }),
      false,
    );
    assert.equal(getEditTracker(cwd).editsSinceLastReview, 1);

    const beforeUntracked = captureWorkspace(cwd);
    mkdirSync(join(cwd, "new"));
    writeFileSync(join(cwd, "new", "nested.txt"), "first\n");
    assert.equal(workspaceMatches(cwd, beforeUntracked), false);
    const untracked = captureWorkspace(cwd);
    writeFileSync(join(cwd, "new", "nested.txt"), "other\n");
    assert.equal(workspaceMatches(cwd, untracked), false);

    execFileSync("svn", ["propset", "wai-test", "first", "a&b.txt"], { cwd, stdio: "pipe" });
    const firstProperty = captureWorkspace(cwd);
    assert.equal(firstProperty.status, "ready");
    execFileSync("svn", ["propset", "wai-test", "other", "a&b.txt"], { cwd, stdio: "pipe" });
    assert.equal(workspaceMatches(cwd, firstProperty), false);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
