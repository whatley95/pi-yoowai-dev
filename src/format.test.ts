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

test("review execution distinguishes model rounds, local context, and summed worker time", () => {
  const text = formatResultText({
    action: "review",
    execution: {
      batches: 4,
      segments: 3,
      modelCalls: 6,
      contextRequests: 2,
      modelTimeMs: 120000,
      contextTimeMs: 40,
      verificationTimeMs: 8000,
    },
  });
  assert.match(text, /6 model rounds/);
  assert.match(text, /2 context requests/);
  assert.match(text, /Time across workers/);
  assert.match(text, /local context 40ms/);
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

test("disabled council renders skipped without a passing verdict", () => {
  const text = formatResultText({ action: "judge", skipped: true, skipReason: "Council is empty." });
  assert.match(text, /skipped/);
  assert.match(text, /Council is empty/);
  assert.ok(!text.includes("✓"));
  assert.ok(!text.includes("pass"));
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
  assert.ok(!text.includes("The code is trusted"));
  assert.ok(!text.includes("wai-clear"));
});

test("formatResultText shows the review level in the header when set", () => {
  const text = formatResultText({
    action: "review",
    level: "med",
    review: {
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
    },
  });
  assert.ok(text.includes("## wai review (med) ✓ pass"), text);
});

test("formatResultText omits the review level marker when absent", () => {
  const text = formatResultText({
    action: "review",
    review: {
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
    },
  });
  assert.ok(text.includes("## wai review ✓ pass"), text);
  assert.ok(!text.includes("(med)"), text);
});

test("formatResultText explains the min-level context cap on truncated reviews", () => {
  const text = formatResultText({
    action: "review",
    level: "min",
    review: {
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
      truncated: true,
      contextLimited: true,
      droppedFiles: ["src/a.ts"],
    },
  });
  assert.ok(text.includes("Large change"), text);
  assert.ok(text.includes("Review (min) could not obtain complete evidence"), text);
  assert.ok(text.includes("reviewMaxDiffChars"), text);
  assert.ok(text.includes("cannot enlarge the model's context window"), text);
});

test("formatResultText explains the generic cap for med-level truncated reviews", () => {
  const text = formatResultText({
    action: "review",
    level: "med",
    review: {
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
      truncated: true,
    },
  });
  assert.ok(text.includes("Large change"), text);
  assert.ok(text.includes("explicit configured cap"), text);
  assert.ok(!text.includes("ran at level"), text);
});

test("formatResultText explains the high-level truncation without level caps", () => {
  const text = formatResultText({
    action: "review",
    level: "high",
    review: {
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
      truncated: true,
    },
  });
  assert.ok(text.includes("Review (high) could not obtain complete evidence"), text);
  assert.ok(text.includes("/wai-logs"), text);
  assert.ok(!text.includes("wai_review_high"), text);
  assert.ok(!text.includes("12,000 chars"), text);
});

test("formatResultText explains the generic cap for truncated judge results", () => {
  const text = formatResultText({
    action: "judge",
    judge: {
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
      summary: "ok",
      truncated: true,
      contextLimited: true,
    },
  });
  assert.ok(text.includes("Large change"), text);
  assert.ok(text.includes("exceeded the configured context limits"), text);
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

test("formatResultText renders suggestion disposition directive", () => {
  const text = formatResultText({
    action: "review",
    review: {
      verdict: "pass",
      issues: [],
      suggestions: ["Extract the retry loop into a helper"],
      consensus: true,
    },
  });
  assert.ok(text.includes("### Suggestions"));
  assert.ok(text.includes("either implement it or reply with a one-line reason for skipping it"));
});

test("formatResultText omits suggestion directive when there are no suggestions", () => {
  const text = formatResultText({
    action: "review",
    review: {
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
    },
  });
  assert.ok(!text.includes("reason for skipping it"));
});

test("formatResultText renders inconclusive review guidance instead of a fix action", () => {
  const text = formatResultText({
    action: "review",
    review: {
      verdict: "needs-work",
      issues: [],
      suggestions: [],
      consensus: false,
      inconclusive: true,
    },
  });
  assert.ok(text.includes("Inconclusive"));
  assert.match(text, /wai review ⚠ inconclusive/);
  assert.ok(text.includes("re-run `wai.review`"));
  assert.ok(!text.includes("Fix the issues above"));
  assert.match(text, /Check diagnostics, the working directory/);
  assert.match(text, /input\/output truncation/);
  assert.match(text, /report the blocker/);
  assert.doesNotMatch(text, /lower the thinking level|the re-run should pass/);
});

test("formatResultText explains that a scoped pass cannot clear the done gate", () => {
  const text = formatResultText({
    action: "review",
    review: { verdict: "pass", issues: [], suggestions: [], consensus: true, scopeLimited: true },
  });
  assert.match(text, /Scoped review.*does not clear the whole-tree review gate/);
  assert.match(text, /whole-tree certification is still pending/);
  assert.doesNotMatch(text, /step is complete/);
  assert.doesNotMatch(text, /call `wai.done` with those step numbers/);
  assert.match(text, /complete whole-tree review before certifying/);
});

test("formatResultText directs a whole-tree pass to inspect progress before considering done", () => {
  const text = formatResultText({
    action: "review",
    review: {
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
      planProgress: "1/2 steps done",
      nextStep: "Step 2",
    },
  });
  assert.match(text, /Progress:.*1\/2 steps done/);
  assert.match(text, /only if the same reviewed step remains current/);
  assert.match(text, /do not advance an unfinished next step/);
  assert.doesNotMatch(text, /step is complete|call `wai.done` with those step numbers/);
});

test("formatResultText gives VCS guidance when review input is incomplete", () => {
  const text = formatResultText({
    action: "review",
    review: {
      verdict: "needs-work",
      issues: [],
      suggestions: [],
      consensus: false,
      inconclusive: true,
      inputIncomplete: true,
    },
  });
  assert.match(text, /Review input incomplete.*did not run a model review/);
  assert.doesNotMatch(text, /lower the thinking level/);
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
