import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { preservedCompletedPrefix } from "./plan-update.js";
import type { PlanResult, PlanTodoItem } from "../types.js";
import { executeWaiPlanUpdate } from "./plan-update.js";
import {
  getState,
  setPlan,
  markStepsComplete,
  dropSessionState,
  incrementReviewRounds,
  planStateToken,
  syncWorkspaceChanges,
} from "../session-state.js";
import { identifyPlan } from "../plan-editor.js";
import { getSessionConfigPath } from "../session-scope.js";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";

function plan(todo: PlanTodoItem[]): PlanResult {
  return { summary: "task", todo, acceptanceCriteria: [] };
}

describe("preservedCompletedPrefix", () => {
  const original = plan(["inspect", "implement", "verify"]);

  it("retains only completed leading work, including when pending work changes", () => {
    assert.equal(preservedCompletedPrefix(original, plan(["inspect", "implement", "new verification"]), 2), 2);
    assert.equal(preservedCompletedPrefix(original, original, 0), 0);
    assert.equal(preservedCompletedPrefix(original, plan(["inspect"]), 2), 1);
  });

  it("stops at the first changed, inserted, or reordered completed step", () => {
    assert.equal(
      preservedCompletedPrefix(original, plan(["inspect", "new prerequisite", "implement", "verify"]), 2),
      1,
    );
    assert.equal(preservedCompletedPrefix(original, plan(["implement", "inspect", "verify"]), 2), 0);
    assert.equal(preservedCompletedPrefix(original, plan(["inspect", "implement differently", "verify"]), 2), 1);
    assert.equal(preservedCompletedPrefix(original, plan([]), 2), 0);
  });

  it("allows cosmetic priority changes but invalidates changed dependencies", () => {
    const previous = plan(["inspect", { description: "implement", priority: "high", dependsOn: [1] }]);
    const reprioritized = plan(["inspect", { description: "implement", priority: "low", dependsOn: [1] }]);
    const changedDependencies = plan(["inspect", { description: "implement", dependsOn: [] }]);
    assert.equal(preservedCompletedPrefix(previous, reprioritized, 2), 2);
    assert.equal(preservedCompletedPrefix(previous, changedDependencies, 2), 1);
    assert.equal(preservedCompletedPrefix(plan(["inspect"]), plan([{ description: "inspect" }]), 1), 1);
  });
});

function project(t: { after: (fn: () => void) => void }): string {
  const cwd = mkdtempSync(join(tmpdir(), "wai-plan-update-"));
  execFileSync("git", ["init", "--quiet"], { cwd, windowsHide: true });
  writeFileSync(join(cwd, "main.ts"), "export const value = 1;\n");
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ "pi-yoowai": { costBudgetUsd: 0 } }));
  setPlan(cwd, identifyPlan(plan(["Inspect", "Implement", "Verify"])));
  markStepsComplete(cwd, 1, true);
  getState(cwd).reviewRounds = [2, 3, 0];
  syncWorkspaceChanges(cwd);
  t.after(() => {
    dropSessionState(cwd);
    assert.equal(dirname(resolve(cwd)).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(basename(cwd).startsWith("wai-plan-update-"));
    rmSync(cwd, { recursive: true, force: true });
  });
  return cwd;
}

async function modelServer(
  t: { after: (fn: () => void | Promise<void>) => void },
  payload: PlanResult,
  finishReason = "stop",
): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: finishReason }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

describe("plan update transactions", () => {
  it("rejects incomplete model output even when it contains parseable JSON", async (t) => {
    const cwd = project(t);
    const original = structuredClone(getState(cwd).plan);
    const url = await modelServer(t, { ...original!, summary: "Incomplete update" }, "length");
    writeFileSync(
      join(cwd, ".pi/settings.json"),
      JSON.stringify({
        "pi-yoowai": {
          costBudgetUsd: 100,
          maxContinuations: 0,
          taskModels: {
            plan: { provider: "openai", id: "gpt-4o-mini", backend: "http", baseUrl: url, apiKey: "test" },
          },
        },
      }),
    );
    const result = await executeWaiPlanUpdate(cwd, "Change the summary", undefined, () => {}, undefined);
    assert.match(result.error!, /incomplete/);
    assert.deepEqual(getState(cwd).plan, original);
    dropSessionState(cwd);
    assert.deepEqual(getState(cwd).plan, original);
  });
  it("applies targeted edits without a model budget and preserves reviews, ranges, and pending edits", async (t) => {
    const cwd = project(t);
    const state = getState(cwd);
    state.lastReviewedCommit = "accepted-base";
    state.pendingReviewCommit = "pending-base";
    state.editsSinceLastReview = 2;
    state.editsSinceLastDone = 2;
    state.reviewBlocked = true;
    const result = await executeWaiPlanUpdate(
      cwd,
      "label 1 Inspection",
      undefined,
      () => {
        throw new Error("no model call");
      },
      undefined,
    );
    assert.equal(result.error, undefined);
    assert.equal(result.completedStep, 1);
    assert.equal(result.undoAvailable, true);
    assert.match(result.changes?.join("\n") ?? "", /label/);
    dropSessionState(cwd);
    const persisted = getState(cwd);
    assert.equal(persisted.reviewedSteps[0], true);
    assert.deepEqual(persisted.reviewRounds, [2, 3, 0]);
    assert.equal(persisted.lastReviewedCommit, "accepted-base");
    assert.equal(persisted.pendingReviewCommit, "pending-base");
    assert.equal(persisted.editsSinceLastReview, 2);
    assert.equal(persisted.editsSinceLastDone, 2);
    assert.equal(persisted.reviewBlocked, true);
  });

  it("reopens changed outcomes and criteria while preserving unrelated completed leading work", async (t) => {
    const cwd = project(t);
    markStepsComplete(cwd, 2, true);
    const result = await executeWaiPlanUpdate(cwd, "edit 2 New implementation outcome", undefined, () => {}, undefined);
    assert.equal(result.completedStep, 1);
    assert.deepEqual(getState(cwd).reviewedSteps, [true, false, false]);
    assert.deepEqual(getState(cwd).reviewRounds, [2, 0, 0]);
    const criteria = await executeWaiPlanUpdate(
      cwd,
      { operations: [], acceptanceCriteria: ["New required behavior"] },
      undefined,
      () => {},
      undefined,
    );
    assert.equal(criteria.completedStep, 0);
  });

  it("undo survives restart and restores review history only for unchanged source evidence", async (t) => {
    const cwd = project(t);
    const id = (getState(cwd).plan!.todo[0] as { id: string }).id;
    await executeWaiPlanUpdate(cwd, "edit 1 New inspection outcome", undefined, () => {}, undefined);
    dropSessionState(cwd);
    const result = await executeWaiPlanUpdate(cwd, { undo: true }, undefined, () => {}, undefined);
    assert.equal(result.error, undefined);
    assert.equal(result.completedStep, 1);
    assert.equal(result.undoAvailable, false);
    assert.equal((getState(cwd).plan!.todo[0] as { id: string }).id, id);
    assert.equal(getState(cwd).reviewedSteps[0], true);
    assert.deepEqual(getState(cwd).reviewRounds, [2, 3, 0]);
    await executeWaiPlanUpdate(cwd, "label 1 Different label", undefined, () => {}, undefined);
    writeFileSync(join(cwd, "main.ts"), "export const value = 2;\n");
    const changed = await executeWaiPlanUpdate(cwd, "undo", undefined, () => {}, undefined);
    assert.equal(changed.completedStep, 0);
    assert.match(changed.message, /evidence changed/);
    assert.ok(getState(cwd).editsSinceLastReview > 0);
  });

  it("invalid operations and cancelled updates preserve the existing plan and persisted bytes", async (t) => {
    const cwd = project(t);
    const file = getSessionConfigPath(cwd, "plan.json");
    const text = readFileSync(file, "utf8");
    const token = planStateToken(cwd);
    const bad = await executeWaiPlanUpdate(
      cwd,
      { operations: [{ op: "edit", step: 1, dependsOn: [1] }] },
      undefined,
      () => {},
      undefined,
    );
    assert.match(bad.error!, /earlier steps/);
    assert.equal(planStateToken(cwd), token);
    assert.equal(readFileSync(file, "utf8"), text);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(executeWaiPlanUpdate(cwd, "label 1 Cancelled", cancelled.signal, () => {}, undefined));
    assert.equal(planStateToken(cwd), token);
  });

  it("a failed atomic save leaves the session plan untouched", async (t) => {
    const cwd = project(t);
    const token = planStateToken(cwd);
    const file = getSessionConfigPath(cwd, "plan.json");
    renameSync(file, file + ".saved");
    mkdirSync(file);
    const result = await executeWaiPlanUpdate(cwd, "label 1 Cannot persist", undefined, () => {}, undefined);
    assert.ok(result.error);
    assert.equal(planStateToken(cwd), token);
    assert.ok(readFileSync(file + ".saved", "utf8"));
  });

  it("model generation cannot overwrite a concurrently changed tracker or persist before cancellation", async (t) => {
    const cwd = project(t);
    const payload = { ...getState(cwd).plan!, summary: "New summary" };
    const url = await modelServer(t, payload);
    writeFileSync(
      join(cwd, ".pi/settings.json"),
      JSON.stringify({
        "pi-yoowai": {
          costBudgetUsd: 100,
          taskModels: {
            plan: { provider: "openai", id: "gpt-4o-mini", backend: "http", baseUrl: url, apiKey: "test" },
          },
        },
      }),
    );
    const original = structuredClone(getState(cwd).plan);
    const result = await executeWaiPlanUpdate(
      cwd,
      "Update the summary",
      undefined,
      (stage) => {
        if (stage === 3) incrementReviewRounds(cwd);
      },
      undefined,
    );
    assert.match(result.error!, /tracking changed/);
    assert.deepEqual(getState(cwd).plan, original);
    assert.equal(getState(cwd).reviewRounds[1], 4);
    const controller = new AbortController();
    await assert.rejects(
      executeWaiPlanUpdate(
        cwd,
        "Update the summary",
        controller.signal,
        (stage) => {
          if (stage === 3) controller.abort();
        },
        undefined,
      ),
    );
    assert.deepEqual(getState(cwd).plan, original);
    dropSessionState(cwd);
    assert.deepEqual(getState(cwd).plan, original);
  });
});
