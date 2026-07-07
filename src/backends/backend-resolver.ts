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
  const useSdk = shouldUseSdkBackend(provider, secondary);
  const backend = secondary?.backend ?? (secondary?.baseUrl ? "http" : useSdk ? "sdk" : "pi");

  const modelInfoOverride = buildModelInfoOverride(secondary, modelInfo, model);
  const sdkModelInfo = backend === "sdk" ? await resolveSdkModelInfo(provider, model, modelInfoOverride) : undefined;

  return {
    backend,
    apiInfo: backend === "http" ? resolveProviderApiInfo(provider, model, secondary) : undefined,
    sdkModelInfo,
    modelInfoOverride,
  };
}
