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
  "deepseek-v4-pro": { contextWindow: 64_000, maxOutputTokens: 8192 },
  "deepseek-v4-flash": { contextWindow: 64_000, maxOutputTokens: 8192 },
  "deepseek-v3": { contextWindow: 64_000, maxOutputTokens: 8192 },

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
