import { resolveApiKey } from "./auth-reader.js";
import { loadHeyyooConfig } from "./config.js";
import { formatCost, getSessionCost } from "./cost-tracker.js";
import { logEvent } from "./logger.js";
import { resolveModelInfo } from "./model-registry.js";
import type { ProviderApiInfo, UsageCost } from "./types.js";

const PROVIDER_API_MAP: Record<string, ProviderApiInfo> = {
  "opencode-go": {
    style: "openai-compatible",
    baseUrl: "https://opencode.ai/zen/go/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  opencode: {
    style: "openai-compatible",
    baseUrl: "https://opencode.ai/zen/v1",
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
    authHeader: "x-goog-api-key",
    authPrefix: "",
  },
};

export function getProviderApiInfo(provider: string): ProviderApiInfo | undefined {
  return PROVIDER_API_MAP[provider.toLowerCase()];
}

function resolveProviderApiInfo(
  provider: string,
  config?: import("./types.js").HeyyooConfig,
): ProviderApiInfo | undefined {
  const secondary = config?.secondary;
  if (secondary?.baseUrl) {
    const style = secondary.style ?? "openai-compatible";
    if (style !== "openai-compatible" && style !== "anthropic") {
      throw new Error(`Unsupported secondary style: ${style}. Use "openai-compatible" or "anthropic".`);
    }
    return {
      style,
      baseUrl: secondary.baseUrl.replace(/\/$/, ""),
      authHeader: secondary.authHeader || (style === "anthropic" ? "x-api-key" : "Authorization"),
      authPrefix: secondary.authPrefix ?? (style === "anthropic" ? "" : "Bearer "),
    };
  }
  return getProviderApiInfo(provider);
}

const piSessionIds = new Map<string, string>();

export function setPiSessionId(cwd: string, sessionId: string): void {
  piSessionIds.set(cwd, sessionId);
}

export function clearPiSessionId(cwd: string): void {
  piSessionIds.delete(cwd);
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
  provider = provider.toLowerCase();
  const config = cwd ? loadHeyyooConfig(cwd) : undefined;
  const apiInfo = resolveProviderApiInfo(provider, config);
  if (!apiInfo) {
    throw new Error(
      `Unknown provider: ${provider}. Supported providers: ${Object.keys(PROVIDER_API_MAP).join(", ")}. ` +
        `Or set pi-heyyoo.secondary.baseUrl to use any OpenAI-compatible or Anthropic-compatible endpoint.`,
    );
  }

  const apiKey = resolveApiKey(provider, config?.secondary.apiKey);
  if (!apiKey) {
    throw new Error(
      `No API key found for provider "${provider}". Set the appropriate environment variable, configure auth.json, ` +
        `or set pi-heyyoo.secondary.apiKey.`,
    );
  }

  const modelInfoOverride = buildModelInfoOverride(config, model);
  const thinkingEnabledForBudget = Boolean(thinking) && thinking?.toLowerCase() !== "off";
  const modelInfoForBudget = cwd ? resolveModelInfo(provider, model, modelInfoOverride) : undefined;

  if (cwd) {
    const budgetUsd = config?.costBudgetUsd;
    if (budgetUsd !== undefined && budgetUsd >= 0) {
      const estimatedInputTokens = estimateTokens(systemPrompt + userPrompt);
      const estimatedOutputTokens = thinkingEnabledForBudget ? (modelInfoForBudget?.maxOutputTokens ?? 8192) : 2048;
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

  const sessionId = cwd ? piSessionIds.get(cwd) : undefined;

  try {
    if (apiInfo.style === "anthropic") {
      return await callAnthropicApi(
        provider,
        apiInfo,
        apiKey,
        model,
        systemPrompt,
        userPrompt,
        signal,
        thinking,
        modelInfoOverride,
      );
    }
    return await callOpenAiCompatibleApi(
      provider,
      apiInfo,
      apiKey,
      model,
      systemPrompt,
      userPrompt,
      signal,
      thinking,
      false,
      modelInfoOverride,
      cwd,
      sessionId,
    );
  } catch (err) {
    if (cwd) {
      logEvent(cwd, "error", err instanceof Error ? err.message : String(err), {
        provider,
        model,
        thinking,
        promptTokensEstimate: Math.ceil((systemPrompt.length + userPrompt.length) / 4),
        url: apiInfo.baseUrl,
      });
    }
    throw err;
  }
}

function buildModelInfoOverride(
  config: import("./types.js").HeyyooConfig | undefined,
  model: string,
): Partial<import("./model-registry.js").ModelInfo> | undefined {
  if (!config) return undefined;
  const user = config.modelInfo?.[model.toLowerCase()];
  const override: { contextWindow?: number; maxOutputTokens?: number } = {};
  if (typeof config.secondary.contextWindow === "number" && Number.isFinite(config.secondary.contextWindow)) {
    override.contextWindow = config.secondary.contextWindow;
  } else if (typeof user?.contextWindow === "number" && Number.isFinite(user.contextWindow)) {
    override.contextWindow = user.contextWindow;
  }
  if (typeof config.secondary.maxOutputTokens === "number" && Number.isFinite(config.secondary.maxOutputTokens)) {
    override.maxOutputTokens = config.secondary.maxOutputTokens;
  } else if (typeof user?.maxOutputTokens === "number" && Number.isFinite(user.maxOutputTokens)) {
    override.maxOutputTokens = user.maxOutputTokens;
  }
  return Object.keys(override).length > 0 ? override : undefined;
}

function estimateCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
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

function applyReportedUsage(
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

async function callOpenAiCompatibleApi(
  provider: string,
  apiInfo: ProviderApiInfo,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  thinking?: string,
  retriedWithReasoningOff = false,
  modelInfoOverride?: Partial<import("./model-registry.js").ModelInfo>,
  cwd?: string,
  sessionId?: string,
): Promise<{ content: string; usage: UsageCost }> {
  const url = buildOpenAiUrl(apiInfo, apiKey);

  const supportsReasoning = supportsReasoningEffort(provider, model);
  const supportsAnthropicThinking = modelSupportsAnthropicThinking(provider, model);
  const thinkingEnabled =
    Boolean(thinking) && thinking!.toLowerCase() !== "off" && (supportsReasoning || supportsAnthropicThinking);
  const modelInfo = resolveModelInfo(provider, model, modelInfoOverride);
  // Reasoning models can consume a large portion of the output budget in internal reasoning tokens,
  // so use the model's full output limit when thinking/reasoning is enabled. Otherwise keep calls cheap.
  const outputTokenLimit = thinkingEnabled ? modelInfo.maxOutputTokens : 2048;

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
      body.reasoning_effort = reasoningEffortForModel(provider, model, thinking ?? "medium");
    } else {
      body.thinking = { type: "enabled", budget_tokens: thinkingBudget(thinking ?? "medium") };
    }
  }
  if (provider === "openai" && supportsMaxCompletionTokens(provider, model)) {
    delete body.max_tokens;
    body.max_completion_tokens = outputTokenLimit;
  }

  const headers = buildOpenAiHeaders(apiInfo, apiKey);
  if ((provider === "opencode-go" || provider === "opencode") && sessionId) {
    headers["x-opencode-session"] = sessionId;
  }

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
        reasoning_content?: string;
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

  const reasoningContent = message?.reasoning_content;
  if (
    (!content || content.trim().length === 0) &&
    reasoningContent &&
    choice.finish_reason === "length" &&
    !retriedWithReasoningOff
  ) {
    // The model spent its whole output budget on reasoning_content. Retry once with reasoning disabled
    // so there is room for the required structured content.
    return callOpenAiCompatibleApi(
      provider,
      apiInfo,
      apiKey,
      model,
      systemPrompt,
      userPrompt,
      signal,
      "off",
      true,
      modelInfoOverride,
      cwd,
      sessionId,
    );
  }

  if (!content || content.trim().length === 0) {
    throw new Error(
      `Empty response from secondary model (finish_reason: ${choice.finish_reason ?? "unknown"}). Raw: ${JSON.stringify(data).slice(0, 800)}`,
    );
  }

  const usage = applyReportedUsage(
    provider,
    model,
    buildUsage(provider, model, systemPrompt, userPrompt, content),
    data.usage?.prompt_tokens,
    data.usage?.completion_tokens,
  );

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
  modelInfoOverride?: Partial<import("./model-registry.js").ModelInfo>,
): Promise<{ content: string; usage: UsageCost }> {
  const url = `${apiInfo.baseUrl}/messages`;

  const thinkingEnabled = Boolean(thinking) && (thinking as string).toLowerCase() !== "off";
  const modelInfo = resolveModelInfo(provider, model, modelInfoOverride);
  // Anthropic counts thinking tokens against max_tokens, so reserve room for visible output.
  const outputTokenLimit = thinkingEnabled ? modelInfo.maxOutputTokens : 2048;

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

  const usage = applyReportedUsage(
    provider,
    model,
    buildUsage(provider, model, systemPrompt, userPrompt, textContent),
    data.usage?.input_tokens,
    data.usage?.output_tokens,
  );

  return { content: textContent, usage };
}

function modelSupportsAnthropicThinking(provider: string, model: string): boolean {
  // Anthropic extended thinking is supported by Claude 4 series and later thinking-enabled models.
  const lc = `${provider}:${model}`.toLowerCase();
  const modelLc = model.toLowerCase();
  const thinkingModels = new Set([
    "claude-sonnet-4-5",
    "claude-opus-4-5",
    "claude-3-7-sonnet",
    "claude-3.7-sonnet",
    "anthropic/claude-3-7-sonnet",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-opus-4-5",
  ]);
  if (thinkingModels.has(modelLc)) return true;
  if (lc.startsWith("openrouter:")) {
    // OpenRouter passes provider-specific params only for Anthropic thinking models.
    return [...thinkingModels].some((m) => modelLc.includes(m.replace("anthropic/", "")));
  }
  return false;
}

function supportsReasoningEffort(provider: string, model: string): boolean {
  // OpenAI-style reasoning_effort is supported by OpenAI o-series/gpt-5 and DeepSeek reasoning models.
  const lc = `${provider}:${model}`.toLowerCase();
  const modelLc = model.toLowerCase();
  const deepseekReasoner = /^deepseek[-/]?reasoner/;
  const deepseekV4 = /^deepseek[-/]?v4/;
  if (deepseekReasoner.test(modelLc)) return true;
  if (deepseekV4.test(modelLc)) return true;
  if (modelLc.startsWith("o") && /^o\d/.test(modelLc)) return true;
  if (modelLc.startsWith("gpt-5")) return true;
  if (lc.startsWith("openrouter:deepseek") && (deepseekReasoner.test(lc) || deepseekV4.test(lc))) return true;
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

function reasoningEffortForModel(provider: string, model: string, level: string): "low" | "medium" | "high" {
  // DeepSeek V4 models are prone to consuming the entire output budget with reasoning_content,
  // leaving no tokens for the required JSON content. Cap them at low reasoning effort.
  if (/^deepseek[-/]?v4/.test(`${provider}:${model}`.toLowerCase())) {
    return "low";
  }
  return reasoningEffortFromThinking(level);
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

function formatFetchError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const parts: string[] = [message];
  if (err instanceof Error && err.cause instanceof Error) {
    parts.push(`cause: ${err.cause.message}`);
  }
  if (err instanceof AggregateError) {
    for (const e of err.errors) {
      parts.push(`cause: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return parts.join("; ");
}

async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 2, baseDelayMs = 500): Promise<Response> {
  const attemptErrors: string[] = [];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);
      // Retry on 5xx and rate-limit (429); do not retry on 4xx auth/validation errors.
      if (response.status >= 500 || response.status === 429) {
        const text = await response.text().catch(() => "(no body)");
        const errorText = `Transient API error (${response.status}): ${text.slice(0, 200)}`;
        attemptErrors.push(`attempt ${attempt + 1}: ${errorText}`);
      } else {
        return response;
      }
    } catch (err) {
      const errorText = formatFetchError(err);
      attemptErrors.push(`attempt ${attempt + 1}: ${errorText}`);
    }

    if (attempt < maxRetries) {
      if (init.signal?.aborted) {
        throw new Error("Secondary model request aborted");
      }
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        const signal = init.signal;
        if (!signal) return;
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      if (init.signal?.aborted) {
        throw new Error("Secondary model request aborted");
      }
    }
  }
  throw new Error(`Secondary model request failed after ${maxRetries + 1} attempts: ${attemptErrors.join(" | ")}`);
}
