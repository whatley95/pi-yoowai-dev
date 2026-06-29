import { resolveApiKey } from "./auth-reader.js";
import type { ProviderApiInfo, UsageCost } from "./types.js";

const PROVIDER_API_MAP: Record<string, ProviderApiInfo> = {
  "opencode-go": {
    style: "openai-compatible",
    baseUrl: "https://go.opencode.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "opencode": {
    style: "openai-compatible",
    baseUrl: "https://zen.opencode.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "anthropic": {
    style: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    authHeader: "x-api-key",
    authPrefix: "",
  },
  "openai": {
    style: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "deepseek": {
    style: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "openrouter": {
    style: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "groq": {
    style: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "mistral": {
    style: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "xai": {
    style: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "together": {
    style: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "fireworks": {
    style: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "cerebras": {
    style: "openai-compatible",
    baseUrl: "https://api.cerebras.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "google": {
    style: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    authHeader: "x-goog-api-key",
    authPrefix: "",
  },
};

export function getProviderApiInfo(provider: string): ProviderApiInfo | undefined {
  return PROVIDER_API_MAP[provider];
}

export async function callSecondaryModel(
  provider: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<{ content: string; usage: UsageCost }> {
  const apiInfo = getProviderApiInfo(provider);
  if (!apiInfo) {
    throw new Error(`Unknown provider: ${provider}. Supported providers: ${Object.keys(PROVIDER_API_MAP).join(", ")}`);
  }

  const apiKey = resolveApiKey(provider);
  if (!apiKey) {
    throw new Error(`No API key found for provider "${provider}". Set the appropriate environment variable or configure auth.json.`);
  }

  if (apiInfo.style === "anthropic") {
    return callAnthropicApi(provider, apiInfo, apiKey, model, systemPrompt, userPrompt, signal);
  }

  return callOpenAiCompatibleApi(provider, apiInfo, apiKey, model, systemPrompt, userPrompt, signal);
}

function estimateCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
  // Approximate cost per 1M tokens in USD. These are rough averages.
  const key = `${provider}:${model}`.toLowerCase();
  const rates: Record<string, { input: number; output: number }> = {
    "opencode-go:deepseek-v4-pro": { input: 0.5, output: 2.0 },
    "opencode-go:deepseek-v4-flash": { input: 0.1, output: 0.5 },
    "anthropic:claude-sonnet-4-5": { input: 3.0, output: 15.0 },
    "anthropic:claude-opus-4-5": { input: 15.0, output: 75.0 },
    "openai:gpt-5": { input: 5.0, output: 15.0 },
    "openai:gpt-5-mini": { input: 0.5, output: 1.5 },
  };
  const rate = rates[key] ?? rates[provider] ?? { input: 2.0, output: 6.0 };
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English/code
  return Math.ceil(text.length / 4);
}

function buildUsage(provider: string, model: string, systemPrompt: string, userPrompt: string, content: string): UsageCost {
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

async function callOpenAiCompatibleApi(
  provider: string,
  apiInfo: ProviderApiInfo,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<{ content: string; usage: UsageCost }> {
  const url = `${apiInfo.baseUrl}/chat/completions`;

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 2048,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [apiInfo.authHeader]: `${apiInfo.authPrefix}${apiKey}`,
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(`Secondary model API error (${response.status}): ${text.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Empty response from secondary model");
  }

  const usage = buildUsage(provider, model, systemPrompt, userPrompt, content);
  if (data.usage?.prompt_tokens !== undefined && data.usage.completion_tokens !== undefined) {
    usage.estimatedInputTokens = data.usage.prompt_tokens;
    usage.estimatedOutputTokens = data.usage.completion_tokens;
  }
  usage.estimatedCostUsd = estimateCost(provider, model, usage.estimatedInputTokens, usage.estimatedOutputTokens);

  return { content, usage };
}

async function callAnthropicApi(
  provider: string,
  apiInfo: ProviderApiInfo,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<{ content: string; usage: UsageCost }> {
  const url = `${apiInfo.baseUrl}/messages`;

  const body = {
    model,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [
      { role: "user", content: userPrompt },
    ],
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [apiInfo.authHeader]: `${apiInfo.authPrefix}${apiKey}`,
    "anthropic-version": "2023-06-01",
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(`Secondary model API error (${response.status}): ${text.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const textContent = data.content?.find((c) => c.type === "text")?.text;
  if (!textContent) {
    throw new Error("Empty response from secondary model");
  }

  const usage = buildUsage(provider, model, systemPrompt, userPrompt, textContent);
  if (data.usage?.input_tokens !== undefined && data.usage.output_tokens !== undefined) {
    usage.estimatedInputTokens = data.usage.input_tokens;
    usage.estimatedOutputTokens = data.usage.output_tokens;
  }
  usage.estimatedCostUsd = estimateCost(provider, model, usage.estimatedInputTokens, usage.estimatedOutputTokens);

  return { content: textContent, usage };
}