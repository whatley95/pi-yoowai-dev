import type { UsageCost } from "../types.js";
import type { AssistantMessageLike, ContentPart, PiProcessResult } from "../types/secondary-model.js";

export function estimateCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
  // Approximate cost per 1M tokens in USD. These are rough averages.
  const key = `${provider}:${model}`.toLowerCase();
  const rates: Record<string, { input: number; output: number }> = {
    // OpenCode Go rates derived from actual dashboard usage:
    // glm-5.2 ~$2/M in · $3/M out, qwen3.7-plus ~$0.5/M in · $1.5/M out,
    // qwen3.7-max ~$3/M in · $6/M out, deepseek-v4-pro ~$2/M in · $3/M out.
    "opencode-go": { input: 2.0, output: 3.0 },
    "opencode-go:deepseek-v4-pro": { input: 2.0, output: 3.0 },
    "opencode-go:deepseek-v4-flash": { input: 0.5, output: 1.5 },
    "opencode-go:glm-5.2": { input: 2.0, output: 4.0 },
    "opencode-go:glm-5.1": { input: 2.0, output: 4.0 },
    "opencode-go:qwen3.7-max": { input: 3.0, output: 6.0 },
    "opencode-go:qwen3.7-plus": { input: 0.5, output: 1.5 },
    "opencode-go:qwen3.6-plus": { input: 0.5, output: 1.5 },
    "opencode-go:kimi-k2.7-code": { input: 2.0, output: 6.0 },
    "opencode-go:kimi-k2.6": { input: 2.0, output: 6.0 },
    "opencode-go:mimo-v2.5-pro": { input: 1.0, output: 3.0 },
    "opencode-go:mimo-v2.5": { input: 1.0, output: 3.0 },
    "opencode-go:minimax-m2.7": { input: 1.0, output: 3.0 },
    "opencode-go:minimax-m3": { input: 1.0, output: 3.0 },
    // OpenCode Zen (full model list) is typically more expensive than Go.
    opencode: { input: 3.0, output: 9.0 },
    deepseek: { input: 0.3, output: 1.0 },
    "deepseek:deepseek-chat": { input: 0.14, output: 0.28 },
    "deepseek:deepseek-reasoner": { input: 0.55, output: 2.19 },
    "deepseek:deepseek-v3": { input: 0.14, output: 0.28 },
    anthropic: { input: 3.0, output: 15.0 },
    "anthropic:claude-sonnet-4-5": { input: 3.0, output: 15.0 },
    "anthropic:claude-opus-4-5": { input: 15.0, output: 75.0 },
    "anthropic:claude-3-5-sonnet": { input: 3.0, output: 15.0 },
    "anthropic:claude-3-7-sonnet": { input: 3.0, output: 15.0 },
    "anthropic:claude-3-opus": { input: 15.0, output: 75.0 },
    "anthropic:claude-3-haiku": { input: 0.25, output: 1.25 },
    openai: { input: 2.5, output: 10.0 },
    "openai:gpt-5": { input: 5.0, output: 15.0 },
    "openai:gpt-5-mini": { input: 0.5, output: 1.5 },
    "openai:gpt-4o": { input: 2.5, output: 10.0 },
    "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
    "openai:gpt-4.5": { input: 5.0, output: 15.0 },
    "openai:gpt-4.5-preview": { input: 5.0, output: 15.0 },
    "openai:o1": { input: 15.0, output: 60.0 },
    "openai:o1-mini": { input: 1.1, output: 4.4 },
    "openai:o3": { input: 10.0, output: 40.0 },
    "openai:o3-mini": { input: 1.1, output: 4.4 },
    "openai:o4": { input: 10.0, output: 40.0 },
    "openai:o4-mini": { input: 1.5, output: 6.0 },
    openrouter: { input: 2.0, output: 6.0 },
    "openrouter:deepseek/deepseek-r1": { input: 0.55, output: 2.19 },
    "openrouter:anthropic/claude-3.5-sonnet": { input: 3.0, output: 15.0 },
    "openrouter:openai/gpt-4o": { input: 2.5, output: 10.0 },
    groq: { input: 0.6, output: 0.8 },
    "groq:llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
    "groq:llama-3.1-70b-versatile": { input: 0.59, output: 0.79 },
    "groq:mixtral-8x7b-32768": { input: 0.24, output: 0.24 },
    mistral: { input: 2.0, output: 6.0 },
    "mistral:mistral-large": { input: 2.0, output: 6.0 },
    "mistral:mistral-medium": { input: 2.7, output: 8.1 },
    "mistral:mistral-small": { input: 1.0, output: 3.0 },
    xai: { input: 2.0, output: 10.0 },
    "xai:grok-2": { input: 2.0, output: 10.0 },
    "xai:grok-3": { input: 3.0, output: 15.0 },
    together: { input: 0.9, output: 0.9 },
    "together:meta-llama/Llama-3.3-70B-Instruct-Turbo": { input: 0.88, output: 0.88 },
    fireworks: { input: 0.5, output: 1.5 },
    cerebras: { input: 0.6, output: 0.6 },
    "cerebras:llama-3.3-70b": { input: 0.6, output: 0.6 },
    google: { input: 1.0, output: 4.0 },
    "google:gemini-1.5-pro": { input: 1.25, output: 5.0 },
    "google:gemini-1.5-flash": { input: 0.075, output: 0.3 },
    "google:gemini-2.0-flash": { input: 0.1, output: 0.4 },
    "google:gemini-2.5-pro": { input: 1.25, output: 10.0 },
  };
  const rate = rates[key] ?? rates[provider] ?? { input: 2.0, output: 6.0 };
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

export function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English/code
  return Math.ceil(text.length / 4);
}

export function buildUsage(
  provider: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  content: string,
): UsageCost {
  const estimatedInputTokens = estimateTokens(systemPrompt + userPrompt);
  const estimatedOutputTokens = estimateTokens(content);
  const estimatedCostUsd = estimateCost(provider, model, estimatedInputTokens, estimatedOutputTokens);
  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUsd,
    sessionCostUsd: 0,
  };
}

export function applyReportedUsage(
  provider: string,
  model: string,
  usage: UsageCost,
  inputTokens: unknown,
  outputTokens: unknown,
): UsageCost {
  const inTokens =
    typeof inputTokens === "number" && Number.isFinite(inputTokens) ? inputTokens : usage.estimatedInputTokens;
  const outTokens =
    typeof outputTokens === "number" && Number.isFinite(outputTokens) ? outputTokens : usage.estimatedOutputTokens;
  return {
    ...usage,
    estimatedInputTokens: inTokens,
    estimatedOutputTokens: outTokens,
    estimatedCostUsd: estimateCost(provider, model, inTokens, outTokens),
  };
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const textParts: string[] = [];
  const fallbackParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const typed = part as ContentPart;
    if (typed.type === "text" && typeof typed.text === "string") {
      textParts.push(typed.text);
    }
    // Some high-thinking models (e.g. qwen3.7-max on opencode-go) return only
    // thinking/reasoning blocks. Collect them as a fallback when no real text
    // is available; accept any object with a thinking string, not only type==="thinking".
    if (typeof typed.thinking === "string") {
      fallbackParts.push(typed.thinking);
    }
  }
  const joinedText = textParts.join("\n").trim();
  return joinedText.length > 0 ? joinedText : fallbackParts.join("\n").trim();
}

export type { AssistantMessageLike, ContentPart, PiProcessResult };
