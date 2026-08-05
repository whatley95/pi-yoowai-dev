export interface ModelInfo {
  contextWindow: number;
  maxOutputTokens: number;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_OUTPUT_TOKENS = 8192;

// Approximate context windows and output limits for common models.
// These are best-effort; users can override via config.
const KNOWN_MODELS: Record<string, ModelInfo> = {
  // Anthropic
  "claude-3-5-sonnet": { contextWindow: 200_000, maxOutputTokens: 8192 },
  "claude-sonnet-4-5": { contextWindow: 200_000, maxOutputTokens: 8192 },
  "claude-3-opus": { contextWindow: 200_000, maxOutputTokens: 4096 },
  "claude-opus-4-5": { contextWindow: 200_000, maxOutputTokens: 4096 },
  "claude-3-haiku": { contextWindow: 200_000, maxOutputTokens: 4096 },

  // OpenAI
  "gpt-4o": { contextWindow: 128_000, maxOutputTokens: 16_384 },
  "gpt-4o-mini": { contextWindow: 128_000, maxOutputTokens: 16_384 },
  "gpt-5": { contextWindow: 128_000, maxOutputTokens: 16_384 },
  "gpt-5-mini": { contextWindow: 128_000, maxOutputTokens: 16_384 },
  o1: { contextWindow: 200_000, maxOutputTokens: 100_000 },
  "o1-mini": { contextWindow: 128_000, maxOutputTokens: 65_536 },
  o3: { contextWindow: 200_000, maxOutputTokens: 100_000 },
  "o3-mini": { contextWindow: 200_000, maxOutputTokens: 100_000 },
  o4: { contextWindow: 200_000, maxOutputTokens: 100_000 },
  "o4-mini": { contextWindow: 200_000, maxOutputTokens: 100_000 },

  // DeepSeek
  "deepseek-chat": { contextWindow: 64_000, maxOutputTokens: 8192 },
  "deepseek-reasoner": { contextWindow: 64_000, maxOutputTokens: 8192 },
  "deepseek-v4-pro": { contextWindow: 64_000, maxOutputTokens: 16_384 },
  "deepseek-v4-flash": { contextWindow: 64_000, maxOutputTokens: 16_384 },
  "deepseek-v3": { contextWindow: 64_000, maxOutputTokens: 8192 },

  // OpenCode Go
  "glm-5.2": { contextWindow: 128_000, maxOutputTokens: 8192 },
  "glm-5.1": { contextWindow: 128_000, maxOutputTokens: 8192 },
  "kimi-k2.7-code": { contextWindow: 256_000, maxOutputTokens: 16_384 },
  "kimi-k2.6": { contextWindow: 256_000, maxOutputTokens: 16_384 },
  "mimo-v2.5-pro": { contextWindow: 128_000, maxOutputTokens: 8192 },
  "mimo-v2.5": { contextWindow: 128_000, maxOutputTokens: 8192 },
  "qwen3.7-max": { contextWindow: 128_000, maxOutputTokens: 8192 },
  "qwen3.7-plus": { contextWindow: 128_000, maxOutputTokens: 8192 },
  "qwen3.6-plus": { contextWindow: 128_000, maxOutputTokens: 8192 },
  "minimax-m2.7": { contextWindow: 128_000, maxOutputTokens: 8192 },
  "minimax-m3": { contextWindow: 128_000, maxOutputTokens: 8192 },

  // Google
  "gemini-1.5-pro": { contextWindow: 2_000_000, maxOutputTokens: 8192 },
  "gemini-1.5-flash": { contextWindow: 1_000_000, maxOutputTokens: 8192 },
  "gemini-2.0-flash": { contextWindow: 1_000_000, maxOutputTokens: 8192 },
  "gemini-2.5-pro": { contextWindow: 1_000_000, maxOutputTokens: 8192 },

  // OpenRouter / Together common aliases
  "claude-3.5-sonnet": { contextWindow: 200_000, maxOutputTokens: 8192 },
  "anthropic/claude-3.5-sonnet": { contextWindow: 200_000, maxOutputTokens: 8192 },
  "google/gemma-4-31b-it": { contextWindow: 128_000, maxOutputTokens: 8192 },
  "meta-llama/llama-3.3-70b-instruct": { contextWindow: 131_072, maxOutputTokens: 8192 },
  "deepseek/deepseek-r1": { contextWindow: 64_000, maxOutputTokens: 8192 },
};

import type { ReviewLevel } from "./types.js";

/** Default review depth for known model families. Unknown models fall back to "med". */
const DEFAULT_REVIEW_LEVELS: Record<string, ReviewLevel> = {
  // Anthropic — high-end reasoning models
  "claude-opus": "high",
  "claude-sonnet-4-5": "high",
  "claude-3-opus": "high",
  "claude-3-5-sonnet": "med",
  "claude-3-haiku": "min",

  // OpenAI
  "gpt-5": "high",
  "gpt-5-mini": "min",
  "gpt-4o": "med",
  "gpt-4o-mini": "min",
  o1: "high",
  "o1-mini": "min",
  o3: "high",
  "o3-mini": "min",
  o4: "high",
  "o4-mini": "min",

  // DeepSeek
  "deepseek-reasoner": "high",
  "deepseek-v4-pro": "high",
  "deepseek-v4-flash": "min",
  "deepseek-v3": "med",
  "deepseek-chat": "med",

  // OpenCode Go
  "glm-5.2": "med",
  "glm-5.1": "med",
  "kimi-k2.7-code": "high",
  "kimi-k2.6": "med",
  "mimo-v2.5-pro": "med",
  "mimo-v2.5": "min",
  "qwen3.7-max": "med",
  "qwen3.7-plus": "med",
  "qwen3.6-plus": "min",
  "minimax-m3": "med",
  "minimax-m2.7": "min",

  // Google
  "gemini-2.5-pro": "high",
  "gemini-2.0-flash": "med",
  "gemini-1.5-pro": "med",
  "gemini-1.5-flash": "min",

  // OpenRouter / Together aliases
  "anthropic/claude-opus": "high",
  "anthropic/claude-3.5-sonnet": "med",
  "deepseek/deepseek-r1": "high",
  "google/gemma-4-31b-it": "min",
  "meta-llama/llama-3.3-70b-instruct": "med",
};

export function getDefaultReviewLevel(provider: string, model: string): ReviewLevel {
  const key = `${provider}:${model}`.toLowerCase();
  const modelKey = model.toLowerCase();

  const exact = DEFAULT_REVIEW_LEVELS[key] ?? DEFAULT_REVIEW_LEVELS[modelKey];
  if (exact) return exact;

  // Longest-prefix match so "gpt-4o-mini" resolves before "gpt-4o".
  let best: { prefix: string; level: ReviewLevel } | undefined;
  for (const [prefix, level] of Object.entries(DEFAULT_REVIEW_LEVELS)) {
    if (modelKey.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, level };
    }
  }
  return best?.level ?? "med";
}

export function resolveModelInfo(provider: string, model: string, override?: Partial<ModelInfo>): ModelInfo {
  const key = `${provider}:${model}`.toLowerCase();
  const modelKey = model.toLowerCase();

  const known = KNOWN_MODELS[key] ?? KNOWN_MODELS[modelKey] ?? matchKnownPrefix(modelKey);

  return {
    contextWindow: override?.contextWindow ?? known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: override?.maxOutputTokens ?? known?.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
  };
}

function matchKnownPrefix(modelKey: string): ModelInfo | undefined {
  let best: { name: string; info: ModelInfo } | undefined;
  for (const [name, info] of Object.entries(KNOWN_MODELS)) {
    if (modelKey.startsWith(name) && (!best || name.length > best.name.length)) {
      best = { name, info };
    }
  }
  return best?.info;
}
