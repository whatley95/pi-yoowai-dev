import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateReviewBudget, estimateTokens, tokenBudgetChars, truncateToTokenBudget } from "./token-budget.js";
import { estimateTokens as estimateBackendTokens } from "./backends/shared.js";
import type { YoowaiConfig } from "./types.js";

describe("token budget", () => {
  const baseConfig: YoowaiConfig = {
    secondary: { provider: "openai", id: "gpt-4o", thinking: "medium" },
    autoJudge: false,
    preReviewCommands: [],
  };

  it("estimates tokens from text length", () => {
    assert.equal(estimateTokens("abcd"), 2);
    assert.equal(estimateTokens("abcdefgh"), 3);
    assert.equal(estimateTokens("x".repeat(35000)), 10000);
    assert.equal(estimateBackendTokens("x".repeat(35000)), 10000);
  });

  it("keeps character conversion and truncation, including its marker, within the token cap", () => {
    for (const budget of [0, 1, 1.5, 2, 10, 21]) {
      assert.ok(estimateTokens("x".repeat(tokenBudgetChars(budget))) <= budget);
      assert.ok(estimateTokens(truncateToTokenBudget("x".repeat(1000), budget)) <= budget);
    }
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

  it("reserves the actual structured output limit even with thinking off", () => {
    const parts = {
      systemPrompt: "",
      sessionContext: "",
      conventionsText: "",
      preReviewOutput: "",
      description: "",
      memoryContext: "",
    };
    for (const thinking of ["off", "xhigh"]) {
      const budget = calculateReviewBudget("openai", "example", baseConfig, parts, {
        contextWindow: 400000,
        maxOutputTokens: 128000,
        thinking,
      });
      assert.equal(budget.reservedOutputTokens, 128000);
      assert.equal(budget.availableInputTokens, 232000);
    }
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
