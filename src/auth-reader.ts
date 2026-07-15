import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { getAgentDir } from "./config.js";
import { logEvent } from "./logger.js";

const SHELL_METACHARACTERS = /[;|&$()`{}[\]<>\\]/;

const ALLOWED_COMMANDS = new Set([
  "op",
  "1password-cli",
  "security",
  "gpg",
  "pass",
  "bw",
  "rbw",
  "lpass",
  "cat",
  "echo",
]);

export function readRawAuthEntry(provider: string): Record<string, unknown> | undefined {
  const authPath = join(getAgentDir(), "auth.json");
  if (!existsSync(authPath)) return undefined;
  try {
    const raw = readFileSync(authPath, "utf-8");
    const auth = JSON.parse(raw) as Record<string, unknown>;
    const entry = auth[provider];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return entry as Record<string, unknown>;
    }
  } catch {
    /* ignore parse errors */
  }
  return undefined;
}

export function resolveApiKey(provider: string, configKey?: string): string | undefined {
  if (configKey) {
    return resolveKeyValue(configKey);
  }

  const entry = readRawAuthEntry(provider);
  if (entry) {
    if (entry.type === "api_key" && typeof entry.key === "string") {
      return resolveKeyValue(entry.key);
    }
    // OAuth credentials are handled by resolveOAuthApiKey, not here.
    return undefined;
  }

  const envVar = providerToEnvVar(provider);
  if (envVar && process.env[envVar]) {
    return process.env[envVar];
  }

  return undefined;
}

function resolveKeyValue(key: string): string | undefined {
  if (key.startsWith("!")) {
    const command = key.slice(1).trim();
    try {
      return runAllowedCommand(command);
    } catch (err) {
      logEvent(process.cwd(), "warn", "Disallowed or failed auth command", {
        command: command.split(/\s+/)[0],
        error: err instanceof Error ? err.message : String(err),
      });
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
      return undefined;
    }
    return process.env[key.slice(1)];
  }

  return key;
}

function runAllowedCommand(command: string): string | undefined {
  if (SHELL_METACHARACTERS.test(command) || command.includes("\n") || command.includes("\r")) {
    throw new Error("Auth command contains disallowed shell characters");
  }

  const tokens = tokenize(command);
  if (tokens.length === 0) return undefined;

  const [program, ...args] = tokens;
  if (!ALLOWED_COMMANDS.has(program)) {
    throw new Error(`Auth command "${program}" is not in the allowlist`);
  }

  if (program === "cat" || program === "echo") {
    for (const arg of args) {
      if (!isSafeFileArg(arg)) {
        throw new Error(`Auth command file argument is not allowed: ${arg}`);
      }
    }
  }

  const output = execFileSync(program, args, {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return output.trim();
}

function isSafeFileArg(arg: string): boolean {
  if (arg.startsWith("-") || arg.includes("\0")) return false;
  if (arg.includes("..") || isAbsolute(arg)) return false;
  const resolved = normalize(resolve(getAgentDir(), arg));
  const normalizedAgentDir = normalize(getAgentDir());
  return resolved === normalizedAgentDir || resolved.startsWith(normalizedAgentDir + sep);
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: "'" | '"' | null = null;
  for (const ch of command) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  if (inQuote) throw new Error("Unclosed quote in auth command");
  return tokens;
}

// Providers with multiple env var candidates (checked in order, first match wins).
// Matches Pi's env-api-keys.ts precedence.
const PROVIDER_ENV_MAP_MULTI: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
};

const PROVIDER_ENV_MAP: Record<string, string> = {
  "opencode-go": "OPENCODE_API_KEY",
  opencode: "OPENCODE_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  xai: "XAI_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  google: "GEMINI_API_KEY",
  // ── Additional providers (matched from Pi's env-api-keys.ts) ──
  "ant-ling": "ANT_LING_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  huggingface: "HF_TOKEN",
  moonshotai: "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
  "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  zai: "ZAI_API_KEY",
  "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
};

function providerToEnvVar(provider: string): string | undefined {
  // Check multi-env-var providers first (e.g. anthropic has OAUTH_TOKEN + API_KEY)
  const multi = PROVIDER_ENV_MAP_MULTI[provider];
  if (multi) {
    for (const envVar of multi) {
      if (process.env[envVar]) return envVar;
    }
    return multi[0]; // return primary for error messages
  }
  return PROVIDER_ENV_MAP[provider];
}
