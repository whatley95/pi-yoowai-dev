import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "./plan-store.js";
import type { YoowaiSessionState } from "./types.js";

describe("plan-store", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "wai-plan-test-"));
  });

  it("round-trips legacy string-array plans", () => {
    const state: YoowaiSessionState = {
      completedSteps: 1,
      totalSteps: 2,
      reviewRounds: [],
      reviewedSteps: [true, false],
      editsSinceLastReview: 0,
      editsSinceLastDone: 0,
      plan: {
        summary: "Legacy plan",
        todo: ["Step one", "Step two"],
        acceptanceCriteria: ["Done"],
      },
    };
    saveState(cwd, state);
    const loaded = loadState(cwd);
    assert.deepEqual(loaded?.plan?.todo, state.plan?.todo);
  });

  it("round-trips plan steps with priority and dependencies", () => {
    const state: YoowaiSessionState = {
      completedSteps: 0,
      totalSteps: 2,
      reviewRounds: [],
      reviewedSteps: [false, false],
      editsSinceLastReview: 0,
      editsSinceLastDone: 0,
      plan: {
        summary: "Rich plan",
        todo: [
          { description: "Add parser", priority: "high", dependsOn: [] },
          { description: "Wire into scan", priority: "medium", dependsOn: [1] },
        ],
        acceptanceCriteria: ["Parser works", "Scan uses parser"],
      },
    };
    saveState(cwd, state);
    const loaded = loadState(cwd);
    assert.equal(loaded?.plan?.todo.length, 2);
    const first = loaded?.plan?.todo[0];
    assert.ok(first && typeof first === "object");
    if (typeof first === "object") {
      assert.equal(first.description, "Add parser");
      assert.equal(first.priority, "high");
      assert.deepEqual(first.dependsOn, []);
    }
  });

  it("cleans up temp dir", () => {
    rmSync(cwd, { recursive: true, force: true });
    assert.ok(true);
  });
});
