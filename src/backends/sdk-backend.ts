import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { resolveApiKey } from "../auth-reader.js";
import { logEvent } from "../logger.js";
import { resolveModelInfo } from "../model-registry.js";
import type { CallSecondaryModelOptions } from "../types.js";
import type { SecondaryModelConfig } from "../types/secondary-model.js";
import { getPiSessionId } from "./pi-backend.js";
import { buildUsage, applyReportedUsage, extractTextFromContent } from "./shared.js";

type PiAiCompatModule = typeof import("@earendil-works/pi-ai/compat");

const sdkOverrides: {
  streamSimple?: PiAiCompatModule["streamSimple"];
  getModel?: PiAiCompatModule["getModel"];
} = {};

/** Test hook: override the pi-ai streamSimple function used by the sdk backend. */
export function setSdkStreamSimpleOverride(fn: PiAiCompatModule["streamSimple"] | null): void {
  sdkOverrides.streamSimple = fn ?? undefined;
}

/** Test hook: override getModel resolution in the sdk backend. */
export function setSdkGetModelOverride(fn: PiAiCompatModule["getModel"] | null): void {
  sdkOverrides.getModel = fn ?? undefined;
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

function sdkPayloadType(payload: unknown): string {
  if (!payload || typeof payload !== "object") return typeof payload;
  const p = payload as Record<string, unknown>;
  return typeof p.type === "string" ? p.type : Object.keys(p).join(",");
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

  const apiKey = resolveApiKey(provider, secondary?.apiKey);
  if (!apiKey) {
    throw new Error(
      `No API key found for provider "${provider}". Set the appropriate environment variable, configure auth.json, ` +
        `or set pi-heyyoo.secondary.apiKey.`,
    );
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

  const sdkOptions: SimpleStreamOptions = {
    apiKey,
    signal,
    sessionId: cwd ? getPiSessionId(cwd) : undefined,
  };

  if (thinking && thinking.toLowerCase() !== "off") {
    sdkOptions.reasoning = thinking as import("@earendil-works/pi-ai").ThinkingLevel;
  }

  if (secondary?.cacheRetention) sdkOptions.cacheRetention = secondary.cacheRetention;
  if (secondary?.transport) sdkOptions.transport = secondary.transport;
  if (typeof secondary?.maxRetries === "number") sdkOptions.maxRetries = secondary.maxRetries;
  if (typeof secondary?.maxRetryDelayMs === "number") sdkOptions.maxRetryDelayMs = secondary.maxRetryDelayMs;
  if (typeof secondary?.timeoutMs === "number") sdkOptions.timeoutMs = secondary.timeoutMs;

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
  sdkOptions.maxTokens = thinkingEnabledForBudget ? maxOutputTokens : Math.min(maxOutputTokens, 2048);

  const stream = piAi.streamSimple(builtinModel, context, sdkOptions);
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
