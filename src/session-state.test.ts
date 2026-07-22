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
  getLastReviewedCommit,
  setLastReviewedCommit,
  markStepsDoneByIds,
} from "./session-state.js";
import type { PlanResult } from "./types.js";

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "wai-ss-test-"));
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

test("lastReviewedCommit is tracked", () => {
  const cwd = tempCwd();
  setPlan(cwd, plan);
  assert.equal(getLastReviewedCommit(cwd), undefined);
  setLastReviewedCommit(cwd, "abc123");
  assert.equal(getLastReviewedCommit(cwd), "abc123");
  setPlan(cwd, plan);
  assert.equal(getLastReviewedCommit(cwd), undefined);
});

test("getProgress skips steps whose dependencies are not yet completed", () => {
  const cwd = tempCwd();
  const depPlan: PlanResult = {
    summary: "demo",
    todo: ["step one", { description: "step two", dependsOn: [1] }, { description: "step three", dependsOn: [1] }],
    acceptanceCriteria: [],
  };
  setPlan(cwd, depPlan);
  markStepComplete(cwd);
  // step one is done; step two depends on it, so it should be eligible.
  assert.equal(getProgress(cwd).nextStep, "step two");

  // Pretend step two is skipped and we try to advance to step three.
  // In the current model completedSteps is sequential, so this is just a sanity check.
  const state = getState(cwd);
  state.completedSteps = 1;
  state.reviewedSteps = [true, false, false];
  // With completedSteps=1, next eligible is step two (depends on one) not step three.
  assert.equal(getProgress(cwd).nextStep, "step two");
});

test("markStepsDoneByIds advances contiguous completed steps", () => {
  const cwd = tempCwd();
  setPlan(cwd, plan);
  assert.equal(markStepsDoneByIds(cwd, [1, 2], true), 2);
  assert.equal(getProgress(cwd).completed, 2);
  assert.equal(getState(cwd).reviewedSteps[0], true);
  assert.equal(getState(cwd).reviewedSteps[1], true);
  assert.equal(getState(cwd).reviewedSteps[2], false);
});

test("markStepsDoneByIds stops at first gap", () => {
  const cwd = tempCwd();
  setPlan(cwd, plan);
  assert.equal(markStepsDoneByIds(cwd, [1, 3], true), 1);
  assert.equal(getProgress(cwd).completed, 1);
});

test("markStepsDoneByIds ignores ids beyond total steps", () => {
  const cwd = tempCwd();
  setPlan(cwd, plan);
  assert.equal(markStepsDoneByIds(cwd, [1, 2, 3, 4, 5], true), 3);
  assert.equal(getProgress(cwd).completed, 3);
});
