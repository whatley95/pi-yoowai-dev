import test from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setPlan,
  markStepComplete,
  incrementReviewRounds,
  getProgress,
  getState,
  markJudgeCompleted,
} from "./session-state.js";
import type { PlanResult } from "./types.js";

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "yoo-ss-test-"));
}

const plan: PlanResult = { summary: "demo", todo: ["step one", "step two", "step three"], acceptanceCriteria: [] };

test("getProgress exposes completed count (renamed from current)", () => {
  const cwd = tempCwd();
  setPlan(cwd, plan);
  assert.equal(getProgress(cwd).completed, 0);
  assert.equal(getProgress(cwd).total, 3);
  markStepComplete(cwd, true);
  assert.equal(getProgress(cwd).completed, 1);
});

test("review rounds are tracked per step, not globally", () => {
  const cwd = tempCwd();
  setPlan(cwd, plan);

  // Step 1 fails review twice, then is completed.
  incrementReviewRounds(cwd);
  incrementReviewRounds(cwd);
  markStepComplete(cwd, true);

  // Step 2 fails review once.
  incrementReviewRounds(cwd);

  const state = getState(cwd);
  assert.deepEqual(state.reviewRounds, [2, 1, 0]);
  // Completing a step must not reset the next step's counter.
  assert.equal(state.reviewedSteps[0], true);
  assert.equal(state.reviewedSteps[1], false);
});

test("judgeCompleted flag is set and reset by setPlan", () => {
  const cwd = tempCwd();
  setPlan(cwd, plan);
  markJudgeCompleted(cwd);
  assert.equal(getState(cwd).judgeCompleted, true);
  setPlan(cwd, plan);
  assert.equal(getState(cwd).judgeCompleted, false);
});
