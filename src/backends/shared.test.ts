import { it } from "node:test";
import assert from "node:assert/strict";
import { applyReportedUsage, buildUsage } from "./shared.js";

it("uses valid reported costs, including zero, and falls back only for missing or invalid costs", () => {
  const estimate = buildUsage("openai", "gpt-4o-mini", "system", "user", "answer");
  assert.equal(applyReportedUsage("openai", "gpt-4o-mini", estimate, 100, 10, 12.34).estimatedCostUsd, 12.34);
  assert.equal(applyReportedUsage("openai", "gpt-4o-mini", estimate, 100, 10, 0).estimatedCostUsd, 0);
  for (const cost of [undefined, null, -1, NaN, Infinity, "12.34"]) {
    assert.ok(applyReportedUsage("openai", "gpt-4o-mini", estimate, 100, 10, cost).estimatedCostUsd > 0);
  }
  const invalid = applyReportedUsage("openai", "gpt-4o-mini", estimate, -1, NaN, Infinity);
  assert.equal(invalid.estimatedInputTokens, estimate.estimatedInputTokens);
  assert.equal(invalid.estimatedOutputTokens, estimate.estimatedOutputTokens);
});
