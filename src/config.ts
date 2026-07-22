import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getProjectConfigPath } from "./pi-paths.js";
import { logEvent } from "./logger.js";
import type { YoowaiConfig, SecondaryModelConfig, WaiModelTask, DocsConfig } from "./types.js";

export { getAgentDir, getProjectConfigPath } from "./pi-paths.js";

function isValidBackend(value: unknown): value is "pi" | "http" | "sdk" {
  return value === "pi" || value === "http" || value === "sdk";
}

function pickOptionalString(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function pickOptionalAuthHeader(value: unknown, fallback: string | boolean | undefined): string | boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && value.length > 0) return value;
  return fallback;
}

function pickOptionalNumber(value: unknown, fallback: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function pickOptionalThinking(value: unknown, fallback: string | undefined): string | undefined {
  if (value === undefined || value === null) return fallback;
  return typeof value === "string" ? value : fallback;
}

function pickOptionalStyle(value: unknown, fallback: SecondaryModelConfig["style"]): SecondaryModelConfig["style"] {
  if (value === "openai-compatible" || value === "anthropic") return value;
  return fallback;
}

function pickOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T | undefined,
): T | undefined {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function mergeSecondaryFields(
  base: Partial<SecondaryModelConfig>,
  override: Partial<SecondaryModelConfig>,
): Partial<SecondaryModelConfig> {
  return {
    provider: pickOptionalString(override.provider, base.provider),
    id: pickOptionalString(override.id, base.id),
    thinking: pickOptionalThinking(override.thinking, base.thinking),
    contextWindow: pickOptionalNumber(override.contextWindow, base.contextWindow),
    maxOutputTokens: pickOptionalNumber(override.maxOutputTokens, base.maxOutputTokens),
    backend: isValidBackend(override.backend) ? override.backend : base.backend,
    baseUrl: pickOptionalString(override.baseUrl, base.baseUrl),
    apiKey: pickOptionalString(override.apiKey, base.apiKey),
    cacheRetention: pickOptionalEnum(override.cacheRetention, ["none", "short", "long"], base.cacheRetention),
    transport: pickOptionalEnum(override.transport, ["sse", "websocket", "websocket-cached", "auto"], base.transport),
    maxRetries: pickOptionalNumber(override.maxRetries, base.maxRetries),
    maxRetryDelayMs: pickOptionalNumber(override.maxRetryDelayMs, base.maxRetryDelayMs),
    timeoutMs: pickOptionalNumber(override.timeoutMs, base.timeoutMs),
    style: pickOptionalStyle(override.style, base.style),
    authHeader: pickOptionalAuthHeader(override.authHeader, base.authHeader),
    authPrefix: pickOptionalString(override.authPrefix, base.authPrefix),
  };
}

function mergeSecondary(base: SecondaryModelConfig, override: unknown): SecondaryModelConfig {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  return mergeSecondaryFields(base, override as Partial<SecondaryModelConfig>) as SecondaryModelConfig;
}

export function resolveTaskModel(config: YoowaiConfig, action: WaiModelTask): SecondaryModelConfig {
  const override = config.taskModels?.[action];
  if (override) return mergeSecondary(config.secondary, override);
  return config.secondary;
}

export function loadYoowaiConfig(cwd: string): YoowaiConfig {
  const agentDir = getAgentDir();
  const globalPath = join(agentDir, "settings.json");
  const projectPath = getProjectConfigPath(cwd, "settings.json");

  let config: YoowaiConfig = {
    secondary: { provider: "", id: "", thinking: "xhigh" },
    autoJudge: false,
    preReviewCommands: [],
    reviewFullFileThresholdLines: 300,
    reviewMaxConventionsTokens: 1000,
    reviewMaxMemoryTokens: 800,
    reviewStrategy: "auto",
    verifyDoneClaims: true,
    reviewReminderEdits: 3,
    autoInjectContext: true,
    contextInjectMaxTokens: 800,
    entryRenderer: true,
    shortcuts: true,
    planWidget: true,
    registerProvider: false,
    docs: {
      sources: {},
      maxCharsPerSource: 8000,
      webSearch: {
        enabled: false,
        maxResults: 3,
        maxCharsPerResult: 3000,
        provider: undefined,
        apiKey: undefined,
      },
    },
  };

  if (existsSync(globalPath)) {
    try {
      const global = JSON.parse(readFileSync(globalPath, "utf-8"));
      if (global["pi-yoowai"]) {
        checkUnknownKeys(global["pi-yoowai"], "global", cwd);
        config = mergeConfig(config, global["pi-yoowai"]);
      }
      if (global["pi-heyyoo"]) {
        logEvent(cwd, "warn", "Deprecated config key pi-heyyoo detected in global settings; use pi-yoowai", {
          path: globalPath,
        });
        checkUnknownKeys(global["pi-heyyoo"], "global", cwd);
        config = mergeConfig(config, global["pi-heyyoo"]);
      }
    } catch (err) {
      logEvent(cwd, "warn", "Failed to parse global wai settings", {
        error: err instanceof Error ? err.message : String(err),
        path: globalPath,
      });
    }
  }

  if (existsSync(projectPath)) {
    try {
      const project = JSON.parse(readFileSync(projectPath, "utf-8"));
      if (project["pi-yoowai"]) {
        checkUnknownKeys(project["pi-yoowai"], "project", cwd);
        config = mergeConfig(config, project["pi-yoowai"]);
      }
      if (project["pi-heyyoo"]) {
        logEvent(cwd, "warn", "Deprecated config key pi-heyyoo detected in project settings; use pi-yoowai", {
          path: projectPath,
        });
        checkUnknownKeys(project["pi-heyyoo"], "project", cwd);
        config = mergeConfig(config, project["pi-heyyoo"]);
      }
    } catch (err) {
      logEvent(cwd, "warn", "Failed to parse project wai settings", {
        error: err instanceof Error ? err.message : String(err),
        path: projectPath,
      });
    }
  }

  return validateConfig(config, cwd);
}

/** Known top-level keys in pi-yoowai config. */
const KNOWN_CONFIG_KEYS = new Set([
  "secondary",
  "taskModels",
  "autoJudge",
  "preReviewCommands",
  "testCommand",
  "costBudgetUsd",
  "reviewMaxDiffChars",
  "reviewFullFileThresholdLines",
  "reviewMaxInputTokens",
  "reviewMaxConventionsTokens",
  "reviewMaxMemoryTokens",
  "reviewStrategy",
  "verifyByDefault",
  "selfVerify",
  "toolUseLoop",
  "parallelReview",
  "deepScan",
  "modelInfo",
  "processTimeoutMs",
  "testTimeoutMs",
  "verifyDoneClaims",
  "reviewReminderEdits",
  "autoInjectContext",
  "contextInjectMaxTokens",
  "maxContinuations",
  "entryRenderer",
  "shortcuts",
  "planWidget",
  "registerProvider",
  "docs",
]);

/** Warn about unknown config keys that might be typos. */
function checkUnknownKeys(raw: Record<string, unknown>, source: string, cwd: string): void {
  if (!raw || typeof raw !== "object") return;
  for (const key of Object.keys(raw)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      logEvent(cwd, "warn", `Config: unknown key "${key}" in ${source} settings — possible typo`, {});
    }
  }
}

/** Validate config and log warnings for common mistakes. */
function validateConfig(config: YoowaiConfig, cwd: string): YoowaiConfig {
  const warnings: string[] = [];

  if (!config.secondary.provider) {
    warnings.push("secondary.provider is not set — wai tool will not work");
  }
  if (!config.secondary.id) {
    warnings.push("secondary.id is not set — wai tool will not work");
  }
  if (config.processTimeoutMs !== undefined && config.processTimeoutMs <= 0) {
    warnings.push(`processTimeoutMs=${config.processTimeoutMs} is invalid, using default`);
  }
  if (config.costBudgetUsd !== undefined && config.costBudgetUsd < 0) {
    warnings.push(`costBudgetUsd=${config.costBudgetUsd} is negative, budget disabled`);
  }

  for (const w of warnings) {
    logEvent(cwd, "warn", `Config: ${w}`, {});
  }

  return config;
}

function normalizeCostBudgetUsd(value: unknown, fallback: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return undefined;
  return value;
}

function mergeModelInfo(base: YoowaiConfig["modelInfo"], override: unknown): YoowaiConfig["modelInfo"] {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  const result: NonNullable<YoowaiConfig["modelInfo"]> = base ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const normalizedKey = key.toLowerCase();
    const entry: { contextWindow?: number; maxOutputTokens?: number } = { ...result[normalizedKey] };
    if (typeof v.contextWindow === "number" && Number.isFinite(v.contextWindow) && v.contextWindow > 0) {
      entry.contextWindow = v.contextWindow;
    }
    if (typeof v.maxOutputTokens === "number" && Number.isFinite(v.maxOutputTokens) && v.maxOutputTokens > 0) {
      entry.maxOutputTokens = v.maxOutputTokens;
    }
    if (Object.keys(entry).length > 0) {
      result[normalizedKey] = entry;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mergePartialSecondary(
  base: Partial<SecondaryModelConfig>,
  override: Partial<SecondaryModelConfig>,
): Partial<SecondaryModelConfig> {
  return mergeSecondaryFields(base, override);
}

const VALID_WAI_MODEL_TASKS = new Set<string>([
  "plan",
  "review",
  "suggest",
  "recommend",
  "judge",
  "scan",
  "test",
  "security",
  "done",
  "explain",
]);

function mergeTaskModels(base: YoowaiConfig["taskModels"], override: unknown): YoowaiConfig["taskModels"] {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  const o = override as Partial<Record<WaiModelTask, Partial<SecondaryModelConfig>>>;
  const result: NonNullable<YoowaiConfig["taskModels"]> = base ? { ...base } : {};
  for (const [action, value] of Object.entries(o)) {
    if (!VALID_WAI_MODEL_TASKS.has(action)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    result[action as WaiModelTask] = mergePartialSecondary(result[action as WaiModelTask] ?? {}, value);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeFlag(base: boolean | number | undefined, override: unknown): boolean | number | undefined {
  if (typeof override === "boolean") return override;
  if (typeof override === "number" && Number.isFinite(override)) return override;
  return base;
}

function pickPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) return fallback;
  return value;
}

function mergeWebSearch(
  base: NonNullable<DocsConfig["webSearch"]>,
  override: unknown,
): NonNullable<DocsConfig["webSearch"]> {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  const o = override as Partial<DocsConfig["webSearch"]>;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
    maxResults: pickPositiveInteger(o.maxResults, base.maxResults),
    maxCharsPerResult: pickPositiveInteger(o.maxCharsPerResult, base.maxCharsPerResult),
    provider: pickOptionalEnum(o.provider, ["duckduckgo", "brave"], base.provider),
    apiKey: pickOptionalString(o.apiKey, base.apiKey),
  };
}

function mergeSources(base: DocsConfig["sources"], override: unknown): DocsConfig["sources"] {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  const o = override as Record<string, unknown>;
  const result: DocsConfig["sources"] = { ...base };
  for (const [key, value] of Object.entries(o)) {
    if (typeof value === "string" && value.length > 0) {
      result[key] = value;
    }
  }
  return result;
}

function mergeDocs(base: DocsConfig | undefined, override: unknown): DocsConfig | undefined {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  const b: DocsConfig = base ?? {
    sources: {},
    maxCharsPerSource: 8000,
    webSearch: { enabled: false, maxResults: 3, maxCharsPerResult: 3000 },
  };
  const o = override as Partial<DocsConfig>;
  return {
    sources: mergeSources(b.sources, o.sources),
    maxCharsPerSource: pickPositiveInteger(o.maxCharsPerSource, b.maxCharsPerSource),
    webSearch: mergeWebSearch(b.webSearch, o.webSearch),
  };
}

function mergeConfig(base: YoowaiConfig, override: unknown): YoowaiConfig {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  const o = override as Partial<YoowaiConfig>;
  return {
    secondary: mergeSecondary(base.secondary, o.secondary),
    taskModels: mergeTaskModels(base.taskModels, o.taskModels),
    autoJudge: typeof o.autoJudge === "boolean" ? o.autoJudge : base.autoJudge,
    preReviewCommands: Array.isArray(o.preReviewCommands)
      ? o.preReviewCommands.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      : base.preReviewCommands,
    testCommand:
      typeof o.testCommand === "string" && o.testCommand.trim().length > 0 ? o.testCommand.trim() : base.testCommand,
    costBudgetUsd: normalizeCostBudgetUsd(o.costBudgetUsd, base.costBudgetUsd),
    reviewMaxDiffChars: pickOptionalNumber(o.reviewMaxDiffChars, base.reviewMaxDiffChars),
    reviewFullFileThresholdLines: pickOptionalNumber(o.reviewFullFileThresholdLines, base.reviewFullFileThresholdLines),
    reviewMaxInputTokens: pickOptionalNumber(o.reviewMaxInputTokens, base.reviewMaxInputTokens),
    reviewMaxConventionsTokens: pickOptionalNumber(o.reviewMaxConventionsTokens, base.reviewMaxConventionsTokens),
    reviewMaxMemoryTokens: pickOptionalNumber(o.reviewMaxMemoryTokens, base.reviewMaxMemoryTokens),
    reviewStrategy: ["auto", "diff-only", "full-files"].includes(o.reviewStrategy ?? "")
      ? o.reviewStrategy
      : base.reviewStrategy,
    verifyByDefault: typeof o.verifyByDefault === "boolean" ? o.verifyByDefault : base.verifyByDefault,
    selfVerify: typeof o.selfVerify === "boolean" ? o.selfVerify : base.selfVerify,
    toolUseLoop: mergeFlag(base.toolUseLoop, o.toolUseLoop),
    parallelReview: mergeFlag(base.parallelReview, o.parallelReview),
    deepScan: mergeFlag(base.deepScan, o.deepScan),
    modelInfo: mergeModelInfo(base.modelInfo, o.modelInfo),
    processTimeoutMs: pickOptionalNumber(o.processTimeoutMs, base.processTimeoutMs),
    testTimeoutMs: pickOptionalNumber(o.testTimeoutMs, base.testTimeoutMs),
    maxContinuations:
      typeof o.maxContinuations === "number" && Number.isFinite(o.maxContinuations) && o.maxContinuations >= 0
        ? Math.floor(o.maxContinuations)
        : base.maxContinuations,
    verifyDoneClaims: typeof o.verifyDoneClaims === "boolean" ? o.verifyDoneClaims : base.verifyDoneClaims,
    reviewReminderEdits: pickPositiveInteger(o.reviewReminderEdits ?? NaN, base.reviewReminderEdits ?? 3),
    autoInjectContext: typeof o.autoInjectContext === "boolean" ? o.autoInjectContext : base.autoInjectContext,
    contextInjectMaxTokens: pickPositiveInteger(o.contextInjectMaxTokens ?? NaN, base.contextInjectMaxTokens ?? 800),
    entryRenderer: typeof o.entryRenderer === "boolean" ? o.entryRenderer : base.entryRenderer,
    shortcuts: typeof o.shortcuts === "boolean" ? o.shortcuts : base.shortcuts,
    planWidget: typeof o.planWidget === "boolean" ? o.planWidget : base.planWidget,
    registerProvider: typeof o.registerProvider === "boolean" ? o.registerProvider : base.registerProvider,
    docs: mergeDocs(base.docs, o.docs),
  };
}
