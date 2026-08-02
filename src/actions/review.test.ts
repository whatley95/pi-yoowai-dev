import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planAdvanceFromReview } from "./review.js";
import { mergeReviewResults } from "./review-helpers.js";
import type { ReviewResult } from "../types.js";

/** A valid ReviewResult with optional overrides (constructed directly, so
 *  consensus does NOT get re-derived like validateReviewResult would). */
function review(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    verdict: "pass",
    issues: [],
    suggestions: [],
    consensus: true,
    ...overrides,
  };
}

describe("planAdvanceFromReview (guarded auto-completion)", () => {
  it("consensus advances by the relative completedSteps count", () => {
    assert.deepEqual(planAdvanceFromReview(review({ completedSteps: 2 }), true, false), { count: 2 });
    assert.deepEqual(planAdvanceFromReview(review(), true, false), { count: 1 });
  });

  it("stepComplete advances exactly one step on a pass, even with minor issues", () => {
    // A pass with a low-severity nit: consensus is false, but the model
    // explicitly confirmed the current step's work is finished and covered.
    const result = review({
      consensus: false,
      stepComplete: true,
      issues: [{ severity: "low", issue: "nit", suggestion: "polish" }],
    });
    assert.deepEqual(planAdvanceFromReview(result, true, false), { count: 1 });
  });

  it("a bare pass without consensus or stepComplete does not advance", () => {
    assert.equal(planAdvanceFromReview(review({ consensus: false, stepComplete: false }), true, false), null);
    assert.equal(planAdvanceFromReview(review({ consensus: false }), true, false), null);
  });

  it("needs-work never advances, even with stepComplete", () => {
    const result = review({ verdict: "needs-work", consensus: false, stepComplete: true });
    assert.equal(planAdvanceFromReview(result, true, false), null);
  });

  it("no plan or an already-complete plan never advances", () => {
    assert.equal(planAdvanceFromReview(review(), false, false), null);
    assert.equal(planAdvanceFromReview(review(), true, true)!.count, 0);
    assert.equal(planAdvanceFromReview(review({ consensus: false, stepComplete: true }), true, true)!.count, 0);
  });
});

describe("mergeReviewResults plan-tracker signals", () => {
  it("stepComplete requires every sub-review; planStale fires on any", () => {
    const merged = mergeReviewResults([
      review({ stepComplete: true, planStale: false }),
      review({ stepComplete: true, planStale: true }),
    ]);
    assert.equal(merged.stepComplete, true);
    assert.equal(merged.planStale, true);

    const merged2 = mergeReviewResults([
      review({ stepComplete: true, planStale: false }),
      review({ stepComplete: false, planStale: false }),
    ]);
    assert.equal(merged2.stepComplete, false);
    assert.equal(merged2.planStale, false);
  });

  it("empty results never claim a step complete", () => {
    const merged = mergeReviewResults([]);
    assert.equal(merged.stepComplete, false);
    assert.equal(merged.planStale, false);
  });
});
