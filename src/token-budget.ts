import { resolveModelInfo } from "./model-registry.js";
import type { YoowaiConfig, SecondaryModelConfig } from "./types.js";

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

export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const maxChars = maxTokens * 4;
  return text.slice(0, maxChars) + "\n… (truncated to token budget)";
}

export function calculateReviewBudget(
  provider: string,
  model: string,
  config: YoowaiConfig,
  fixedPromptParts: {
    systemPrompt: string;
    sessionContext: string;
    conventionsText: string;
    preReviewOutput: string;
    description: string;
    memoryContext: string;
  },
  modelConfig?: Partial<Pick<SecondaryModelConfig, "contextWindow" | "maxOutputTokens" | "thinking">>,
): ReviewBudget {
  const override = modelConfig ?? config.secondary;
  const info = resolveModelInfo(provider, model, {
    contextWindow: override.contextWindow,
    maxOutputTokens: override.maxOutputTokens,
  });

  const reservedOutputTokens = resolveOutputTokens(info.maxOutputTokens, override.thinking);
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
