import test from "node:test";
import assert from "node:assert";
import { formatDuration, formatResultText } from "./format.js";
import type { WaiToolResult } from "./types.js";

const sampleCost = {
  estimatedInputTokens: 12300,
  estimatedOutputTokens: 4100,
  estimatedCostUsd: 0.0216,
  sessionCostUsd: 0.1616,
};

function recommendResult(overrides: Partial<WaiToolResult>): WaiToolResult {
  return {
    action: "recommend",
    recommend: {
      nextStep: "Extract the handler",
      reasoning: "It reduces risk",
      alternatives: [],
    },
    ...overrides,
  };
}

test("formatDuration renders milliseconds under one second", () => {
  assert.strictEqual(formatDuration(0), "0ms");
  assert.strictEqual(formatDuration(500), "500ms");
  assert.strictEqual(formatDuration(999), "999ms");
});

test("formatDuration renders one-decimal seconds at one second or more", () => {
  assert.strictEqual(formatDuration(1000), "1.0s");
  assert.strictEqual(formatDuration(8423), "8.4s");
  assert.strictEqual(formatDuration(12500), "12.5s");
});

test("formatDuration guards invalid input", () => {
  assert.strictEqual(formatDuration(-5), "0ms");
  assert.strictEqual(formatDuration(Number.NaN), "0ms");
});

test("formatResultText omits elapsed when not present (byte-identical baseline)", () => {
  const text = formatResultText(recommendResult({ cost: sampleCost }));
  assert.ok(text.includes("in ·"));
  assert.ok(!text.includes("took "));
});

test("formatResultText appends elapsed to the cost line when both present", () => {
  const text = formatResultText(recommendResult({ cost: sampleCost, elapsedMs: 8423 }));
  assert.ok(text.includes("took 8.4s"));
  assert.ok(text.startsWith("_"));
});

test("formatResultText shows elapsed as a standalone line when cost is absent", () => {
  const text = formatResultText(recommendResult({ elapsedMs: 423 }));
  assert.ok(text.includes("took 423ms"));
  assert.ok(!text.includes("in ·"));
});

test("formatResultText renders done verification failure", () => {
  const text = formatResultText({
    action: "done",
    done: {
      completedStep: 0,
      totalSteps: 3,
      allDone: false,
      verified: false,
      verificationReason: "missing styles",
      message: "Step 1 does not appear to be complete.",
    },
  });
  assert.ok(text.includes("Verification failed"));
  assert.ok(text.includes("missing styles"));
});

test("formatResultText renders judge unreviewed-edits warning", () => {
  const text = formatResultText({
    action: "judge",
    judge: {
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
      summary: "Looks good",
      unreviewedEdits: true,
    },
  });
  assert.ok(text.includes("Unreviewed edits"));
});

test("formatResultText renders judge plan-update suggestion", () => {
  const text = formatResultText({
    action: "judge",
    judge: {
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
      summary: "Looks good",
      planUpdateSuggested: true,
      planUpdateReason: "plan describes old API",
    },
  });
  assert.ok(text.includes("Plan stale"));
  assert.ok(text.includes("old API"));
  assert.ok(text.includes("wai-plan-update"));
});

test("formatResultText renders review fix plan", () => {
  const text = formatResultText({
    action: "review",
    review: {
      verdict: "needs-work",
      issues: [
        { severity: "medium", file: "src/a.ts", line: 5, issue: "bad name", suggestion: "rename to foo" },
        { severity: "low", file: "src/b.ts", issue: "typo", suggestion: "fix spelling" },
      ],
      suggestions: [],
      consensus: false,
      fixPlan: ["Fix medium issue in `src/a.ts:5`: rename to foo", "Fix low issue in `src/b.ts`: fix spelling"],
    },
  });
  assert.ok(text.includes("Suggested fix plan"));
  assert.ok(text.includes("rename to foo"));
  assert.ok(text.includes("fix spelling"));
});

test("formatResultText renders stitched continuation", () => {
  const text = formatResultText(recommendResult({ cost: sampleCost, continuation: { rounds: 2, status: "stitched" } }));
  assert.ok(text.includes("✓ stitched (2 rounds)"));
});

test("formatResultText renders truncated-after-cap with round count", () => {
  const text = formatResultText(
    recommendResult({ cost: sampleCost, continuation: { rounds: 3, status: "truncated-after-cap" } }),
  );
  assert.ok(text.includes("⚠ truncated after cap (3 rounds)"));
});

test("formatResultText omits round count for truncated-after-cap with zero rounds", () => {
  const text = formatResultText(
    recommendResult({ cost: sampleCost, continuation: { rounds: 0, status: "truncated-after-cap" } }),
  );
  assert.ok(text.includes("⚠ truncated after cap"));
  assert.ok(!text.includes("(0 rounds)"));
});
