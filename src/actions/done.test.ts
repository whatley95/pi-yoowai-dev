import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWaiDone } from "./done.js";
import { setPlan } from "../session-state.js";
import { recordFileEdit } from "../session-state.js";
import type { PlanResult } from "../types.js";

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "wai-done-test-"));
}

function writeConfig(cwd: string, verifyDoneClaims = false): void {
  const piDir = join(cwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(piDir, "settings.json"), JSON.stringify({ "pi-yoowai": { verifyDoneClaims } }), "utf-8");
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
