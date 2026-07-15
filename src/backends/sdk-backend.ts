import type { AssistantMessageEvent, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { readRawAuthEntry, resolveApiKey } from "../auth-reader.js";
import { getAgentDir } from "../config.js";
import { logEvent } from "../logger.js";
import { resolveModelInfo } from "../model-registry.js";
import type { CallSecondaryModelOptions } from "../types.js";
import type { SecondaryModelConfig } from "../types/secondary-model.js";
import { getPiSessionId } from "./pi-backend.js";
import { buildUsage, applyReportedUsage, extractTextFromContent } from "./shared.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type PiAiCompatModule = typeof import("@earendil-works/pi-ai/compat");
type PiAiOAuthModule = typeof import("@earendil-works/pi-ai/oauth");

const sdkOverrides: {
  streamSimple?: PiAiCompatModule["streamSimple"];
  getModel?: PiAiCompatModule["getModel"];
} = {};

let oauthResolverOverride:
  | ((
      provider: string,
      credential: Record<string, unknown>,
    ) => Promise<{ apiKey: string; newCredentials?: Record<string, unknown> } | undefined>)
  | undefined;

/** Test hook: override the pi-ai streamSimple function used by the sdk backend. */
export function setSdkStreamSimpleOverride(fn: PiAiCompatModule["streamSimple"] | null): void {
  sdkOverrides.streamSimple = fn ?? undefined;
}

/** Test hook: override getModel resolution in the sdk backend. */
export function setSdkGetModelOverride(fn: PiAiCompatModule["getModel"] | null): void {
  sdkOverrides.getModel = fn ?? undefined;
}

/** Test hook: override OAuth API-key resolution. */
export function setSdkOAuthResolverOverride(
  fn:
    | ((
        provider: string,
        credential: Record<string, unknown>,
      ) => Promise<{ apiKey: string; newCredentials?: Record<string, unknown> } | undefined>)
    | null,
): void {
  oauthResolverOverride = fn ?? undefined;
}

export async function getPiAiCompat(): Promise<PiAiCompatModule> {
  if (sdkOverrides.streamSimple || sdkOverrides.getModel) {
    // Use overrides to avoid requiring the real package at runtime (e.g., in tests).
    return {
      streamSimple:
        sdkOverrides.streamSimple ??
        (() => {
          throw new Error("@earendil-works/pi-ai/compat streamSimple is not available");
        }),
      getModel:
        sdkOverrides.getModel ??
        (() => {
          throw new Error("@earendil-works/pi-ai/compat getModel is not available");
        }),
    } as PiAiCompatModule;
  }
  return import("@earendil-works/pi-ai/compat");
}

async function resolveOAuthApiKey(
  provider: string,
  credential: Record<string, unknown>,
): Promise<{ apiKey: string; newCredentials?: Record<string, unknown> } | undefined> {
  if (oauthResolverOverride) {
    return oauthResolverOverride(provider, credential);
  }
  try {
    const oauth = (await import("@earendil-works/pi-ai/oauth")) as PiAiOAuthModule;
    if (typeof oauth.getOAuthApiKey !== "function") return undefined;
    return await oauth.getOAuthApiKey(provider, { [provider]: credential });
  } catch {
    return undefined;
  }
}

function persistRefreshedCredential(provider: string, credential: Record<string, unknown>): void {
  const authPath = join(getAgentDir(), "auth.json");
  if (!existsSync(authPath)) return;
  try {
    const raw = readFileSync(authPath, "utf-8");
    const auth = JSON.parse(raw) as Record<string, unknown>;
    const existing = auth[provider];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      JSON.stringify(existing) !== JSON.stringify(credential)
    ) {
      auth[provider] = credential;
      writeFileSync(authPath, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
    }
  } catch {
    // Ignore persistence failures; the caller can still use the refreshed API key.
  }
}

async function resolveSdkApiKey(
  provider: string,
  configKey: string | undefined,
  cwd: string | undefined,
): Promise<string | undefined> {
  if (configKey) {
    return resolveApiKey(provider, configKey);
  }

  const entry = readRawAuthEntry(provider);
  if (entry?.type === "oauth") {
    const result = await resolveOAuthApiKey(provider, entry);
    if (result) {
      if (result.newCredentials) {
        persistRefreshedCredential(provider, { type: "oauth", ...result.newCredentials });
      }
      return result.apiKey;
    }
    if (cwd) {
      logEvent(cwd, "warn", "No OAuth credential found for SDK backend", { provider, backend: "sdk" });
    }
    return undefined;
  }

  return resolveApiKey(provider);
}

function createStreamProgressHandler(
  onProgress: (text: string) => void,
  minIntervalMs = 150,
): { handle(event: AssistantMessageEvent): void; flush(): void } {
  let accumulated = "";
  let lastReported = 0;

  const report = () => {
    lastReported = Date.now();
    onProgress(accumulated);
  };

  return {
    handle(event) {
      if (event.type === "text_delta" && typeof event.delta === "string") {
        accumulated += event.delta;
        if (Date.now() - lastReported >= minIntervalMs) {
          report();
        }
      }
    },
    flush() {
      if (accumulated) report();
    },
  };
}

function sdkPayloadType(payload: unknown): string {
  if (!payload || typeof payload !== "object") return typeof payload;
  const p = payload as Record<string, unknown>;
  return typeof p.type === "string" ? p.type : Object.keys(p).join(",");
}

const OPENCODE_HOST = "opencode.ai";

function matchesHost(baseUrl: string, host: string): boolean {
  try {
    return new URL(baseUrl).host.endsWith(host);
  } catch {
    return baseUrl.includes(host);
  }
}

function isOpencodeProvider(model: { provider: string; baseUrl: string }): boolean {
  return model.provider === "opencode" || model.provider === "opencode-go" || matchesHost(model.baseUrl, OPENCODE_HOST);
}

function buildSdkHeaders(
  model: { provider: string; baseUrl: string },
  sessionId: string | undefined,
): Record<string, string> | undefined {
  if (!isOpencodeProvider(model) || !sessionId) return undefined;
  return {
    "x-opencode-session": sessionId,
    "x-opencode-client": "pi",
  };
}

export async function callSdkBackend(
  provider: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options: CallSecondaryModelOptions & {
    secondary?: SecondaryModelConfig;
    modelInfoOverride?: Partial<ReturnType<typeof resolveModelInfo>>;
    sdkModelInfo?: Partial<ReturnType<typeof resolveModelInfo>>;
  },
): Promise<{ content: string; usage: ReturnType<typeof buildUsage> }> {
  const { signal, thinking, cwd, secondary, modelInfoOverride, sdkModelInfo } = options;

  // Prefer pi-heyyoo's auth resolution (auth.json with indirection, env vars,
  // inline key, or OAuth credential refresh), but fall back to the SDK's own
  // credential/env lookup when no explicit key is configured. The pi-ai SDK can
  // read Pi's CredentialStore (e.g. ~/.pi/agent/auth.json) and provider env vars
  // on its own.
  const apiKey = (await resolveSdkApiKey(provider, secondary?.apiKey, cwd)) ?? undefined;
  if (!apiKey && cwd) {
    logEvent(cwd, "debug", "No explicit API key for SDK backend; relying on SDK credential resolution", {
      provider,
      model,
      backend: "sdk",
    });
  }

  const piAi = await getPiAiCompat();
  const builtinModel = piAi.getModel(provider, model);
  if (!builtinModel) {
    throw new Error(
      `Model "${model}" is not in Pi's built-in catalog for provider "${provider}". ` +
        `Use backend: "pi" to call it through the Pi CLI, or configure a custom baseUrl with backend: "http".`,
    );
  }

  const context: Context = {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userPrompt }],
        timestamp: Date.now(),
      },
    ],
  };

  const sessionId = cwd ? getPiSessionId(cwd) : undefined;
  const sdkOptions: SimpleStreamOptions = {
    apiKey,
    signal,
    sessionId,
    // Mirror the main Pi agent's defaults for cache retention, retries, and
    // HTTP idle timeout. These keep the SDK backend consistent with how Pi
    // itself calls the same providers.
    cacheRetention: secondary?.cacheRetention === "auto" ? "short" : (secondary?.cacheRetention ?? "short"),
    maxRetries: secondary?.maxRetries ?? 3,
    timeoutMs: secondary?.timeoutMs ?? 300_000,
  };

  if (thinking && thinking.toLowerCase() !== "off") {
    sdkOptions.reasoning = thinking as import("@earendil-works/pi-ai").ThinkingLevel;
  }

  if (secondary?.transport) sdkOptions.transport = secondary.transport;
  if (typeof secondary?.maxRetryDelayMs === "number") sdkOptions.maxRetryDelayMs = secondary.maxRetryDelayMs;

  const opencodeHeaders = buildSdkHeaders(builtinModel, sessionId);
  if (opencodeHeaders) {
    sdkOptions.headers = { ...sdkOptions.headers, ...opencodeHeaders };
  }

  if (cwd) {
    sdkOptions.onResponse = (response) => {
      logEvent(cwd, "debug", "SDK provider response", { status: response.status, backend: "sdk" });
    };
    sdkOptions.onPayload = (payload) => {
      logEvent(cwd, "debug", "SDK provider payload", { type: sdkPayloadType(payload), backend: "sdk" });
    };
  }

  // Prefer Pi's catalog metadata, allow user overrides, and fall back to the
  // local registry/default for token budgets.
  const maxOutputTokens =
    sdkModelInfo?.maxOutputTokens ??
    modelInfoOverride?.maxOutputTokens ??
    resolveModelInfo(provider, model).maxOutputTokens;
  const thinkingEnabledForBudget = Boolean(thinking) && thinking?.toLowerCase() !== "off";
  // Reasoning models need the full output budget for internal reasoning tokens.
  // Structured output tasks (review, judge, test, security, etc.) can also exceed
  // a cheap 2048 token cap, so allow the full model limit for those too.
  const structuredOutput = Boolean(options.structuredOutput);
  sdkOptions.maxTokens =
    thinkingEnabledForBudget || structuredOutput ? maxOutputTokens : Math.min(maxOutputTokens, 2048);

  const stream = piAi.streamSimple(builtinModel, context, sdkOptions);

  // Stream progress to the TUI when a callback is provided. We throttle updates
  // to avoid saturating the UI with every token.
  if (options.onStreamProgress) {
    const progress = createStreamProgressHandler(options.onStreamProgress);
    try {
      for await (const event of stream) {
        progress.handle(event);
        if (event.type === "done" || event.type === "error") break;
      }
    } catch {
      // The final result() call will surface the real error; ignore iterator errors.
    }
    progress.flush();
  }

  const message = await stream.result();

  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const detail = message.errorMessage ? `: ${message.errorMessage}` : "";
    throw new Error(`Secondary model request failed (${message.stopReason})${detail}`);
  }

  const content = extractTextFromContent(message.content);
  if (!content) {
    throw new Error(`Secondary model returned no extractable text (stopReason: ${message.stopReason ?? "unknown"})`);
  }

  const usage = buildUsage(provider, model, systemPrompt, userPrompt, content);
  if (message.usage) {
    return {
      content,
      usage: applyReportedUsage(provider, model, usage, message.usage.input, message.usage.output),
    };
  }
  return { content, usage };
}
