import test from "node:test";
import assert from "node:assert";
import { computeThinkingLevels } from "./register.js";

const canonicalLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

test("computeThinkingLevels returns only off for non-reasoning models", () => {
  assert.deepStrictEqual(computeThinkingLevels({ reasoning: false }, canonicalLevels), ["off"]);
});

test("computeThinkingLevels falls back to canonical list when no map is provided", () => {
  assert.deepStrictEqual(computeThinkingLevels({}, canonicalLevels), canonicalLevels);
  assert.deepStrictEqual(computeThinkingLevels({ reasoning: true }, canonicalLevels), canonicalLevels);
  assert.deepStrictEqual(computeThinkingLevels(undefined, canonicalLevels), canonicalLevels);
});

test("computeThinkingLevels filters to advertised non-null levels plus off", () => {
  const modelDetails = {
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    } as Record<string, string | null>,
  };
  assert.deepStrictEqual(computeThinkingLevels(modelDetails, canonicalLevels), ["off", "minimal", "low", "high"]);
});

test("computeThinkingLevels returns only off when every non-off level is unsupported", () => {
  const modelDetails = {
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    } as Record<string, string | null>,
  };
  assert.deepStrictEqual(computeThinkingLevels(modelDetails, canonicalLevels), ["off"]);
});
