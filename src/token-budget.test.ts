import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateReviewBudget, estimateTokens, truncateToTokenBudget } from "./token-budget.js";
import type { YoowaiConfig } from "./types.js";

describe("token budget", () => {
  const baseConfig: YoowaiConfig = {
    secondary: { provider: "openai", id: "gpt-4o", thinking: "medium" },
    autoJudge: false,
    preReviewCommands: [],
  };

  it("estimates tokens from text length", () => {
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcdefgh"), 2);
  });

  it("reserves output and safety margin", () => {
    const budget = calculateReviewBudget("openai", "gpt-4o", baseConfig, {
      systemPrompt: "",
      sessionContext: "",
      conventionsText: "",
      preReviewOutput: "",
      description: "",
      memoryContext: "",
    });
    assert.equal(budget.contextWindow, 128_000);
    assert.ok(budget.reservedOutputTokens > 0);
    assert.ok(budget.safetyMarginTokens > 0);
    assert.ok(budget.availableInputTokens > 0);
    assert.ok(budget.availableInputTokens < budget.contextWindow);
  });

  it("honors hard input cap", () => {
    const config: YoowaiConfig = { ...baseConfig, reviewMaxInputTokens: 1000 };
    const budget = calculateReviewBudget("openai", "gpt-4o", config, {
      systemPrompt: "",
      sessionContext: "",
      conventionsText: "",
      preReviewOutput: "",
      description: "",
      memoryContext: "",
    });
    assert.equal(budget.hardInputCap, 1000);
  });

  it("uses per-task model overrides for context window and output tokens", () => {
    const budget = calculateReviewBudget(
      "openai",
      "gpt-4o",
      baseConfig,
      {
        systemPrompt: "",
        sessionContext: "",
        conventionsText: "",
        preReviewOutput: "",
        description: "",
        memoryContext: "",
      },
      { contextWindow: 32_000, maxOutputTokens: 4096, thinking: "xhigh" },
    );
    assert.equal(budget.contextWindow, 32_000);
    assert.equal(budget.reservedOutputTokens, 4096);
  });

  it("truncates text to token budget", () => {
    const long = "a".repeat(1000);
    const truncated = truncateToTokenBudget(long, 10);
    assert.ok(truncated.length < long.length);
    assert.match(truncated, /\(truncated to token budget\)/);
  });
});
