import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./config.js";

export function resolveApiKey(provider: string): string | undefined {
  const authPath = join(getAgentDir(), "auth.json");
  if (existsSync(authPath)) {
    try {
      const raw = readFileSync(authPath, "utf-8");
      const auth = JSON.parse(raw) as Record<string, unknown>;
      const entry = auth[provider];
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const e = entry as Record<string, unknown>;
        if (e.type === "api_key" && typeof e.key === "string") {
          return resolveKeyValue(e.key);
        }
      }
    } catch { /* ignore */ }
  }

  const envVar = providerToEnvVar(provider);
  if (envVar && process.env[envVar]) {
    return process.env[envVar];
  }

  return undefined;
}

function resolveKeyValue(key: string): string | undefined {
  if (key.startsWith("!")) {
    try {
      return execSync(key.slice(1), { encoding: "utf-8", timeout: 5000 }).trim();
    } catch {
      return undefined;
    }
  }

  if (key.startsWith("$")) {
    if (key.startsWith("${")) {
      const end = key.indexOf("}");
      if (end > 1) {
        const varName = key.slice(2, end);
        return process.env[varName];
      }
    }
    return process.env[key.slice(1)];
  }

  return key;
}

const PROVIDER_ENV_MAP: Record<string, string> = {
  "opencode-go": "OPENCODE_API_KEY",
  "opencode": "OPENCODE_API_KEY",
  "anthropic": "ANTHROPIC_API_KEY",
  "openai": "OPENAI_API_KEY",
  "deepseek": "DEEPSEEK_API_KEY",
  "openrouter": "OPENROUTER_API_KEY",
  "groq": "GROQ_API_KEY",
  "mistral": "MISTRAL_API_KEY",
  "xai": "XAI_API_KEY",
  "together": "TOGETHER_API_KEY",
  "fireworks": "FIREWORKS_API_KEY",
  "cerebras": "CEREBRAS_API_KEY",
  "google": "GEMINI_API_KEY",
  "nvidia": "NVIDIA_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
  "huggingface": "HF_TOKEN",
};

function providerToEnvVar(provider: string): string | undefined {
  return PROVIDER_ENV_MAP[provider];
}
