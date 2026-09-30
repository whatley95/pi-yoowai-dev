import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { preservedCompletedPrefix } from "./plan-update.js";
import type { PlanResult, PlanTodoItem } from "../types.js";

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
