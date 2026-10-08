import { resolveModelInfo } from "./model-registry.js";
import type { YoowaiConfig, SecondaryModelConfig } from "./types.js";

export interface ReviewBudget {
  contextWindow: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  availableInputTokens: number;
  hardInputCap?: number;
}

// Match Pi 1.1's conservative English/code estimate, including on older hosts.
export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function tokenBudgetChars(maxTokens: number): number {
  return Math.max(0, Math.floor(Math.floor(maxTokens) * CHARS_PER_TOKEN));
}

export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const maxChars = tokenBudgetChars(maxTokens);
  const marker = "\n… (truncated to token budget)";
  return (text.slice(0, Math.max(0, maxChars - marker.length)) + marker).slice(0, maxChars);
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

  // Reviews are structured-output requests: SDK and HTTP both permit the
  // resolved output limit, including reasoning. Reserve that same limit.
  const reservedOutputTokens = info.maxOutputTokens;
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
