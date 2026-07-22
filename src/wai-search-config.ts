import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, loadYoowaiConfig } from "./config.js";
import { logEvent } from "./logger.js";
import type { WebSearchProvider } from "./types.js";

const WEB_SEARCH_PROVIDERS: WebSearchProvider[] = ["duckduckgo", "brave"];

let testAgentDir: string | undefined;

/** Test hook: override the agent directory used for auth/settings I/O. */
export function setSearchConfigAgentDirForTests(dir: string): void {
  testAgentDir = dir;
}

/** Test hook: restore the default agent directory. */
export function resetSearchConfigAgentDirForTests(): void {
  testAgentDir = undefined;
}

function effectiveAgentDir(): string {
  return testAgentDir ?? getAgentDir();
}

function resolveBraveApiKeyFromAgentDir(): string | undefined {
  const authPath = join(effectiveAgentDir(), "auth.json");
  if (!existsSync(authPath)) return undefined;
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
    const entry = auth.brave;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      if (e.type === "api_key" && typeof e.key === "string") return e.key;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(path: string, data: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function getSettingsPath(): string {
  return join(effectiveAgentDir(), "settings.json");
}

function getAuthPath(): string {
  return join(effectiveAgentDir(), "auth.json");
}

function getCurrentProvider(cwd: string): WebSearchProvider {
  const config = loadYoowaiConfig(cwd);
  if (config.docs?.webSearch?.provider) return config.docs.webSearch.provider;
  return resolveBraveApiKeyFromAgentDir() || config.docs?.webSearch?.apiKey ? "brave" : "duckduckgo";
}

function providerLabel(provider: WebSearchProvider, hasKey: boolean): string {
  if (provider === "brave") {
    return hasKey ? "Brave Search (API key configured)" : "Brave Search (API key required)";
  }
  return "DuckDuckGo (no API key needed)";
}

function parseArgs(args: string): { provider?: WebSearchProvider; apiKey?: string } {
  const trimmed = args.trim();
  if (!trimmed) return {};
  const tokens: string[] = [];
  const tokenRegex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let tokenMatch: RegExpExecArray | null;
  while ((tokenMatch = tokenRegex.exec(trimmed)) !== null) {
    tokens.push(tokenMatch[1] ?? tokenMatch[2] ?? tokenMatch[0]);
  }
  const provider = tokens[0]?.toLowerCase();
  if (!WEB_SEARCH_PROVIDERS.includes(provider as WebSearchProvider)) return {};
  return {
    provider: provider as WebSearchProvider,
    apiKey: tokens[1],
  };
}

function saveAuthEntry(provider: string, apiKey: string): void {
  const authPath = getAuthPath();
  const auth = readJson(authPath);
  auth[provider] = { type: "api_key", key: apiKey };
  writeJson(authPath, auth);
}

function saveWebSearchProvider(provider: WebSearchProvider): void {
  const settingsPath = getSettingsPath();
  const settings = readJson(settingsPath);
  if (!settings["pi-yoowai"] || typeof settings["pi-yoowai"] !== "object") {
    settings["pi-yoowai"] = {};
  }
  const waiSettings = settings["pi-yoowai"] as Record<string, unknown>;
  if (!waiSettings.docs || typeof waiSettings.docs !== "object") {
    waiSettings.docs = {};
  }
  const docs = waiSettings.docs as Record<string, unknown>;
  if (!docs.webSearch || typeof docs.webSearch !== "object") {
    docs.webSearch = {};
  }
  const webSearch = docs.webSearch as Record<string, unknown>;
  webSearch.provider = provider;
  writeJson(settingsPath, settings);
}

export async function handleWaiSearchConfigCommand(
  args: string,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const cwd = ctx.cwd;
  const config = loadYoowaiConfig(cwd);
  const parsed = parseArgs(args);

  // Inline arg mode: /wai-search-config brave <api-key>
  if (parsed.provider) {
    const isEnabled = config.docs?.webSearch?.enabled ?? false;
    if (!isEnabled) {
      return {
        content: [
          {
            type: "text",
            text:
              "Web search is currently disabled. Enable it first by setting " +
              "pi-yoowai.docs.webSearch.enabled = true in settings.json.",
          },
        ],
      };
    }

    saveWebSearchProvider(parsed.provider);
    if (parsed.provider === "brave" && parsed.apiKey) {
      saveAuthEntry("brave", parsed.apiKey);
      ctx.ui.notify("Brave Search configured and API key saved to auth.json. /reload to apply.", "info");
      return {
        content: [
          {
            type: "text",
            text: `Web search provider set to Brave and API key saved. Run /reload to apply.`,
          },
        ],
      };
    }

    ctx.ui.notify(`Web search provider switched to ${parsed.provider}. /reload to apply.`, "info");
    return {
      content: [
        {
          type: "text",
          text: `Web search provider set to ${parsed.provider}. Run /reload to apply.`,
        },
      ],
    };
  }

  // TUI interactive mode.
  const isEnabled = config.docs?.webSearch?.enabled ?? false;
  if (!isEnabled) {
    return {
      content: [
        {
          type: "text",
          text:
            "Web search is currently disabled. Enable it first by setting " +
            "pi-yoowai.docs.webSearch.enabled = true in settings.json, " +
            "then use /wai-search-config to pick a provider.",
        },
      ],
    };
  }

  const currentProvider = getCurrentProvider(cwd);
  const braveKey = resolveBraveApiKeyFromAgentDir() || config.docs?.webSearch?.apiKey;

  const items = WEB_SEARCH_PROVIDERS.map((p) => {
    const marker = p === currentProvider ? " ✓ current" : "";
    return `${providerLabel(p, p === "brave" ? Boolean(braveKey) : false)}${marker}`;
  });

  try {
    const picked = await ctx.ui.select("Pick web search provider:", items);
    if (!picked) {
      return { content: [{ type: "text", text: "No provider selected. Search configuration unchanged." }] };
    }

    const selectedLabel = picked.replace(" ✓ current", "");
    const selectedProvider = selectedLabel.startsWith("Brave") ? "brave" : "duckduckgo";

    if (selectedProvider === "brave" && !braveKey) {
      ctx.ui.notify(
        "Brave selected. Set the API key with /wai-search-config brave <api-key>, " +
          "add a 'brave' entry to ~/.pi/agent/auth.json, or set BRAVE_API_KEY.",
        "warning",
      );
      saveWebSearchProvider("brave");
      return {
        content: [
          {
            type: "text",
            text:
              "Brave Search selected, but no API key was found. " +
              "Set it with `/wai-search-config brave <api-key>`, add a 'brave' entry to " +
              "~/.pi/agent/auth.json, or set the BRAVE_API_KEY environment variable. " +
              "Run /reload to apply.",
          },
        ],
      };
    }

    saveWebSearchProvider(selectedProvider);
    ctx.ui.notify(`Web search provider switched to ${selectedProvider}. /reload to apply.`, "info");
    return {
      content: [
        {
          type: "text",
          text: `Web search provider set to ${selectedProvider}. Run /reload to apply.`,
        },
      ],
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logEvent(cwd, "warn", "wai-search-config TUI failed", { error });
    return { content: [{ type: "text", text: `Failed to configure web search: ${error}` }] };
  }
}
