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
  setPlanProgress,
  recordFileEdit,
  resetEditsSinceReview,
  getEditTracker,
  recordUnreviewedTurn,
  flushSessionState,
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

test("setPlanProgress advances and regresses, clearing reviewed flags and re-arming judge", () => {
  const cwd = tempCwd();
  setPlan(cwd, plan);
  markStepsDoneByIds(cwd, [1, 2, 3], true);
  markJudgeCompleted(cwd);
  assert.equal(getProgress(cwd).completed, 3);

  // Regress: step 3 was not actually done.
  setPlanProgress(cwd, 2);
  const state = getState(cwd);
  assert.equal(state.completedSteps, 2);
  assert.equal(state.reviewedSteps[2], false);
  assert.equal(state.reviewedSteps[0], true);
  // A regressed plan may be judged again.
  assert.equal(state.judgeCompleted, false);

  // Advance again: newly completed steps are marked not reviewed.
  setPlanProgress(cwd, 3);
  assert.equal(getProgress(cwd).completed, 3);
  assert.equal(getState(cwd).reviewedSteps[2], false);

  // Clamps to [0, totalSteps].
  setPlanProgress(cwd, 99);
  assert.equal(getProgress(cwd).completed, 3);
  setPlanProgress(cwd, -5);
  assert.equal(getProgress(cwd).completed, 0);
});

test("recordFileEdit tracks edited file paths, deduped, cleared on review reset", () => {
  const cwd = tempCwd();
  setPlan(cwd, plan);
  recordFileEdit(cwd, "src/a.ts");
  recordFileEdit(cwd, "src/b.ts");
  recordFileEdit(cwd, "src/a.ts");
  recordFileEdit(cwd); // no path — counter still increments

  const tracker = getEditTracker(cwd);
  assert.equal(tracker.editsSinceLastReview, 4);
  assert.deepEqual(tracker.editedFiles, ["src/a.ts", "src/b.ts"]);

  resetEditsSinceReview(cwd);
  assert.equal(getEditTracker(cwd).editsSinceLastReview, 0);
  assert.deepEqual(getEditTracker(cwd).editedFiles, []);
});

test("setPlan resets the edited-files tracker so a new plan starts clean", () => {
  const cwd = tempCwd();
  setPlan(cwd, plan);
  recordFileEdit(cwd, "src/old-task.ts");
  assert.deepEqual(getEditTracker(cwd).editedFiles, ["src/old-task.ts"]);

  // Moving to a new task/plan must not leak the old task's files or counters.
  setPlan(cwd, { summary: "next task", todo: ["new step"], acceptanceCriteria: [] });
  const tracker = getEditTracker(cwd);
  assert.deepEqual(tracker.editedFiles, []);
  assert.equal(tracker.editsSinceLastReview, 0);
  assert.equal(tracker.editsSinceLastDone, 0);
});

test("flushSessionState folds pending edits into unreviewedEditsTotal without double counting", () => {
  const cwd = tempCwd();
  setPlan(cwd, plan);
  recordFileEdit(cwd);
  recordFileEdit(cwd);

  flushSessionState(cwd);
  flushSessionState(cwd);
  assert.equal(getState(cwd).unreviewedEditsTotal, 2);

  // Only the delta since the last flush is accumulated.
  recordFileEdit(cwd);
  flushSessionState(cwd);
  assert.equal(getState(cwd).unreviewedEditsTotal, 3);
  // The pending-edits counter itself is untouched by flushing.
  assert.equal(getState(cwd).editsSinceLastReview, 3);
});

test("resetEditsSinceReview clears the unreviewed-turn streak and flush marker", () => {
  const cwd = tempCwd();
  setPlan(cwd, plan);
  recordFileEdit(cwd);
  recordUnreviewedTurn(cwd);
  recordUnreviewedTurn(cwd);
  flushSessionState(cwd);

  resetEditsSinceReview(cwd);
  const state = getState(cwd);
  assert.equal(state.editsSinceLastReview, 0);
  assert.equal(state.unreviewedTurns, 0);
  assert.equal(state.unreviewedEditsFlushed, 0);
  // The cumulative total is a session metric and survives the review.
  assert.equal(state.unreviewedEditsTotal, 1);
});

test("setPlan resets the unreviewed-edit metrics for a new plan", () => {
  const cwd = tempCwd();
  setPlan(cwd, plan);
  recordFileEdit(cwd);
  recordUnreviewedTurn(cwd);
  flushSessionState(cwd);

  setPlan(cwd, { summary: "next task", todo: ["new step"], acceptanceCriteria: [] });
  const state = getState(cwd);
  assert.equal(state.unreviewedTurns, 0);
  assert.equal(state.unreviewedEditsTotal, 0);
  assert.equal(state.unreviewedEditsFlushed, 0);
});
