import { it } from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import { getNativeOutputSchema } from "./native-output-schemas.js";

it("exposes typed structured fields for every registered tool, including error-only results", () => {
  assert.ok(Value.Check(getNativeOutputSchema("wai"), { action: "judge", skipped: true, skipReason: "Empty council" }));
  assert.equal(Value.Check(getNativeOutputSchema("wai"), { skipped: "true" }), false);
  const examples: Record<string, unknown> = {
    wai: {
      action: "review",
      levelSelection: { level: "high", source: "risk", reason: "Sensitive source path" },
      review: { verdict: "needs-work", inconclusive: true, scopeLimited: false },
      recovery: { reason: "empty-diff", message: "empty", nextAction: "inspect", retry: "after-change" },
      workflow: { completedSteps: 0, totalSteps: 2, pendingEdits: 1, reviewPending: true },
    },
    wai_review_min: { review: { verdict: "pass", scopeLimited: true } },
    wai_review_med: { review: { verdict: "blocked", inputIncomplete: true } },
    wai_review_high: { review: { verdict: "needs-work", checksFailed: true } },
    wai_index: {
      topic: "memory",
      memoryEntries: [
        { file: "a.ts", issues: [{ severity: "high", issue: "race", suggestion: "lock", timestamp: "now" }] },
      ],
      selection: { memory: { matched: 3, returned: 1 } },
    },
    wai_explain: { explain: { summary: "s", details: "d" } },
    wai_vision: { vision: { summary: "s", details: "d", imagePath: "inline image", mimeType: "image/png" } },
    wai_learn: { learned: [{ fact: "fact", timestamp: "now", source: "a.ts" }] },
    wai_scaffold: {
      mode: "preview",
      files: [{ target: "skill", path: "SKILL.md", action: "preview", unresolvedCount: 0, fillMeCount: 0 }],
    },
    wai_design_ref: { topic: "animation", doc: "SKILL.md", content: "rules" },
  };
  for (const [name, example] of Object.entries(examples)) {
    const schema = getNativeOutputSchema(name);
    assert.ok(Value.Check(schema, example), JSON.stringify([...Value.Errors(schema, example)]));
    assert.ok(Value.Check(schema, { error: "provider failed", futureMetadata: true }));
  }
  assert.equal(Value.Check(getNativeOutputSchema("wai"), { review: { inconclusive: "yes" } }), false);
  assert.equal(
    Value.Check(getNativeOutputSchema("wai"), { levelSelection: { level: "auto", source: "risk", reason: "x" } }),
    false,
  );
  assert.equal(
    Value.Check(getNativeOutputSchema("wai"), { levelSelection: { level: "med", source: "model", reason: "x" } }),
    false,
  );
  assert.equal(Value.Check(getNativeOutputSchema("wai_index"), { memoryEntries: [{ file: 3 }] }), false);
  assert.ok(
    Value.Check(getNativeOutputSchema("wai_index"), {
      topic: "cost",
      cost: { calls: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.01, updatedAt: "now" },
    }),
  );
  assert.equal(
    Value.Check(getNativeOutputSchema("wai"), {
      workflow: { completedSteps: 0, totalSteps: 1, pendingEdits: 0, reviewPending: "yes" },
    }),
    false,
  );
});
