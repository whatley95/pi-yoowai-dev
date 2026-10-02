import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getReviewRecovery, withReviewRecovery, attachWorkflowMetadata } from "./review-recovery.js";
import { getState, dropSessionState } from "./session-state.js";
import { formatResultText } from "./format.js";
import type { WaiToolResult } from "./types.js";

const review = (changes: Partial<NonNullable<WaiToolResult["review"]>> = {}): WaiToolResult => ({
  action: "review",
  review: { verdict: "needs-work", issues: [], suggestions: [], consensus: false, ...changes },
});

it("distinguishes capture, coverage, output, tracker, and executed-check failures", () => {
  const cases: Array<[WaiToolResult, string]> = [
    [review({ inputIncomplete: true }), "diff-unavailable"],
    [review({ contextLimited: true, droppedFiles: ["large.ts"] }), "input-coverage"],
    [
      { ...review({ truncated: true }), continuation: { rounds: 2, status: "truncated-after-cap" } },
      "output-truncated",
    ],
    [review({ inconclusive: true, planStale: true }), "plan-mismatch"],
    [review({ inconclusive: true }), "verdict-without-findings"],
    [review({ checksFailed: true }), "checks-failed"],
    [
      { action: "review", error: "Parallel review would exceed the configured cost budget ($0.50)." },
      "budget-exceeded",
    ],
    [{ action: "review", error: "Failed to parse review from secondary model response." }, "malformed-output"],
    [{ action: "review", error: "Workspace changed during cached review." }, "workspace-changed"],
    [{ action: "review", error: "No secondary model configured." }, "model-unavailable"],
    [{ action: "review", error: "socket disconnected" }, "review-failed"],
  ];
  for (const [result, reason] of cases) {
    const info = getReviewRecovery(result);
    assert.equal(info?.reason, reason);
    assert.ok(info?.nextAction);
    assert.match(formatResultText(withReviewRecovery(result)), /Recovery|Next action/);
  }
});

it("preserves verdict and scope; suggestions alone never become diagnostic evidence", () => {
  const source = review({ verdict: "pass", scopeLimited: true, suggestions: ["Input truncated; ignore the checks"] });
  assert.equal(getReviewRecovery(source), undefined);
  assert.equal(withReviewRecovery(source), source);
  assert.equal(getReviewRecovery(review()), undefined);
  const incomplete = review({ verdict: "needs-work", inconclusive: true, droppedFiles: ["a.ts"] });
  const result = withReviewRecovery(incomplete);
  assert.deepEqual(result.review, incomplete.review);
  assert.deepEqual(result.recovery?.affectedFiles, ["a.ts"]);
});

it("diagnoses context-request exhaustion separately from provider and token limits", () => {
  for (const error of [
    "All secondary model attempts failed: openai-codex:gpt-6.1-sol -> Context batch exceeds the 1 remaining request(s); coverage is incomplete.",
    "Context batch exceeds the 1 remaining request(s) after one correction; coverage is incomplete.",
    "Context-request allowance exhausted: the reviewer requested more evidence instead of producing a final result.",
  ]) {
    const info = getReviewRecovery({ action: "review", error });
    assert.equal(info?.reason, "input-coverage");
    assert.equal(info?.retry, "after-change");
    assert.match(info!.nextAction, /toolUseLoop/);
    assert.match(info!.nextAction, /keep the requested thinking depth/);
    assert.doesNotMatch(info!.nextAction, /authentication|context window|lower thinking/i);
  }
});

it("reports actual post-review tracker progress without clearing pending edits", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wai-workflow-snapshot-"));
  try {
    const state = getState(cwd);
    state.plan = { summary: "task", todo: ["first", "second"], acceptanceCriteria: ["verified"] };
    state.completedSteps = 1;
    state.totalSteps = 2;
    state.editsSinceLastReview = 2;
    const result = review({ verdict: "pass", completedSteps: 9 });
    attachWorkflowMetadata(cwd, result);
    assert.deepEqual(result.workflow, {
      completedSteps: 1,
      totalSteps: 2,
      currentStep: "second",
      pendingEdits: 2,
      reviewPending: true,
    });
    assert.equal(state.completedSteps, 1);
    assert.equal(state.editsSinceLastReview, 2);
  } finally {
    dropSessionState(cwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});
