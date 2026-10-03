import type { ModelInfo } from "../model-registry.js";
import type { BackendType, ProviderApiInfo, SecondaryModelConfig } from "../types/secondary-model.js";
import { resolveProviderApiInfo } from "./provider-api.js";
import { getPiAiCompat, getSdkRegistry, resolveRuntimeModel } from "./sdk-backend.js";

export function buildModelInfoOverride(
  secondary: SecondaryModelConfig | undefined,
  modelInfo: Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined,
  model: string,
): Partial<ModelInfo> | undefined {
  if (!secondary) return undefined;
  const user = modelInfo?.[model.toLowerCase()];
  const override: { contextWindow?: number; maxOutputTokens?: number } = {};
  if (typeof secondary.contextWindow === "number" && Number.isFinite(secondary.contextWindow)) {
    override.contextWindow = secondary.contextWindow;
  } else if (typeof user?.contextWindow === "number" && Number.isFinite(user.contextWindow)) {
    override.contextWindow = user.contextWindow;
  }
  if (typeof secondary.maxOutputTokens === "number" && Number.isFinite(secondary.maxOutputTokens)) {
    override.maxOutputTokens = secondary.maxOutputTokens;
  } else if (typeof user?.maxOutputTokens === "number" && Number.isFinite(user.maxOutputTokens)) {
    override.maxOutputTokens = user.maxOutputTokens;
  }
  return Object.keys(override).length > 0 ? override : undefined;
}

export async function resolveSdkModelInfo(
  provider: string,
  model: string,
  modelInfoOverride?: Partial<ModelInfo>,
  secondary?: SecondaryModelConfig,
): Promise<Partial<ModelInfo> | undefined> {
  try {
    // Match the SDK streaming route without resolving credentials. Live
    // extension/custom models can differ from the static builtin catalog.
    const registryUsable =
      !secondary?.apiKey &&
      !secondary?.baseUrl &&
      (secondary?.authHeader === undefined || secondary.authHeader === true);
    let builtinModel = registryUsable ? getSdkRegistry()?.find(provider, model) : undefined;
    // The builtin catalog is static; extension providers (e.g. pi-crof) and
    // custom models.json entries only exist in Pi's runtime registry.
    if (!builtinModel) {
      const piAi = await getPiAiCompat();
      builtinModel = piAi.getModel(provider, model) ?? (await resolveRuntimeModel(provider, model));
    }
    if (!builtinModel) return undefined;
    const info: Partial<ModelInfo> = {};
    if (typeof builtinModel.contextWindow === "number" && builtinModel.contextWindow > 0) {
      info.contextWindow = builtinModel.contextWindow;
    }
    if (typeof builtinModel.maxTokens === "number" && builtinModel.maxTokens > 0) {
      info.maxOutputTokens = builtinModel.maxTokens;
    }
    if (typeof modelInfoOverride?.contextWindow === "number" && Number.isFinite(modelInfoOverride.contextWindow)) {
      info.contextWindow = modelInfoOverride.contextWindow;
    }
    if (typeof modelInfoOverride?.maxOutputTokens === "number" && Number.isFinite(modelInfoOverride.maxOutputTokens)) {
      info.maxOutputTokens = modelInfoOverride.maxOutputTokens;
    }
    // A known model with no numeric metadata still counts as resolvable ({})
    // so resolveBackend doesn't needlessly drop to the pi CLI fallback.
    return info;
  } catch {
    return undefined;
  }
}

function shouldUseSdkBackend(_provider: string, secondary?: SecondaryModelConfig): boolean {
  if (secondary?.backend === "sdk") return true;
  if (secondary?.backend) return false;
  // Default every provider to the SDK backend. Pi's provider layer gives better
  // cache management and handles new models automatically; users can opt out via
  // backend: "http"/backend: "pi" or force direct HTTP via baseUrl.
  return true;
}

/** Resolve the effective backend type from config, applying the same defaults as resolveBackend. */
export function resolveBackendType(provider: string, secondary?: SecondaryModelConfig): BackendType {
  const useSdk = shouldUseSdkBackend(provider, secondary);
  return secondary?.backend ?? (secondary?.baseUrl ? "http" : useSdk ? "sdk" : "pi");
}

/** Resolve prompt capacity from the same catalog/overrides as execution,
 * without authentication or a provider request. */
export async function resolveBudgetModel(
  secondary: SecondaryModelConfig,
  modelInfo?: Record<string, Partial<ModelInfo>>,
): Promise<SecondaryModelConfig> {
  const overrides = buildModelInfoOverride(secondary, modelInfo, secondary.id);
  const metadata =
    resolveBackendType(secondary.provider, secondary) === "sdk"
      ? await resolveSdkModelInfo(secondary.provider, secondary.id, overrides, secondary)
      : undefined;
  return { ...secondary, ...metadata, ...overrides };
}

export async function resolveBackend(
  provider: string,
  model: string,
  secondary?: SecondaryModelConfig,
  modelInfo?: Record<string, { contextWindow?: number; maxOutputTokens?: number }>,
): Promise<{
  backend: BackendType;
  apiInfo?: ProviderApiInfo;
  sdkModelInfo?: Partial<ModelInfo>;
  modelInfoOverride?: Partial<ModelInfo>;
}> {
  const explicitBackend = secondary?.backend;
  const backend = explicitBackend ?? (secondary?.baseUrl ? "http" : "sdk");
  const autoSelectedSdk = !explicitBackend && !secondary?.baseUrl;

  const modelInfoOverride = buildModelInfoOverride(secondary, modelInfo, model);
  let sdkModelInfo =
    backend === "sdk" ? await resolveSdkModelInfo(provider, model, modelInfoOverride, secondary) : undefined;

  // If the backend was auto-selected and the model is in neither Pi's built-in
  // SDK catalog nor the runtime registry (resolveSdkModelInfo checked both),
  // fall back to the pi backend so Pi CLI-resolvable providers can still be used.
  let effectiveBackend: BackendType = backend;
  if (backend === "sdk" && autoSelectedSdk && !sdkModelInfo) {
    effectiveBackend = "pi";
    sdkModelInfo = undefined;
  }

  return {
    backend: effectiveBackend,
    apiInfo: effectiveBackend === "http" ? resolveProviderApiInfo(provider, model, secondary) : undefined,
    sdkModelInfo,
    modelInfoOverride,
  };
}
