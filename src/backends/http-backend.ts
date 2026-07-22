import { resolveModelInfo } from "../model-registry.js";
import type { ProviderApiInfo } from "../types/secondary-model.js";
import { getPiSessionId } from "./pi-backend.js";
import { buildUsage, applyReportedUsage, isLengthStop, isYoowaiDebugEnabled } from "./shared.js";

interface AnthropicSseEvent {
  type: string;
  delta?: Record<string, unknown>;
  content_block?: Record<string, unknown>;
  message?: { usage?: Record<string, unknown> };
  usage?: Record<string, unknown>;
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

function parseSseEvents(buffer: string): { events: Array<{ event: string; data: string }>; remainder: string } {
  const events: Array<{ event: string; data: string }> = [];
  const separator = "\n\n";
  const idx = buffer.lastIndexOf(separator);
  if (idx === -1) {
    return { events: [], remainder: buffer };
  }
  const complete = buffer.slice(0, idx);
  const remainder = buffer.slice(idx + separator.length);
  for (const rawEvent of complete.split(separator)) {
    if (!rawEvent.trim()) continue;
    let event = "";
    let data = "";
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        if (data) data += "\n";
        data += line.slice(5).trim();
      }
    }
    if (data || event) {
      events.push({ event, data });
    }
  }
  return { events, remainder };
}

async function* readAnthropicSseStream(response: Response, signal?: AbortSignal): AsyncGenerator<AnthropicSseEvent> {
  if (!response.body) {
    throw new Error("Anthropic streaming response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Secondary model request aborted");
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseEvents(buffer);
      buffer = parsed.remainder;
      for (const sse of parsed.events) {
        if (sse.event === "error") {
          throw new Error(sse.data);
        }
        if (sse.event === "ping") {
          continue;
        }
        try {
          yield JSON.parse(sse.data) as AnthropicSseEvent;
        } catch {
          // Ignore malformed SSE events; proxies can emit non-JSON lines.
        }
      }
    }
    // Flush any trailing event that did not end with a blank line.
    const parsed = parseSseEvents(buffer + decoder.decode());
    for (const sse of parsed.events) {
      if (sse.event === "error") throw new Error(sse.data);
      if (sse.event === "ping") continue;
      try {
        yield JSON.parse(sse.data) as AnthropicSseEvent;
      } catch {
        // ignore
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function logHttpDebug(
  label: string,
  provider: string,
  model: string,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): void {
  if (!isYoowaiDebugEnabled()) return;
  const redactedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redactedHeaders[key] = /api[-_]?key|auth|token|session/i.test(key) ? "[REDACTED]" : value;
  }
  console.log(`[pi-yoowai debug] ${label}`, JSON.stringify({ provider, model, url, headers: redactedHeaders, body }));
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
  modelInfoOverride?: Partial<ReturnType<typeof resolveModelInfo>>,
  cwd?: string,
  sessionId?: string,
  structuredOutput = false,
): Promise<{ content: string; usage: ReturnType<typeof buildUsage>; truncated?: boolean }> {
  const url = buildOpenAiUrl(apiInfo, apiKey);

  const supportsReasoning = supportsReasoningEffort(provider, model);
  const supportsAnthropicThinking = modelSupportsAnthropicThinking(provider, model);
  const thinkingEnabled =
    Boolean(thinking) && thinking!.toLowerCase() !== "off" && (supportsReasoning || supportsAnthropicThinking);
  const modelInfo = resolveModelInfo(provider, model, modelInfoOverride);
  // Reasoning models can consume a large portion of the output budget in internal reasoning tokens,
  // so use the model's full output limit when thinking/reasoning is enabled. Structured output tasks
  // (review, judge, test, security, etc.) can also exceed a cheap 2048 token cap, so allow the full
  // model limit for those. Otherwise keep calls cheap while still honoring explicit maxOutputTokens overrides.
  const outputTokenLimit =
    thinkingEnabled || structuredOutput ? modelInfo.maxOutputTokens : Math.min(modelInfo.maxOutputTokens, 2048);

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: outputTokenLimit,
  };
  if (structuredOutput && apiInfo.supportsJsonObject) {
    body.response_format = { type: "json_object" };
  }
  if (thinkingEnabled) {
    delete body.temperature;
    if (supportsReasoning) {
      body.reasoning_effort = reasoningEffortForModel(provider, model, thinking ?? "medium");
    } else {
      // Anthropic requires budget_tokens < max_tokens, so keep a safety margin for visible output.
      const budget = Math.min(thinkingBudget(thinking ?? "medium"), outputTokenLimit - 512);
      body.thinking = { type: "enabled", budget_tokens: Math.max(1024, budget) };
    }
  }
  if (provider === "openai" && supportsMaxCompletionTokens(provider, model)) {
    delete body.max_tokens;
    body.max_completion_tokens = outputTokenLimit;
  }

  const headers = buildOpenAiHeaders(apiInfo, apiKey);
  if ((provider === "opencode-go" || provider === "opencode") && sessionId) {
    // Pi sends both session and client attribution headers for opencode routing/attribution.
    headers["x-opencode-session"] = sessionId;
    headers["x-opencode-client"] = "pi";
  }

  logHttpDebug("OpenAI-compatible HTTP request", provider, model, url, headers, body);

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
      structuredOutput,
    );
  }

  if (!content || content.trim().length === 0) {
    const reason = choice.finish_reason ?? "unknown";
    let hint = "";
    if (reason === "length") {
      hint =
        " The model ran out of output tokens before producing a response. Try increasing maxOutputTokens in settings.json, reducing the review scope with files:[...], or using a model with a larger output window.";
    }
    throw new Error(
      `Empty response from secondary model (finish_reason: ${reason}).${hint} Raw: ${JSON.stringify(data).slice(0, 800)}`,
    );
  }

  // finish_reason "length" means the model stopped early because it hit the output-token cap.
  // Surface that so the caller can issue a continuation call instead of returning incomplete content silently.
  const truncated = isLengthStop(choice.finish_reason);

  const usage = applyReportedUsage(
    provider,
    model,
    buildUsage(provider, model, systemPrompt, userPrompt, content),
    data.usage?.prompt_tokens,
    data.usage?.completion_tokens,
  );

  return { content, usage, truncated };
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
  modelInfoOverride?: Partial<ReturnType<typeof resolveModelInfo>>,
  sessionId?: string,
  structuredOutput = false,
): Promise<{ content: string; usage: ReturnType<typeof buildUsage>; truncated?: boolean }> {
  const url = `${apiInfo.baseUrl}/messages`;

  const thinkingEnabled =
    Boolean(thinking) &&
    (thinking as string).toLowerCase() !== "off" &&
    modelSupportsAnthropicThinking(provider, model);
  const modelInfo = resolveModelInfo(provider, model, modelInfoOverride);
  // Anthropic counts thinking tokens against max_tokens, so reserve room for visible output.
  // Structured output tasks may need more than a cheap 2048 token cap.
  const outputTokenLimit =
    thinkingEnabled || structuredOutput ? modelInfo.maxOutputTokens : Math.min(modelInfo.maxOutputTokens, 2048);

  const body: Record<string, unknown> = {
    model,
    max_tokens: outputTokenLimit,
    // Pi sends the system prompt as an array of text blocks for anthropic-messages.
    system: [{ type: "text", text: systemPrompt }],
    messages: [{ role: "user", content: userPrompt }],
    // Pi always streams Anthropic messages API requests; some providers only serve the streaming path.
    stream: true,
  };
  if (thinkingEnabled) {
    if (usesAdaptiveThinking(provider, model)) {
      body.thinking = { type: "adaptive", display: "summarized" };
      // Adaptive thinking models accept effort via output_config. Cast because SDK types may lag.
      body.output_config = { effort: anthropicEffortFromThinking(thinking ?? "medium") } as unknown as Record<
        string,
        unknown
      >;
    } else {
      const budget = Math.min(thinkingBudget(thinking ?? "medium"), outputTokenLimit - 512);
      body.thinking = {
        type: "enabled",
        budget_tokens: Math.max(1024, budget),
        display: "summarized",
      };
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [apiInfo.authHeader]: `${apiInfo.authPrefix}${apiKey}`,
    "anthropic-version": "2023-06-01",
    accept: "text/event-stream",
    // Required by some Anthropic-compatible gateways (including opencode-go) to allow SDK-style access.
    "anthropic-dangerous-direct-browser-access": "true",
  };
  // Sticky session routing for opencode-go/opencode, matching Pi's behavior.
  if ((provider === "opencode-go" || provider === "opencode") && sessionId) {
    headers["x-opencode-session"] = sessionId;
    headers["x-opencode-client"] = "pi";
  }

  logHttpDebug("Anthropic HTTP request", provider, model, url, headers, body);

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

  const contentType = response.headers.get("content-type") || "";
  const isStreaming = contentType.includes("text/event-stream") || contentType.includes("application/octet-stream");

  if (isStreaming) {
    let text = "";
    let thinkingText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;
    for await (const event of readAnthropicSseStream(response, signal)) {
      if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          text += delta.text;
        } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          thinkingText += delta.thinking;
        }
      } else if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block?.type === "text" && typeof block.text === "string") {
          text += block.text;
        } else if (block?.type === "thinking" && typeof block.thinking === "string") {
          thinkingText += block.thinking;
        }
      } else if (event.type === "message_start") {
        const usage = event.message?.usage;
        if (typeof usage?.input_tokens === "number") inputTokens = usage.input_tokens;
        if (typeof usage?.output_tokens === "number") outputTokens = usage.output_tokens;
      } else if (event.type === "message_delta") {
        // Anthropic carries the final stop_reason in `delta.stop_reason` and the
        // final usage in `usage` on the `message_delta` event.
        const delta = event.delta;
        if (delta && typeof delta.stop_reason === "string") {
          stopReason = delta.stop_reason;
        }
        const usage = event.usage;
        if (typeof usage?.input_tokens === "number") inputTokens = usage.input_tokens;
        if (typeof usage?.output_tokens === "number") outputTokens = usage.output_tokens;
      }
    }
    const finalText = text.trim().length > 0 ? text.trim() : thinkingText.trim();
    if (finalText.length === 0) {
      throw new Error("Empty response from secondary model stream");
    }
    const truncated = isLengthStop(stopReason);
    const usage = applyReportedUsage(
      provider,
      model,
      buildUsage(provider, model, systemPrompt, userPrompt, finalText),
      inputTokens || undefined,
      outputTokens || undefined,
    );
    return { content: finalText, usage, truncated };
  }

  // Non-streaming fallback for proxies that return JSON even when stream: true is requested.
  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string; thinking?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
    stop_reason?: string;
  };

  if (data.error?.message) {
    throw new Error(`Secondary model API error: ${data.error.message}`);
  }

  const textBlocks = data.content?.filter((c) => c.type === "text").map((c) => c.text ?? "") ?? [];
  const thinkingBlocks = data.content?.filter((c) => c.type === "thinking").map((c) => c.thinking ?? "") ?? [];
  const textContent = (textBlocks.length > 0 ? textBlocks : thinkingBlocks).join("");
  if (textContent.trim().length === 0) {
    throw new Error(`Empty response from secondary model. Raw: ${JSON.stringify(data).slice(0, 800)}`);
  }

  const usage = applyReportedUsage(
    provider,
    model,
    buildUsage(provider, model, systemPrompt, userPrompt, textContent),
    data.usage?.input_tokens,
    data.usage?.output_tokens,
  );

  return { content: textContent, usage, truncated: isLengthStop(data.stop_reason) };
}

function modelSupportsAnthropicThinking(provider: string, model: string): boolean {
  const lc = `${provider}:${model}`.toLowerCase();
  const modelLc = model.toLowerCase();
  const thinkingModels = new Set([
    // Anthropic extended-thinking models.
    "claude-sonnet-4-5",
    "claude-opus-4-5",
    "claude-fable-5",
    "claude-3-7-sonnet",
    "claude-3.7-sonnet",
    "anthropic/claude-3-7-sonnet",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-opus-4-5",
    "anthropic/claude-fable-5",
    // opencode-go models that use the Anthropic messages API and support budget-based thinking.
    "opencode-go:qwen3.7-max",
    "opencode-go:qwen3.7-plus",
    "opencode-go:minimax-m3",
    // opencode Zen Anthropic-messages models with budget-based thinking.
    "opencode:claude-haiku-4-5",
    "opencode:claude-opus-4-1",
    "opencode:claude-opus-4-5",
    "opencode:claude-fable-5",
  ]);
  if (thinkingModels.has(lc)) return true;
  const baseModel = modelLc.replace(/-\d{8}$/, "").replace(/-latest$/, "");
  if (thinkingModels.has(baseModel)) return true;
  if (lc.startsWith("openrouter:")) {
    // OpenRouter passes provider-specific params only for Anthropic thinking models.
    return [...thinkingModels].some((m) => baseModel.includes(m.replace("anthropic/", "")));
  }
  return false;
}

const ADAPTIVE_THINKING_PROVIDERS = new Set(["anthropic", "opencode", "opencode-go", "openrouter"]);

function usesAdaptiveThinking(provider: string, model: string): boolean {
  // Adaptive thinking (type: "adaptive") is currently specific to Anthropic's
  // Claude Fable 5 and providers that proxy the Anthropic messages API. Limit the
  // match to known providers so arbitrary custom endpoints are not forced onto
  // the adaptive path just because their model id happens to contain "claude-fable-5".
  const providerLc = provider.toLowerCase();
  if (!ADAPTIVE_THINKING_PROVIDERS.has(providerLc)) return false;
  return model.toLowerCase() === "claude-fable-5";
}

// Maps pi-yoowai's canonical thinking levels to Anthropic's adaptive-thinking
// `output_config.effort` values. These values are provider-specific; this mapping
// targets the current Anthropic adaptive models (Claude Fable 5 and later).
function anthropicEffortFromThinking(level: string): "low" | "medium" | "high" | "xhigh" | "max" {
  switch (level?.toLowerCase()) {
    case "minimal":
    case "low":
      return "low";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return "medium";
  }
}

function supportsReasoningEffort(_provider: string, model: string): boolean {
  // OpenAI-style reasoning_effort is supported by OpenAI o-series/gpt-5 models.
  // DeepSeek reasoner models emit reasoning_content but do not accept a reasoning_effort parameter.
  const modelLc = model.toLowerCase();
  if (modelLc.startsWith("o") && /^o\d/.test(modelLc)) return true;
  if (modelLc.startsWith("gpt-5")) return true;
  return false;
}

function reasoningEffortFromThinking(level: string): "low" | "medium" | "high" {
  switch (level?.toLowerCase()) {
    case "minimal":
    case "low":
      return "low";
    case "high":
    case "xhigh":
    case "max":
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
    max: 8192,
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
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        const signal = init.signal;
        if (!signal) return;
        const onAbort = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
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

export async function callHttpBackend(
  provider: string,
  apiInfo: ProviderApiInfo,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  thinking?: string,
  modelInfoOverride?: Partial<ReturnType<typeof resolveModelInfo>>,
  cwd?: string,
  structuredOutput?: boolean,
): Promise<{ content: string; usage: ReturnType<typeof buildUsage>; truncated?: boolean }> {
  const sessionId = cwd ? getPiSessionId(cwd) : undefined;
  if (apiInfo.style === "anthropic") {
    return callAnthropicApi(
      provider,
      apiInfo,
      apiKey,
      model,
      systemPrompt,
      userPrompt,
      signal,
      thinking,
      modelInfoOverride,
      sessionId,
      structuredOutput,
    );
  }
  return callOpenAiCompatibleApi(
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
    structuredOutput,
  );
}
