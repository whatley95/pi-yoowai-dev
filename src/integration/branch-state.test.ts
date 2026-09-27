import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { branchStateSnapshot, restoreBranchState } from "./branch-state.js";
import { setPlan, markStepComplete, getState, dropSessionState, replaceSessionState } from "../session-state.js";

it("restores progress from the active branch, clears pre-plan branches, and preserves an explicit clear", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wai-branch-"));
  const entries: unknown[] = [];
  const ctx = { cwd, sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext;
  try {
    setPlan(cwd, { summary: "branch A", todo: ["one", "two"], acceptanceCriteria: [] });
    entries.push({ type: "custom", customType: "wai", data: branchStateSnapshot(cwd) });
    markStepComplete(cwd, true);
    assert.equal(getState(cwd).completedSteps, 1);
    restoreBranchState(ctx, true);
    assert.equal(getState(cwd).completedSteps, 0);
    assert.equal(getState(cwd).plan?.summary, "branch A");
    entries.length = 0;
    restoreBranchState(ctx, true);
    assert.equal(getState(cwd).totalSteps, 0);
    setPlan(cwd, { summary: "branch B", todo: ["one"], acceptanceCriteria: [] });
    entries.push({ type: "custom", customType: "wai", data: branchStateSnapshot(cwd) });
    replaceSessionState(cwd);
    entries.push({ type: "custom", customType: "wai", data: { ...branchStateSnapshot(cwd), type: "state-cleared" } });
    setPlan(cwd, { summary: "future", todo: ["one"], acceptanceCriteria: [] });
    restoreBranchState(ctx, true);
    assert.equal(getState(cwd).totalSteps, 0);
  } finally {
    dropSessionState(cwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("reads Pi's active session branch without inheriting an abandoned branch's plan", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wai-pi-branch-"));
  const sessionManager = SessionManager.inMemory(cwd);
  const ctx = { cwd, sessionManager } as unknown as ExtensionContext;
  try {
    setPlan(cwd, { summary: "shared", todo: ["one"], acceptanceCriteria: [] });
    const shared = sessionManager.appendCustomEntry("wai", branchStateSnapshot(cwd));
    setPlan(cwd, { summary: "abandoned", todo: ["two"], acceptanceCriteria: [] });
    sessionManager.appendCustomEntry("wai", branchStateSnapshot(cwd));
    sessionManager.branch(shared);
    restoreBranchState(ctx, true);
    assert.equal(getState(cwd).plan?.summary, "shared");
    setPlan(cwd, { summary: "new branch", todo: ["three"], acceptanceCriteria: [] });
    sessionManager.appendCustomEntry("wai", branchStateSnapshot(cwd));
    dropSessionState(cwd);
    restoreBranchState(ctx);
    assert.equal(getState(cwd).plan?.summary, "new branch");
  } finally {
    dropSessionState(cwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});
