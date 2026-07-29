import type { AssistantMessageEvent, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { readRawAuthEntry, resolveApiKey } from "../auth-reader.js";
import { getAgentDir } from "../config.js";
import { logEvent } from "../logger.js";
import { resolveModelInfo } from "../model-registry.js";
import { clearCachedOAuthApiKey, getCachedOAuthApiKey, setCachedOAuthApiKey } from "../oauth-cache.js";
import type { CallSecondaryModelOptions } from "../types.js";
import type { SecondaryModelConfig } from "../types/secondary-model.js";
import { getPiSessionId } from "./pi-backend.js";
import { buildUsage, applyReportedUsage, extractTextFromContent, isLengthStop } from "./shared.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type PiAiCompatModule = typeof import("@earendil-works/pi-ai/compat");
type PiAiOAuthModule = typeof import("@earendil-works/pi-ai/oauth");
type PiAiProvidersAllModule = typeof import("@earendil-works/pi-ai/providers/all");
type PiModelRuntimeModule = typeof import("@earendil-works/pi-coding-agent");
// ModelRuntime has a private constructor; derive the instance type from create().
type PiModelRuntime = Awaited<ReturnType<PiModelRuntimeModule["ModelRuntime"]["create"]>>;

/** Shared Pi ModelRuntime (lazy singleton). Uses Pi's own locked auth.json
 *  AuthStorage, so OAuth refreshes are serialized with the main Pi agent —
 *  no double-refresh of a rotated token. */
let modelRuntimePromise: Promise<PiModelRuntime> | undefined;

async function getModelRuntime(): Promise<PiModelRuntime | undefined> {
  try {
    const { ModelRuntime } = (await import("@earendil-works/pi-coding-agent")) as PiModelRuntimeModule;
    if (typeof ModelRuntime?.create !== "function") return undefined;
    modelRuntimePromise ??= ModelRuntime.create({ authPath: join(getAgentDir(), "auth.json") });
    return await modelRuntimePromise;
  } catch {
    return undefined;
  }
}

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

/** Test hook: clear the OAuth API-key cache. */
export function clearSdkOAuthCache(): void {
  oauthApiKeyCache.clear();
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

/** Result of OAuth resolution: either a plain API key or provider-computed
 *  request headers (e.g. Kimi Coding's `Authorization: Bearer ...`, which must
 *  NOT be sent as an `x-api-key`). */
interface OAuthResolution {
  apiKey?: string;
  headers?: Record<string, string | null>;
  newCredentials?: Record<string, unknown>;
}

const oauthApiKeyCache = new Map<string, { credential: Record<string, unknown>; resolution: OAuthResolution }>();

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

/** Extract an OAuthResolution from a pi-ai AuthResult-shaped value
 *  (`{ auth: { apiKey? | headers? }, source? }`). Returns undefined when the
 *  result carries no usable auth. */
function extractAuthResolution(result: unknown): OAuthResolution | undefined {
  const auth = (result as { auth?: { apiKey?: unknown; headers?: Record<string, unknown> } } | undefined)?.auth;
  const apiKey = auth?.apiKey;
  const headers = auth?.headers;
  const hasApiKey = typeof apiKey === "string" && apiKey.length > 0;
  const hasHeaders = headers !== undefined && Object.values(headers).some((v) => typeof v === "string" && v.length > 0);
  if (!hasApiKey && !hasHeaders) return undefined;
  return {
    apiKey: hasApiKey ? (apiKey as string) : undefined,
    headers: hasHeaders ? (headers as Record<string, string | null>) : undefined,
  };
}

/** Warn-log an OAuth provider that resolved to no usable auth. Logs field
 *  names and expiry only — never token values — to tell apart an unconfigured
 *  provider from a legacy-shaped credential (e.g. accessToken/refreshToken
 *  instead of access/refresh). */
function logNoOAuthAuth(
  cwd: string,
  provider: string,
  via: string,
  result: unknown,
  credential: Record<string, unknown>,
): void {
  logEvent(cwd, "warn", "OAuth provider resolved no auth", {
    provider,
    via,
    hasResult: result !== undefined,
    source: (result as { source?: unknown } | undefined)?.source,
    credentialKeys: Object.keys(credential).filter((k) => k !== "access" && k !== "refresh" && k !== "key"),
    hasAccess: typeof credential.access === "string",
    hasRefresh: typeof credential.refresh === "string",
    expires: typeof credential.expires === "number" ? new Date(credential.expires).toISOString() : undefined,
  });
}

async function fetchOAuthApiKey(
  provider: string,
  credential: Record<string, unknown>,
  cwd: string | undefined,
): Promise<OAuthResolution | undefined> {
  if (oauthResolverOverride) {
    return oauthResolverOverride(provider, credential);
  }
  // Preferred path: Pi's own ModelRuntime, whose AuthStorage refreshes OAuth
  // tokens inside a proper-lockfile lock on auth.json. Sharing it keeps
  // pi-yoowai from racing Pi itself on refresh-token rotation (which used to
  // force re-logins for rotating providers like kimi-coding).
  try {
    const runtime = await getModelRuntime();
    if (runtime) {
      const result = await runtime.getAuth(provider);
      const resolution = extractAuthResolution(result);
      if (resolution) return resolution;
      // The runtime answered authoritatively over the same locked store; an
      // empty answer means there is no usable credential — don't retry unlocked.
      if (cwd) logNoOAuthAuth(cwd, provider, "ModelRuntime", result, credential);
      return undefined;
    }
  } catch (err) {
    if (cwd) {
      logEvent(cwd, "warn", "OAuth resolution via Pi ModelRuntime failed; falling back to pi-ai Models.getAuth", {
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Fallback: pi-ai ≥ 0.82 removed getOAuthApiKey; Models.getAuth() is the
  // replacement. NOTE: bare createModels() starts with ZERO providers —
  // builtinModels() registers the built-in catalog, which is what makes the
  // provider known. getAuth resolves OAuth credentials through our
  // auth.json-backed store and runs the token refresh under the store's
  // modify() (persisted to auth.json there).
  try {
    const providersAll = (await import("@earendil-works/pi-ai/providers/all")) as PiAiProvidersAllModule;
    if (typeof providersAll.builtinModels === "function") {
      const models = providersAll.builtinModels({ credentials: authJsonCredentialStore() });
      const result = await models.getAuth(provider);
      const resolution = extractAuthResolution(result);
      // Refreshed credentials were already persisted by the store's modify();
      // there are no out-of-band newCredentials to write back.
      if (resolution) return resolution;
      if (cwd) logNoOAuthAuth(cwd, provider, "builtinModels", result, credential);
    } else if (cwd) {
      logEvent(cwd, "debug", "pi-ai has no builtinModels; using legacy OAuth path", { provider });
    }
  } catch (err) {
    if (cwd) {
      logEvent(cwd, "warn", "OAuth resolution via Models.getAuth failed", {
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // pi-ai ≤ 0.81 legacy OAuth exchange.
  try {
    const oauth = (await import("@earendil-works/pi-ai/oauth")) as PiAiOAuthModule;
    if (typeof oauth.getOAuthApiKey !== "function") return undefined;
    return await oauth.getOAuthApiKey(provider, { [provider]: credential });
  } catch {
    return undefined;
  }
}

function readAuthJson(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeAuthJson(auth: Record<string, unknown>): void {
  try {
    writeFileSync(join(getAgentDir(), "auth.json"), JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  } catch {
    // Best-effort; the in-memory credential still serves this session.
  }
}

type StoredCredential = import("@earendil-works/pi-ai").Credential;

/** CredentialStore over ~/.pi/agent/auth.json for pi-ai ≥ 0.82 Models.getAuth().
 *  modify() is pi-ai's only write path (OAuth refresh runs inside it), so
 *  persisting there keeps refreshed tokens on disk for the next call. */
function authJsonCredentialStore(): import("@earendil-works/pi-ai").CredentialStore {
  return {
    read(providerId) {
      return Promise.resolve(readAuthJson()[providerId] as StoredCredential | undefined);
    },
    list() {
      const entries = Object.entries(readAuthJson()).flatMap(([providerId, value]) => {
        const type = (value as { type?: unknown } | undefined)?.type;
        return type === "api_key" || type === "oauth" ? [{ providerId, type } as const] : [];
      });
      return Promise.resolve(entries);
    },
    async modify(providerId, fn) {
      const auth = readAuthJson();
      const next = await fn(auth[providerId] as StoredCredential | undefined);
      if (next && JSON.stringify(next) !== JSON.stringify(auth[providerId])) {
        auth[providerId] = next;
        writeAuthJson(auth);
      }
      return (next ?? auth[providerId]) as StoredCredential | undefined;
    },
    delete(providerId) {
      const auth = readAuthJson();
      if (providerId in auth) {
        delete auth[providerId];
        writeAuthJson(auth);
      }
      return Promise.resolve();
    },
  };
}

async function resolveOAuthApiKey(
  provider: string,
  credential: Record<string, unknown>,
  cwd: string | undefined,
): Promise<OAuthResolution | undefined> {
  const cached = oauthApiKeyCache.get(provider);
  if (cached && JSON.stringify(cached.credential) === JSON.stringify(credential)) {
    return cached.resolution;
  }
  if (cwd) {
    const diskKey = getCachedOAuthApiKey(cwd, provider, credential);
    if (diskKey) {
      const resolution: OAuthResolution = { apiKey: diskKey };
      oauthApiKeyCache.set(provider, { credential, resolution });
      return resolution;
    }
  }
  const result = await fetchOAuthApiKey(provider, credential, cwd);
  if (result && (result.apiKey || result.headers)) {
    const resolution: OAuthResolution = { apiKey: result.apiKey, headers: result.headers };
    oauthApiKeyCache.set(provider, { credential, resolution });
    // The disk cache is only meaningful for apiKey-shaped results; header-shaped
    // auth (e.g. Kimi Bearer) is cheap to re-derive via getAuth when the stored
    // credential is still valid — no network call happens in that case.
    if (cwd && result.apiKey) {
      const expiresAt =
        result.newCredentials && typeof result.newCredentials.expiresAt === "number"
          ? result.newCredentials.expiresAt
          : undefined;
      setCachedOAuthApiKey(cwd, provider, credential, result.apiKey, expiresAt);
    }
  }
  return result;
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

async function resolveSdkAuth(
  provider: string,
  configKey: string | undefined,
  cwd: string | undefined,
): Promise<{ apiKey?: string; headers?: Record<string, string | null> } | undefined> {
  if (configKey) {
    const apiKey = resolveApiKey(provider, configKey);
    return apiKey ? { apiKey } : undefined;
  }

  const entry = readRawAuthEntry(provider);
  if (entry?.type === "oauth") {
    const result = await resolveOAuthApiKey(provider, entry, cwd);
    if (result) {
      if (result.newCredentials) {
        persistRefreshedCredential(provider, { type: "oauth", ...result.newCredentials });
      }
      return { apiKey: result.apiKey, headers: result.headers };
    }
    if (cwd) {
      logEvent(cwd, "warn", "No OAuth credential found for SDK backend", { provider, backend: "sdk" });
    }
    return undefined;
  }

  const apiKey = resolveApiKey(provider);
  return apiKey ? { apiKey } : undefined;
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

/** True when the provider rejected the presented credentials (expired or
 *  revoked token/key), as opposed to a network, rate-limit, or server error. */
function isAuthRejectedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("401") || msg.includes("authentication_error") || msg.includes("invalid or may have expired");
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
): Promise<{ content: string; usage: ReturnType<typeof buildUsage>; truncated?: boolean }> {
  const { signal, thinking, cwd, secondary, modelInfoOverride, sdkModelInfo } = options;

  // Prefer pi-yoowai's auth resolution (auth.json with indirection, env vars,
  // inline key, or OAuth credential refresh), but fall back to the SDK's own
  // credential/env lookup when no explicit key is configured. The pi-ai SDK can
  // read Pi's CredentialStore (e.g. ~/.pi/agent/auth.json) and provider env vars
  // on its own.
  const sdkAuth = await resolveSdkAuth(provider, secondary?.apiKey, cwd);
  if (!sdkAuth?.apiKey && !sdkAuth?.headers && cwd) {
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

  const attempt = async (
    auth: Awaited<ReturnType<typeof resolveSdkAuth>>,
  ): Promise<{ content: string; usage: ReturnType<typeof buildUsage>; truncated?: boolean }> => {
    const sdkOptions: SimpleStreamOptions = {
      apiKey: auth?.apiKey,
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

    // OAuth providers that compute request headers (e.g. Kimi Coding's Bearer
    // Authorization) must not have them squeezed into x-api-key — apply them
    // first so nothing else clobbers them.
    if (auth?.headers) {
      sdkOptions.headers = { ...auth.headers, ...sdkOptions.headers };
    }

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

    // stopReason "length" means the model hit its output-token cap before finishing.
    // Surface that so the caller can issue a continuation call instead of returning
    // an incomplete response silently.
    const truncated = isLengthStop(message.stopReason);

    const usage = buildUsage(provider, model, systemPrompt, userPrompt, content);
    if (message.usage) {
      return {
        content,
        usage: applyReportedUsage(provider, model, usage, message.usage.input, message.usage.output),
        truncated,
      };
    }
    return { content, usage, truncated };
  };

  try {
    return await attempt(sdkAuth);
  } catch (err) {
    // Short-lived OAuth access tokens (Kimi Coding's live ~15 minutes) can
    // expire between resolution and the provider call: re-resolve — which
    // refreshes under the auth.json lock or picks up a credential another
    // process just refreshed — and retry exactly once.
    if (secondary?.apiKey || !isAuthRejectedError(err) || readRawAuthEntry(provider)?.type !== "oauth") {
      throw err;
    }
    if (cwd) {
      logEvent(cwd, "warn", "Provider rejected the OAuth credential; re-resolving and retrying once", {
        provider,
        model,
        backend: "sdk",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    oauthApiKeyCache.delete(provider);
    if (cwd) clearCachedOAuthApiKey(cwd, provider);
    const freshAuth = await resolveSdkAuth(provider, undefined, cwd);
    try {
      return await attempt(freshAuth);
    } catch (retryErr) {
      if (isAuthRejectedError(retryErr)) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        throw new Error(
          `${msg} — the OAuth credential for "${provider}" was rejected again after re-resolution. ` +
            `Run /login in Pi to re-authenticate, then retry.`,
          { cause: retryErr },
        );
      }
      throw retryErr;
    }
  }
}
