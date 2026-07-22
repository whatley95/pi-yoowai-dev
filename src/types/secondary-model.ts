export type BackendType = "pi" | "http" | "sdk";

export type SdkCacheRetention = "none" | "short" | "long" | "auto";

export type SdkTransport = "sse" | "websocket" | "websocket-cached" | "auto";

export interface SecondaryModelConfig {
  provider: string;
  id: string;
  thinking?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Backend to use for secondary model calls. "pi" spawns the pi CLI; "http" uses direct provider HTTP; "sdk" uses Pi's pi-ai provider layer. */
  backend?: BackendType;
  /** Custom base URL for any OpenAI-compatible or Anthropic-compatible provider. */
  baseUrl?: string;
  /** Inline API key. Prefer auth.json or env vars; this is a fallback. */
  apiKey?: string;
  /** SDK prompt cache retention. "short" or "long" can improve latency/cost for repeated prompts. */
  cacheRetention?: SdkCacheRetention;
  /** SDK transport mode. */
  transport?: SdkTransport;
  /** SDK max retries for a single request. */
  maxRetries?: number;
  /** SDK max delay between retries in ms. */
  maxRetryDelayMs?: number;
  /** SDK request timeout in ms. */
  timeoutMs?: number;
  /** API style when using a custom baseUrl. Defaults to openai-compatible. */
  style?: "openai-compatible" | "anthropic";
  /** Custom auth header name when using baseUrl, or boolean override for provider registration. Defaults to Authorization for baseUrl; provider registration defaults to true. */
  authHeader?: string | boolean;
  /** Custom auth prefix when using baseUrl. Defaults to "Bearer ". */
  authPrefix?: string;
}

export interface ProviderApiInfo {
  style: "openai-compatible" | "anthropic";
  baseUrl: string;
  authHeader: string;
  authPrefix: string;
  queryAuthKey?: string;
  /** Whether the provider supports OpenAI-style response_format: { type: "json_object" }. */
  supportsJsonObject?: boolean;
}

export interface ContentPart {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
}

export interface AssistantMessageLike {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cost?: { total?: number } | number;
    totalTokens?: number;
  };
}

export interface PiProcessResult {
  messages: AssistantMessageLike[];
  stderr: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  // Accumulate streamed text/thinking deltas for providers (e.g. anthropic-messages)
  // where the final message_end event may not include the full content array.
  streamText: string;
  streamThinking: string;
  // Raw stdout chunks for debugging empty responses.
  rawStdout: string[];
  // Track the last message_update event's message and assistantMessageEvent for fallback.
  lastAssistantMessageEvent?: Record<string, unknown>;
  lastMessageUpdateText?: string;
  // Track the last stopReason seen on any streamed/partial assistant message, used as a
  // fallback when no final assistant message is present in `messages`.
  lastStopReason?: unknown;
  // Track error messages from assistant messages that failed (stopReason === "error" / "aborted").
  lastErrorMessage?: string;
}
