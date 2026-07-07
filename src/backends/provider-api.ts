import type { ProviderApiInfo, SecondaryModelConfig } from "../types/secondary-model.js";

const PROVIDER_API_MAP: Record<string, ProviderApiInfo> = {
  // Note: opencode-go and opencode are intentionally excluded from the HTTP map.
  // Their models have complex compat requirements (per-model API styles, 8+
  // thinking formats, max_completion_tokens vs max_tokens, reasoning_effort
  // mapping) that pi-heyyoo cannot replicate without duplicating Pi's entire
  // openai-completions compat layer. They default to the sdk backend which uses
  // Pi's pi-ai provider layer directly; users can still force the pi process via
  // backend: "pi".
  anthropic: {
    style: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    authHeader: "x-api-key",
    authPrefix: "",
  },
  openai: {
    style: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  deepseek: {
    style: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  openrouter: {
    style: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  groq: {
    style: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  mistral: {
    style: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  xai: {
    style: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  together: {
    style: "openai-compatible",
    baseUrl: "https://api.together.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  fireworks: {
    style: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  cerebras: {
    style: "openai-compatible",
    baseUrl: "https://api.cerebras.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  google: {
    style: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    authHeader: "x-goog-api-key",
    authPrefix: "",
    supportsJsonObject: true,
  },
  // ── Additional providers (matched from Pi's built-in provider list) ──
  "ant-ling": {
    style: "openai-compatible",
    baseUrl: "https://api.ant-ling.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  nvidia: {
    style: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  huggingface: {
    style: "openai-compatible",
    baseUrl: "https://router.huggingface.co/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  moonshotai: {
    style: "openai-compatible",
    baseUrl: "https://api.moonshot.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  "moonshotai-cn": {
    style: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  xiaomi: {
    style: "openai-compatible",
    baseUrl: "https://api.xiaomimimo.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  "xiaomi-token-plan-ams": {
    style: "openai-compatible",
    baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  "xiaomi-token-plan-cn": {
    style: "openai-compatible",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  "xiaomi-token-plan-sgp": {
    style: "openai-compatible",
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  zai: {
    style: "openai-compatible",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  "zai-coding-cn": {
    style: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  // ── Anthropic-style providers ──
  "kimi-coding": {
    style: "anthropic",
    baseUrl: "https://api.kimi.com/coding/v1",
    authHeader: "x-api-key",
    authPrefix: "",
  },
  minimax: {
    style: "anthropic",
    baseUrl: "https://api.minimax.io/anthropic/v1",
    authHeader: "x-api-key",
    authPrefix: "",
  },
  "minimax-cn": {
    style: "anthropic",
    baseUrl: "https://api.minimaxi.com/anthropic/v1",
    authHeader: "x-api-key",
    authPrefix: "",
  },
  "vercel-ai-gateway": {
    style: "anthropic",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    authHeader: "x-api-key",
    authPrefix: "",
  },
};

// Per-model API style overrides for providers that have mixed API styles.
// Key format: "provider:model". When present, this overrides the provider-level
// entry in PROVIDER_API_MAP for that specific model.
// Note: all providers now default to the SDK backend. Pi's provider layer gives
// better cache management and handles new-model compat automatically. The direct
// HTTP map is still used when backend: "http" is set or a custom baseUrl is
// configured. Users can still force the pi process via `backend: "pi"`.
const MODEL_API_OVERRIDES: Record<string, ProviderApiInfo> = {};

export function getProviderApiInfo(provider: string, model?: string): ProviderApiInfo | undefined {
  const p = provider.toLowerCase();
  // Check per-model override first
  if (model) {
    const overrideKey = `${p}:${model}`;
    const override = MODEL_API_OVERRIDES[overrideKey];
    if (override) return override;
  }
  return PROVIDER_API_MAP[p];
}

export function resolveProviderApiInfo(
  provider: string,
  model: string,
  secondary?: SecondaryModelConfig,
): ProviderApiInfo | undefined {
  if (secondary?.baseUrl) {
    const style = secondary.style ?? "openai-compatible";
    if (style !== "openai-compatible" && style !== "anthropic") {
      throw new Error(`Unsupported secondary style: ${style}. Use "openai-compatible" or "anthropic".`);
    }
    return {
      style,
      baseUrl: secondary.baseUrl.replace(/\/$/, ""),
      authHeader: secondary.authHeader ?? (style === "anthropic" ? "x-api-key" : "Authorization"),
      authPrefix: secondary.authPrefix ?? (style === "anthropic" ? "" : "Bearer "),
      supportsJsonObject: style === "openai-compatible",
    };
  }
  return getProviderApiInfo(provider, model);
}

/** Returns true when the effective provider supports OpenAI-style json_object structured output. */
export function providerSupportsJsonObject(
  provider: string,
  model?: string,
  secondary?: SecondaryModelConfig,
): boolean {
  const apiInfo = resolveProviderApiInfo(provider, model || "", secondary);
  return apiInfo?.supportsJsonObject === true;
}

export function getSupportedProviders(): string[] {
  return Object.keys(PROVIDER_API_MAP);
}
