import { resolveApiKey } from "./auth-reader.js";
import { loadHeyyooConfig } from "./config.js";
import { formatCost, getSessionCost } from "./cost-tracker.js";
import { logEvent } from "./logger.js";
import type { ProviderApiInfo, UsageCost } from "./types.js";

const PROVIDER_API_MAP: Record<string, ProviderApiInfo> = {
  "opencode-go": {
    style: "openai-compatible",
    baseUrl: "https://go.opencode.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  opencode: {
    style: "openai-compatible",
    baseUrl: "https://zen.opencode.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  anthropic: {
    style: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    authHeader: "x-api-key",
    authPrefix: "",
  },
  openai: {
    style: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  deepseek: {
    style: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  openrouter: {
    style: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  groq: {
    style: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  mistral: {
    style: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  xai: {
    style: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  together: {
    style: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  fireworks: {
    style: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  cerebras: {
    style: "openai-compatible",
    baseUrl: "https://api.cerebras.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  google: {
    style: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    queryAuthKey: "key",
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
  thinking?: string,
  cwd?: string,
): Promise<{ content: string; usage: UsageCost }> {
  const apiInfo = getProviderApiInfo(provider);
  if (!apiInfo) {
    throw new Error(`Unknown provider: ${provider}. Supported providers: ${Object.keys(PROVIDER_API_MAP).join(", ")}`);
  }

  const apiKey = resolveApiKey(provider);
  if (!apiKey) {
    throw new Error(
      `No API key found for provider "${provider}". Set the appropriate environment variable or configure auth.json.`,
    );
  }

  if (cwd) {
    const budgetUsd = loadHeyyooConfig(cwd).costBudgetUsd;
    if (budgetUsd !== undefined && budgetUsd > 0) {
      const estimatedInputTokens = estimateTokens(systemPrompt + userPrompt);
      const estimatedOutputTokens = thinking && thinking.toLowerCase() !== "off" ? 8192 : 2048;
      const projectedCost = estimateCost(provider, model, estimatedInputTokens, estimatedOutputTokens);
      const sessionCost = getSessionCost(cwd).costUsd;
      if (sessionCost + projectedCost > budgetUsd) {
        throw new Error(
          `yoo call would exceed cost budget: projected ${formatCost(sessionCost + projectedCost)} / ${formatCost(budgetUsd)}. ` +
            `Increase pi-heyyoo.costBudgetUsd in settings or use /yoo-clear to reset.`,
        );
      }
    }
  }

  try {
    if (apiInfo.style === "anthropic") {
      return await callAnthropicApi(provider, apiInfo, apiKey, model, systemPrompt, userPrompt, signal, thinking);
    }
    return await callOpenAiCompatibleApi(provider, apiInfo, apiKey, model, systemPrompt, userPrompt, signal, thinking);
  } catch (err) {
    if (cwd) {
      logEvent(cwd, "error", err instanceof Error ? err.message : String(err), {
        provider,
        model,
        thinking,
        promptTokensEstimate: Math.ceil((systemPrompt.length + userPrompt.length) / 4),
      });
    }
    throw err;
  }
}

function estimateCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
  // Approximate cost per 1M tokens in USD. These are rough averages.
  const key = `${provider}:${model}`.toLowerCase();
  const rates: Record<string, { input: number; output: number }> = {
    "opencode-go:deepseek-v4-pro": { input: 0.5, output: 2.0 },
    "opencode-go:deepseek-v4-flash": { input: 0.1, output: 0.5 },
    "deepseek:deepseek-chat": { input: 0.14, output: 0.28 },
    "deepseek:deepseek-reasoner": { input: 0.55, output: 2.19 },
    "anthropic:claude-sonnet-4-5": { input: 3.0, output: 15.0 },
    "anthropic:claude-opus-4-5": { input: 15.0, output: 75.0 },
    "anthropic:claude-3-5-sonnet": { input: 3.0, output: 15.0 },
    "anthropic:claude-3-opus": { input: 15.0, output: 75.0 },
    "openai:gpt-5": { input: 5.0, output: 15.0 },
    "openai:gpt-5-mini": { input: 0.5, output: 1.5 },
    "openai:gpt-4o": { input: 2.5, output: 10.0 },
    "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
    "openai:o3-mini": { input: 1.1, output: 4.4 },
    "openrouter:deepseek/deepseek-r1": { input: 0.55, output: 2.19 },
    "openrouter:anthropic/claude-3.5-sonnet": { input: 3.0, output: 15.0 },
    "groq:llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
    "together:meta-llama/Llama-3.3-70B-Instruct-Turbo": { input: 0.88, output: 0.88 },
  };
  const rate = rates[key] ?? rates[provider] ?? { input: 2.0, output: 6.0 };
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English/code
  return Math.ceil(text.length / 4);
}

function buildUsage(
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

async function callOpenAiCompatibleApi(
  provider: string,
  apiInfo: ProviderApiInfo,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  thinking?: string,
): Promise<{ content: string; usage: UsageCost }> {
  const url = buildOpenAiUrl(apiInfo, apiKey);

  const supportsReasoning = supportsReasoningEffort(provider, model);
  const supportsAnthropicThinking = supportsThinkingParam(provider, model);
  const thinkingEnabled = Boolean(thinking && (supportsReasoning || supportsAnthropicThinking));
  // When thinking/reasoning is enabled, reserve room for both internal reasoning and visible output.
  const outputTokenLimit = thinkingEnabled ? 8192 : 2048;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: outputTokenLimit,
  };
  if (thinkingEnabled) {
    delete body.temperature;
    if (supportsReasoning) {
      body.reasoning_effort = reasoningEffortFromThinking(thinking ?? "medium");
    } else {
      body.thinking = { type: "enabled", budget_tokens: thinkingBudget(thinking ?? "medium") };
    }
  }
  if (supportsMaxCompletionTokens(provider, model)) {
    delete body.max_tokens;
    body.max_completion_tokens = outputTokenLimit;
  }

  const headers = buildOpenAiHeaders(apiInfo, apiKey);

  const response = await fetchWithRetry(url, {
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
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
        refusal?: string;
      };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  };

  if (data.error?.message) {
    throw new Error(`Secondary model API error: ${data.error.message}`);
  }

  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error(`Empty response from secondary model: no choices. Raw: ${JSON.stringify(data).slice(0, 800)}`);
  }

  const message = choice.message;
  if (message?.refusal) {
    throw new Error(`Secondary model refused: ${message.refusal}`);
  }

  let content: string | undefined;
  if (typeof message?.content === "string") {
    content = message.content;
  } else if (Array.isArray(message?.content)) {
    content = message.content.map((c) => (typeof c === "object" && c?.text ? c.text : "")).join("");
  }

  if (!content || content.trim().length === 0) {
    throw new Error(
      `Empty response from secondary model (finish_reason: ${choice.finish_reason ?? "unknown"}). Raw: ${JSON.stringify(data).slice(0, 800)}`,
    );
  }

  const usage = buildUsage(provider, model, systemPrompt, userPrompt, content);
  if (data.usage?.prompt_tokens !== undefined && data.usage.completion_tokens !== undefined) {
    usage.estimatedInputTokens = data.usage.prompt_tokens;
    usage.estimatedOutputTokens = data.usage.completion_tokens;
  }
  usage.estimatedCostUsd = estimateCost(provider, model, usage.estimatedInputTokens, usage.estimatedOutputTokens);

  return { content, usage };
}

function buildOpenAiUrl(apiInfo: ProviderApiInfo, apiKey: string): string {
  const base = apiInfo.baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/chat/completions`);
  if (apiInfo.queryAuthKey) {
    url.searchParams.set(apiInfo.queryAuthKey, apiKey);
  }
  return url.toString();
}

function buildOpenAiHeaders(apiInfo: ProviderApiInfo, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!apiInfo.queryAuthKey) {
    headers[apiInfo.authHeader] = `${apiInfo.authPrefix}${apiKey}`;
  }
  return headers;
}

function supportsMaxCompletionTokens(provider: string, model: string): boolean {
  const key = `${provider}:${model}`.toLowerCase();
  const known = new Set([
    "openai:o1",
    "openai:o1-mini",
    "openai:o3",
    "openai:o3-mini",
    "openai:o4",
    "openai:o4-mini",
    "openai:gpt-4.5",
    "openai:gpt-5",
    "openai:gpt-5-mini",
  ]);
  return known.has(key) || model.toLowerCase().startsWith("o") || model.toLowerCase().startsWith("gpt-5");
}

async function callAnthropicApi(
  provider: string,
  apiInfo: ProviderApiInfo,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  thinking?: string,
): Promise<{ content: string; usage: UsageCost }> {
  const url = `${apiInfo.baseUrl}/messages`;

  const thinkingEnabled = Boolean(thinking);
  // Anthropic counts thinking tokens against max_tokens, so reserve room for visible output.
  const outputTokenLimit = thinkingEnabled ? 8192 : 2048;

  const body: Record<string, unknown> = {
    model,
    max_tokens: outputTokenLimit,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (thinkingEnabled) {
    body.thinking = { type: "enabled", budget_tokens: thinkingBudget(thinking ?? "medium") };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [apiInfo.authHeader]: `${apiInfo.authPrefix}${apiKey}`,
    "anthropic-version": "2023-06-01",
  };

  const response = await fetchWithRetry(url, {
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
    content?: Array<{ type: string; text?: string; thinking?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };

  if (data.error?.message) {
    throw new Error(`Secondary model API error: ${data.error.message}`);
  }

  const textContent = data.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  if (!textContent || textContent.trim().length === 0) {
    throw new Error(`Empty response from secondary model. Raw: ${JSON.stringify(data).slice(0, 800)}`);
  }

  const usage = buildUsage(provider, model, systemPrompt, userPrompt, textContent);
  if (data.usage?.input_tokens !== undefined && data.usage.output_tokens !== undefined) {
    usage.estimatedInputTokens = data.usage.input_tokens;
    usage.estimatedOutputTokens = data.usage.output_tokens;
  }
  usage.estimatedCostUsd = estimateCost(provider, model, usage.estimatedInputTokens, usage.estimatedOutputTokens);

  return { content: textContent, usage };
}

function supportsThinkingParam(provider: string, model: string): boolean {
  // Anthropic-style thinking parameter. Used only when reasoning_effort is not supported.
  const lc = `${provider}:${model}`.toLowerCase();
  if (lc.startsWith("openrouter:")) return true;
  return false;
}

function supportsReasoningEffort(provider: string, model: string): boolean {
  // OpenAI-style reasoning_effort is supported by OpenAI o-series/gpt-5 and DeepSeek reasoning models.
  const lc = `${provider}:${model}`.toLowerCase();
  const modelLc = model.toLowerCase();
  if (modelLc.startsWith("deepseek")) return true;
  if (modelLc.startsWith("o") && /^o\d/.test(modelLc)) return true;
  if (modelLc.startsWith("gpt-5")) return true;
  if (lc.startsWith("openrouter:deepseek")) return true;
  return false;
}

function reasoningEffortFromThinking(level: string): "low" | "medium" | "high" {
  switch (level?.toLowerCase()) {
    case "minimal":
    case "low":
      return "low";
    case "high":
    case "xhigh":
      return "high";
    default:
      return "medium";
  }
}

function thinkingBudget(level: string): number {
  const budgets: Record<string, number> = {
    off: 0,
    minimal: 256,
    low: 512,
    medium: 1024,
    high: 2048,
    xhigh: 4096,
  };
  return budgets[level?.toLowerCase()] ?? 1024;
}

async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 2, baseDelayMs = 500): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);
      // Retry on 5xx and rate-limit (429); do not retry on 4xx auth/validation errors.
      if (response.status >= 500 || response.status === 429) {
        const text = await response.text().catch(() => "(no body)");
        lastError = new Error(`Transient API error (${response.status}): ${text.slice(0, 200)}`);
      } else {
        return response;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    if (attempt < maxRetries) {
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError ?? new Error("Secondary model request failed after retries");
}
