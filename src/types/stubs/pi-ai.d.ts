declare module "@earendil-works/pi-ai" {
  export type Api = string;
  export type ProviderId = string;
  export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
  export type ModelThinkingLevel = "off" | ThinkingLevel;
  export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
  export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
  export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
  export type CacheRetention = "none" | "short" | "long";
  export type ProviderEnv = Record<string, string>;
  export type ProviderHeaders = Record<string, string | null>;

  export interface ProviderResponse {
    status: number;
    headers: Record<string, string>;
  }

  export interface StreamOptions {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    apiKey?: string;
    transport?: Transport;
    cacheRetention?: CacheRetention;
    sessionId?: string;
    onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
    onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
    headers?: ProviderHeaders;
    timeoutMs?: number;
    maxRetries?: number;
    maxRetryDelayMs?: number;
    metadata?: Record<string, unknown>;
    env?: ProviderEnv;
  }

  export interface ThinkingBudgets {
    minimal?: number;
    low?: number;
    medium?: number;
    high?: number;
  }

  export interface SimpleStreamOptions extends StreamOptions {
    reasoning?: ThinkingLevel;
    thinkingBudgets?: ThinkingBudgets;
  }

  export interface TextContent {
    type: "text";
    text: string;
    textSignature?: string;
  }

  export interface ThinkingContent {
    type: "thinking";
    thinking: string;
    thinkingSignature?: string;
    redacted?: boolean;
  }

  export interface ImageContent {
    type: "image";
    data: string;
    mimeType: string;
  }

  export interface ToolCall {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    thoughtSignature?: string;
  }

  export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h?: number;
    reasoning?: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  }

  export interface UserMessage {
    role: "user";
    content: string | (TextContent | ImageContent)[];
    timestamp: number;
  }

  export interface AssistantMessage {
    role: "assistant";
    content: (TextContent | ThinkingContent | ToolCall)[];
    api: Api;
    provider: ProviderId;
    model: string;
    responseModel?: string;
    responseId?: string;
    usage: Usage;
    stopReason: StopReason;
    errorMessage?: string;
    timestamp: number;
  }

  export type Message = UserMessage | AssistantMessage;

  export interface Context {
    systemPrompt?: string;
    messages: Message[];
  }

  export interface Model<TApi extends Api> {
    id: string;
    name: string;
    api: TApi;
    provider: ProviderId;
    baseUrl: string;
    reasoning: boolean;
    thinkingLevelMap?: ThinkingLevelMap;
    input: ("text" | "image")[];
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;
    compat?: unknown;
  }

  export class AssistantMessageEventStream implements AsyncIterable<AssistantMessageEvent> {
    result(): Promise<AssistantMessage>;
    [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>;
  }

  export type AssistantMessageEvent =
    | { type: "start"; partial: AssistantMessage }
    | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
    | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
    | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
    | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
    | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
    | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
    | { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
    | { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

  export interface CreateModelsOptions {
    credentials?: unknown;
    authContext?: unknown;
  }

  export interface MutableModels {
    streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
    completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
  }

  export function createModels(options?: CreateModelsOptions): MutableModels;
}

declare module "@earendil-works/pi-ai/compat" {
  import type {
    Api,
    AssistantMessage,
    AssistantMessageEventStream,
    Context,
    Model,
    SimpleStreamOptions,
  } from "@earendil-works/pi-ai";

  export function streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;

  export function completeSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessage>;

  export function getModel(provider: string, modelId: string): Model<Api> | undefined;
  export function getModels(provider: string): Model<Api>[];
  export function getProviders(): string[];
}

declare module "@earendil-works/pi-ai/providers/all" {
  import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";

  export function builtinModels(options?: unknown): MutableModels;
  export function getBuiltinModel(provider: string, modelId: string): Model<Api> | undefined;
  export function getBuiltinModels(provider: string): Model<Api>[];
  export function getBuiltinProviders(): string[];
}

declare module "@earendil-works/pi-ai/oauth" {
  export function getOAuthApiKey(
    provider: string,
    credentials: Record<string, Record<string, unknown> | undefined>,
  ): Promise<{ apiKey: string; newCredentials?: Record<string, unknown> } | undefined>;
}
