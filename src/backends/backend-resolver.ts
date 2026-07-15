import type { ModelInfo } from "../model-registry.js";
import type { BackendType, ProviderApiInfo, SecondaryModelConfig } from "../types/secondary-model.js";
import { resolveProviderApiInfo } from "./provider-api.js";
import { getPiAiCompat } from "./sdk-backend.js";

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
): Promise<Partial<ModelInfo> | undefined> {
  try {
    const piAi = await getPiAiCompat();
    const builtinModel = piAi.getModel(provider, model);
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
    return Object.keys(info).length > 0 ? info : undefined;
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
  let sdkModelInfo = backend === "sdk" ? await resolveSdkModelInfo(provider, model, modelInfoOverride) : undefined;

  // If the backend was auto-selected and the model is not in Pi's built-in SDK
  // catalog, fall back to the pi backend so extension-registered providers
  // (e.g. pi-cursor-provider) can still be used.
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
