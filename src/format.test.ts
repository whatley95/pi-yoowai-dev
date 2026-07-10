import test from "node:test";
import assert from "node:assert";
import { formatDuration, formatResultText } from "./format.js";
import type { YooToolResult } from "./types.js";

const sampleCost = {
  estimatedInputTokens: 12300,
  estimatedOutputTokens: 4100,
  estimatedCostUsd: 0.0216,
  sessionCostUsd: 0.1616,
};

function recommendResult(overrides: Partial<YooToolResult>): YooToolResult {
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
