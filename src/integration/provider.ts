import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { loadYoowaiConfig } from "../config.js";
import { resolveApiKey } from "../auth-reader.js";
import { logEvent } from "../logger.js";

export type ModelLookup = (provider: string, modelId: string) => Promise<Model<Api> | undefined>;
export type ApiKeyResolver = (provider: string, configKey?: string) => string | undefined;

const registeredCwds = new Set<string>();
const apiKeyCache = new Map<string, string>();

type PiModel = Model<Api>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function resolveBaseUrl(secondaryBaseUrl: string | undefined, modelBaseUrl: string): string | undefined {
  return isNonEmptyString(secondaryBaseUrl)
    ? secondaryBaseUrl
    : isNonEmptyString(modelBaseUrl)
      ? modelBaseUrl
      : undefined;
}

async function defaultLookupModel(provider: string, modelId: string): Promise<PiModel | undefined> {
  try {
    const compat = await import("@earendil-works/pi-ai/compat");
    if (typeof compat.getModel !== "function") return undefined;
    return compat.getModel(provider, modelId) as PiModel | undefined;
  } catch {
    return undefined;
  }
}

/** Register the configured secondary model as a Pi provider named "wai".
 *  This is config-gated (`registerProvider: true`) and uses Pi's own model
 *  registry to avoid guessing API types. If the model is not known to Pi or the
 *  registry is unavailable, we skip registration with a warning. */
export async function registerWaiProvider(
  pi: ExtensionAPI,
  cwd: string,
  lookupModel: ModelLookup = defaultLookupModel,
  resolveKey: ApiKeyResolver = resolveApiKey,
): Promise<void> {
  try {
    const config = loadYoowaiConfig(cwd);
    if (config.registerProvider !== true) return;

    const secondary = config.secondary;
    if (!secondary.provider || !secondary.id) {
      logEvent(cwd, "warn", "registerProvider skipped: secondary provider/id not configured", {});
      return;
    }

    let apiKey = apiKeyCache.get(cwd);
    if (!apiKey) {
      apiKey = resolveKey(secondary.provider, secondary.apiKey);
      if (apiKey) {
        apiKeyCache.set(cwd, apiKey);
      }
    }
    if (!apiKey) {
      logEvent(cwd, "warn", "registerProvider skipped: no API key resolved", { provider: secondary.provider });
      return;
    }

    const builtin = await lookupModel(secondary.provider, secondary.id);
    if (!builtin) {
      logEvent(cwd, "warn", "registerProvider skipped: model not found in Pi registry", {
        provider: secondary.provider,
        model: secondary.id,
      });
      return;
    }

    const baseUrl = resolveBaseUrl(secondary.baseUrl, builtin.baseUrl);
    const contextWindow =
      typeof secondary.contextWindow === "number" && Number.isFinite(secondary.contextWindow)
        ? secondary.contextWindow
        : builtin.contextWindow;
    const maxTokens =
      typeof secondary.maxOutputTokens === "number" && Number.isFinite(secondary.maxOutputTokens)
        ? secondary.maxOutputTokens
        : builtin.maxTokens;

    const authHeader = typeof secondary.authHeader === "boolean" ? secondary.authHeader : true;

    const providerConfig: ProviderConfig = {
      name: `Wai — ${secondary.provider}/${secondary.id}`,
      baseUrl,
      apiKey,
      api: builtin.api,
      authHeader,
      models: [
        {
          id: secondary.id,
          name: `${secondary.id} (wai)`,
          reasoning: builtin.reasoning,
          input: builtin.input,
          cost: builtin.cost,
          contextWindow,
          maxTokens,
          headers: builtin.headers,
          compat: builtin.compat,
        },
      ],
    };

    pi.registerProvider("wai", providerConfig);
    registeredCwds.add(cwd);
  } catch (err) {
    logEvent(cwd, "error", "registerProvider failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Unregister the wai provider if this cwd previously registered it.
 *  Called on session shutdown/switch/fork to avoid leaking a provider across
 *  sessions or leaving stale model config in Pi's catalog. */
export function unregisterWaiProvider(pi: ExtensionAPI, cwd: string): void {
  if (!registeredCwds.has(cwd)) return;
  try {
    pi.unregisterProvider("wai");
  } catch {
    // best-effort cleanup
  }
  registeredCwds.delete(cwd);
  apiKeyCache.delete(cwd);
}

/** Refresh the wai provider registration after settings change.
 *  Clears the cached API key and re-registers if registerProvider is enabled. */
export async function refreshWaiProvider(pi: ExtensionAPI, cwd: string): Promise<void> {
  unregisterWaiProvider(pi, cwd);
  await registerWaiProvider(pi, cwd);
}
