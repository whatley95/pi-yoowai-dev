import { resolveModelInfo } from "./model-registry.js";
import type { HeyyooConfig } from "./types.js";

export interface ReviewBudget {
  contextWindow: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  availableInputTokens: number;
  hardInputCap?: number;
}

// Rough estimate: ~4 chars per token for English/code.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function calculateReviewBudget(
  provider: string,
  model: string,
  config: HeyyooConfig,
  fixedPromptParts: {
    systemPrompt: string;
    sessionContext: string;
    conventionsText: string;
    preReviewOutput: string;
    description: string;
    memoryContext: string;
  },
): ReviewBudget {
  const info = resolveModelInfo(provider, model, {
    contextWindow: config.secondary.contextWindow,
    maxOutputTokens: config.secondary.maxOutputTokens,
  });

  const reservedOutputTokens = resolveOutputTokens(info.maxOutputTokens, config.secondary.thinking);
  const safetyMarginTokens = Math.ceil(info.contextWindow * 0.1);
  const fixedTokens =
    estimateTokens(fixedPromptParts.systemPrompt) +
    estimateTokens(fixedPromptParts.sessionContext) +
    estimateTokens(fixedPromptParts.conventionsText) +
    estimateTokens(fixedPromptParts.preReviewOutput) +
    estimateTokens(fixedPromptParts.description) +
    estimateTokens(fixedPromptParts.memoryContext);

  const availableInputTokens = Math.max(
    0,
    info.contextWindow - reservedOutputTokens - safetyMarginTokens - fixedTokens,
  );

  return {
    contextWindow: info.contextWindow,
    reservedOutputTokens,
    safetyMarginTokens,
    availableInputTokens,
    hardInputCap: config.reviewMaxInputTokens,
  };
}

function resolveOutputTokens(maxOutputTokens: number, thinking?: string): number {
  // When reasoning is enabled, the model needs headroom for both reasoning and visible output.
  if (!thinking || thinking === "off") return Math.min(maxOutputTokens, 2048);
  return Math.min(maxOutputTokens, 8192);
}

export function clampToBudget(actualTokens: number, budget: ReviewBudget): number {
  const cap = budget.hardInputCap ?? budget.availableInputTokens;
  return Math.min(actualTokens, cap);
}
