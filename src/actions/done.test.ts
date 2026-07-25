import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWaiDone } from "./done.js";
import { setPlan, getState } from "../session-state.js";
import { recordFileEdit } from "../session-state.js";
import type { PlanResult } from "../types.js";

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "wai-done-test-"));
}

function writeConfig(cwd: string, verifyDoneClaims = false): void {
  const piDir = join(cwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  // These tests exercise claim verification, not the done gate — disable the
  // gate explicitly since requireReviewBeforeDone now defaults to true.
  writeFileSync(
    join(piDir, "settings.json"),
    JSON.stringify({ "pi-yoowai": { verifyDoneClaims, requireReviewBeforeDone: false } }),
    "utf-8",
  );
}

function writeGateConfig(cwd: string, requireReviewBeforeDone: boolean): void {
  const piDir = join(cwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "settings.json"),
    JSON.stringify({ "pi-yoowai": { verifyDoneClaims: false, requireReviewBeforeDone } }),
    "utf-8",
  );
}

const plan: PlanResult = {
  summary: "demo",
  todo: ["step one", "step two", "step three"],
  acceptanceCriteria: [],
};

test("executeWaiDone returns message when no plan exists", async () => {
  const cwd = tempCwd();
  writeConfig(cwd);
  const result = await executeWaiDone(cwd);
  assert.equal(result.totalSteps, 0);
  assert.ok(result.message.includes("No active wai plan"));
});

test("executeWaiDone advances current step when verification is disabled", async () => {
  const cwd = tempCwd();
  writeConfig(cwd, false);
  setPlan(cwd, plan);
  recordFileEdit(cwd);
  const result = await executeWaiDone(cwd);
  assert.equal(result.completedStep, 1);
  // Verification is disabled, so `verified` must not be claimed as true.
  assert.equal(result.verified, undefined);
});

test("executeWaiDone advances when there are no edits since last done", async () => {
  const cwd = tempCwd();
  writeConfig(cwd, true);
  setPlan(cwd, plan);
  const result = await executeWaiDone(cwd);
  assert.equal(result.completedStep, 1);
  // No edits since last done means verification is skipped, so `verified` is not claimed.
  assert.equal(result.verified, undefined);
});

test("executeWaiDone marks up to an explicit target without claim verification", async () => {
  const cwd = tempCwd();
  // Verification is enabled and there are unrecorded edits, but an explicit
  // target is a tracker correction, not a done-claim — it must not be gated.
  writeConfig(cwd, true);
  setPlan(cwd, plan);
  recordFileEdit(cwd);
  const result = await executeWaiDone(cwd, 2);
  assert.equal(result.completedStep, 2);
  assert.equal(result.verified, undefined);
  assert.ok(result.message.includes("Marked steps up to 2"));
});

test("executeWaiDone regresses the tracker when the explicit target is lower", async () => {
  const cwd = tempCwd();
  writeConfig(cwd, true);
  setPlan(cwd, plan);
  await executeWaiDone(cwd, 3);
  const result = await executeWaiDone(cwd, 1);
  assert.equal(result.completedStep, 1);
  assert.equal(result.allDone, false);
  assert.ok(result.message.includes("regressed to step 1"));
});

test("executeWaiDone resets the tracker with an explicit zero target", async () => {
  const cwd = tempCwd();
  writeConfig(cwd, true);
  setPlan(cwd, plan);
  await executeWaiDone(cwd, 2);
  const result = await executeWaiDone(cwd, 0);
  assert.equal(result.completedStep, 0);
  assert.equal(result.allDone, false);
});

test("executeWaiDone blocks completion with unreviewed edits when requireReviewBeforeDone is enabled", async () => {
  const cwd = tempCwd();
  writeGateConfig(cwd, true);
  setPlan(cwd, plan);
  recordFileEdit(cwd);
  recordFileEdit(cwd);
  const result = await executeWaiDone(cwd);
  assert.equal(result.completedStep, 0);
  assert.equal(result.allDone, false);
  assert.equal(result.blocked, true);
  assert.ok(result.message.includes("2 file edit(s) have not been reviewed"));
  // The tracker must not advance while blocked.
  assert.equal(getState(cwd).completedSteps, 0);
});

test("executeWaiDone force override completes and records the step as not reviewed", async () => {
  const cwd = tempCwd();
  writeGateConfig(cwd, true);
  setPlan(cwd, plan);
  recordFileEdit(cwd);
  const result = await executeWaiDone(cwd, undefined, undefined, true);
  assert.equal(result.completedStep, 1);
  assert.equal(result.blocked, undefined);
  // A forced completion is a manual mark, not a reviewed one.
  assert.equal(getState(cwd).reviewedSteps[0], false);
});

test("executeWaiDone does not gate tracker corrections (explicit target at or below progress)", async () => {
  const cwd = tempCwd();
  writeGateConfig(cwd, true);
  setPlan(cwd, plan);
  const forced = await executeWaiDone(cwd, 2, undefined, true);
  assert.equal(forced.completedStep, 2);
  recordFileEdit(cwd);
  const result = await executeWaiDone(cwd, 1);
  assert.equal(result.completedStep, 1);
  assert.equal(result.blocked, undefined);
});

test("executeWaiDone does not gate when requireReviewBeforeDone is disabled", async () => {
  const cwd = tempCwd();
  writeGateConfig(cwd, false);
  setPlan(cwd, plan);
  recordFileEdit(cwd);
  const result = await executeWaiDone(cwd);
  assert.equal(result.completedStep, 1);
  assert.equal(result.blocked, undefined);
});
