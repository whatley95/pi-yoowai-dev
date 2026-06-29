import { resolveApiKey } from "./auth-reader.js";
import type { ProviderApiInfo } from "./types.js";

const PROVIDER_API_MAP: Record<string, ProviderApiInfo> = {
  "opencode-go": {
    style: "openai-compatible",
    baseUrl: "https://go.opencode.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "opencode": {
    style: "openai-compatible",
    baseUrl: "https://zen.opencode.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "anthropic": {
    style: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    authHeader: "x-api-key",
    authPrefix: "",
  },
  "openai": {
    style: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "deepseek": {
    style: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "openrouter": {
    style: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "groq": {
    style: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "mistral": {
    style: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "xai": {
    style: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "together": {
    style: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "fireworks": {
    style: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "cerebras": {
    style: "openai-compatible",
    baseUrl: "https://api.cerebras.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  "google": {
    style: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    authHeader: "x-goog-api-key",
    authPrefix: "",
  },
};

export function getProviderApiInfo(provider: string): ProviderApiInfo | undefined {
  return PROVIDER_API_MAP[provider];
}

export async function callSecondaryModel(
  provider: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const apiInfo = getProviderApiInfo(provider);
  if (!apiInfo) {
    throw new Error(`Unknown provider: ${provider}. Supported providers: ${Object.keys(PROVIDER_API_MAP).join(", ")}`);
  }

  const apiKey = resolveApiKey(provider);
  if (!apiKey) {
    throw new Error(`No API key found for provider "${provider}". Set the appropriate environment variable or configure auth.json.`);
  }

  if (apiInfo.style === "anthropic") {
    return callAnthropicApi(apiInfo, apiKey, model, systemPrompt, userPrompt, signal);
  }

  return callOpenAiCompatibleApi(apiInfo, apiKey, model, systemPrompt, userPrompt, signal);
}

async function callOpenAiCompatibleApi(
  apiInfo: ProviderApiInfo,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${apiInfo.baseUrl}/chat/completions`;

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 2048,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [apiInfo.authHeader]: `${apiInfo.authPrefix}${apiKey}`,
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(`Secondary model API error (${response.status}): ${text.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Empty response from secondary model");
  }

  return content;
}

async function callAnthropicApi(
  apiInfo: ProviderApiInfo,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${apiInfo.baseUrl}/messages`;

  const body = {
    model,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [
      { role: "user", content: userPrompt },
    ],
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [apiInfo.authHeader]: `${apiInfo.authPrefix}${apiKey}`,
    "anthropic-version": "2023-06-01",
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(`Secondary model API error (${response.status}): ${text.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const textContent = data.content?.find((c) => c.type === "text")?.text;
  if (!textContent) {
    throw new Error("Empty response from secondary model");
  }

  return textContent;
}