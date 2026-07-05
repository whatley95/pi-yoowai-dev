import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearSessionId, getSessionConfigPath, getSessionId, pruneSessionDirs, setSessionId } from "./session-scope.js";

function createFakeSessionDir(cwd: string, hash: string, mtime: Date): string {
  const dir = join(cwd, ".pi", "heyyoo", "sessions", hash);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "plan.json");
  writeFileSync(file, "{}", "utf-8");
  utimesSync(file, mtime, mtime);
  utimesSync(dir, mtime, mtime);
  return dir;
}

describe("session-scope", () => {
  const cwd = mkdtempSync(join(tmpdir(), "yoo-session-test-"));

  beforeEach(() => {
    clearSessionId(cwd);
    const sessionsRoot = join(cwd, ".pi", "heyyoo", "sessions");
    if (existsSync(sessionsRoot)) {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("falls back to project-scoped path when no session id is set", () => {
    const path = getSessionConfigPath(cwd, "plan.json");
    assert.match(path, /[\\/]\.pi[\\/]heyyoo[\\/]plan\.json$/);
  });

  it("uses a session-scoped path when a session id is set", () => {
    setSessionId(cwd, "session-abc-123");
    const path = getSessionConfigPath(cwd, "memory.json");
    assert.match(path, /[\\/]\.pi[\\/]heyyoo[\\/]sessions[\\/][a-f0-9]+[\\/]memory\.json$/);
    assert.ok(!path.includes("session-abc-123"), "raw session id should not appear in the path");
  });

  it("returns different paths for different session ids", () => {
    setSessionId(cwd, "session-a");
    const pathA = getSessionConfigPath(cwd, "cost.json");
    clearSessionId(cwd);
    setSessionId(cwd, "session-b");
    const pathB = getSessionConfigPath(cwd, "cost.json");
    assert.notEqual(pathA, pathB);
  });

  it("clears the active session id", () => {
    setSessionId(cwd, "session-x");
    assert.equal(getSessionId(cwd), "session-x");
    clearSessionId(cwd);
    assert.equal(getSessionId(cwd), undefined);
  });

  it("prunes session directories older than maxAgeDays", () => {
    const current = "current-session";
    setSessionId(cwd, current);
    const currentDir = createFakeSessionDir(cwd, "abc123current000", new Date());
    const oldDir = createFakeSessionDir(cwd, "def456old00000", new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));

    pruneSessionDirs(cwd, current, { maxAgeDays: 1, maxSessions: 10 });

    assert.ok(existsSync(currentDir), "current session dir should survive pruning");
    assert.ok(!existsSync(oldDir), "old session dir should be pruned");
  });

  it("prunes oldest dirs when exceeding maxSessions", () => {
    const current = "current-session-2";
    setSessionId(cwd, current);
    const currentDir = createFakeSessionDir(cwd, "current000000000", new Date());
    const oldestDir = createFakeSessionDir(cwd, "oldest0000000000", new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));
    createFakeSessionDir(cwd, "old1000000000000", new Date(Date.now() - 4 * 24 * 60 * 60 * 1000));
    createFakeSessionDir(cwd, "old2000000000000", new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    createFakeSessionDir(cwd, "old3000000000000", new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
    createFakeSessionDir(cwd, "recent0000000000", new Date(Date.now() - 1 * 24 * 60 * 60 * 1000));

    pruneSessionDirs(cwd, current, { maxAgeDays: 10, maxSessions: 3 });

    assert.ok(existsSync(currentDir), "current session dir should survive");
    assert.ok(!existsSync(oldestDir), "oldest dir should be pruned");

    const sessionsRoot = join(cwd, ".pi", "heyyoo", "sessions");
    const remaining = readdirSync(sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    assert.equal(remaining.length, 3, "should keep current plus maxSessions-1 most recent dirs");
  });

  it("cleans up temp dir", () => {
    rmSync(cwd, { recursive: true, force: true });
    assert.ok(true);
  });
});
