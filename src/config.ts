import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getProjectConfigPath } from "./pi-paths.js";
import { logEvent } from "./logger.js";
import type {
  YoowaiConfig,
  YoowaiPreset,
  SecondaryModelConfig,
  WaiModelTask,
  DocsConfig,
  ReviewLevel,
} from "./types.js";

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

/** Map an explicit review level to its per-level task override key. */
export const REVIEW_LEVEL_TASKS: Record<ReviewLevel, WaiModelTask> = {
  min: "reviewMin",
  med: "reviewMed",
  high: "reviewHigh",
};

/** Resolve the model for a review call: when an explicit level is given (the
 *  wai_review_min/med/high tools), its per-level task override wins, then the
 *  generic review task override, then the base secondary model. */
export function resolveReviewTaskModel(config: YoowaiConfig, level?: ReviewLevel): SecondaryModelConfig {
  if (level) {
    const task = REVIEW_LEVEL_TASKS[level];
    const override = config.taskModels?.[task];
    if (override && (override.provider || override.id)) {
      return mergeSecondary(config.secondary, override);
    }
  }
  return resolveTaskModel(config, "review");
}

/** Resolve judge council entries to full secondary configs the same way taskModels
 *  overrides resolve: each entry merges over `secondary`. Members that end up
 *  without a provider or id are dropped. */
export function resolveJudgeCouncilMembers(config: YoowaiConfig): SecondaryModelConfig[] {
  const members: SecondaryModelConfig[] = [];
  for (const entry of config.judgeCouncil ?? []) {
    const merged = mergeSecondary(config.secondary, entry);
    if (merged.provider && merged.id) {
      members.push(merged);
    }
  }
  return members;
}

export function loadYoowaiConfig(cwd: string): YoowaiConfig {
  const agentDir = getAgentDir();
  const globalPath = join(agentDir, "settings.json");
  const projectPath = getProjectConfigPath(cwd, "settings.json");

  let config: YoowaiConfig = {
    secondary: { provider: "", id: "", thinking: "xhigh" },
    autoJudge: false,
    preReviewCommands: undefined,
    reviewFullFileThresholdLines: 300,
    reviewMaxConventionsTokens: 1000,
    reviewMaxMemoryTokens: 800,
    reviewStrategy: undefined,
    reviewLevel: undefined,
    verifyDoneClaims: true,
    reviewReminderEdits: 3,
    autoInjectContext: true,
    contextInjectMaxTokens: 800,
    codemapMaxTokens: undefined,
    autoPreReviewCommands: false,
    designRefMaxTokens: 800,
    entryRenderer: true,
    shortcuts: true,
    planWidget: true,
    registerProvider: false,
    steerEscalationThreshold: 3,
    noPlanSteerEscalationThreshold: 3,
    requireReviewBeforeDone: true,
    autoReviewOnSettle: true,
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
  "judgeCouncil",
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
  "reviewLevel",
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
  "codemapMaxTokens",
  "relatedContextMaxTokens",
  "autoPreReviewCommands",
  "designRefMaxTokens",
  "maxContinuations",
  "entryRenderer",
  "shortcuts",
  "planWidget",
  "registerProvider",
  "steerEscalationThreshold",
  "noPlanSteerEscalationThreshold",
  "requireReviewBeforeDone",
  "autoReviewOnSettle",
  "presets",
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
  "reviewMin",
  "reviewMed",
  "reviewHigh",
  "suggest",
  "recommend",
  "judge",
  "scan",
  "test",
  "security",
  "done",
  "explain",
  "vision",
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

function mergeJudgeCouncil(base: YoowaiConfig["judgeCouncil"], override: unknown): YoowaiConfig["judgeCouncil"] {
  if (!Array.isArray(override)) {
    return base;
  }
  const result: NonNullable<YoowaiConfig["judgeCouncil"]> = [];
  for (const entry of override) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      // "provider/model-id" splits on the first "/"; a bare string is treated
      // as a model id whose provider is inherited from `secondary`.
      const slash = trimmed.indexOf("/");
      if (slash === -1) {
        result.push({ id: trimmed });
      } else if (slash > 0 && slash < trimmed.length - 1) {
        result.push({ provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) });
      }
      continue;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const merged = mergeSecondaryFields({}, entry as Partial<SecondaryModelConfig>);
      if (merged.provider || merged.id) {
        result.push(merged);
      }
    }
  }
  return result.length > 0 ? result : undefined;
}

function mergePresets(base: YoowaiConfig["presets"], override: unknown): YoowaiConfig["presets"] {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  const result: NonNullable<YoowaiConfig["presets"]> = base ? { ...base } : {};
  for (const [name, value] of Object.entries(override)) {
    if (!name.trim() || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Partial<YoowaiPreset>;
    const preset: YoowaiPreset = {};
    if (v.secondary && typeof v.secondary === "object" && !Array.isArray(v.secondary)) {
      preset.secondary = mergeSecondaryFields({}, v.secondary as Partial<SecondaryModelConfig>);
    }
    const taskModels = mergeTaskModels(undefined, v.taskModels);
    if (taskModels) preset.taskModels = taskModels;
    if (preset.secondary || preset.taskModels) {
      result[name] = preset;
    }
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
    judgeCouncil: mergeJudgeCouncil(base.judgeCouncil, o.judgeCouncil),
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
    reviewLevel: ["min", "med", "high"].includes(o.reviewLevel ?? "")
      ? (o.reviewLevel as "min" | "med" | "high")
      : base.reviewLevel,
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
    codemapMaxTokens:
      typeof o.codemapMaxTokens === "number" &&
      Number.isInteger(o.codemapMaxTokens) &&
      Number.isFinite(o.codemapMaxTokens) &&
      o.codemapMaxTokens >= 0
        ? o.codemapMaxTokens
        : base.codemapMaxTokens,
    relatedContextMaxTokens:
      typeof o.relatedContextMaxTokens === "number" &&
      Number.isInteger(o.relatedContextMaxTokens) &&
      Number.isFinite(o.relatedContextMaxTokens) &&
      o.relatedContextMaxTokens >= 0
        ? o.relatedContextMaxTokens
        : (base.relatedContextMaxTokens ?? undefined),
    autoPreReviewCommands:
      typeof o.autoPreReviewCommands === "boolean" ? o.autoPreReviewCommands : (base.autoPreReviewCommands ?? false),
    designRefMaxTokens:
      typeof o.designRefMaxTokens === "number" &&
      Number.isInteger(o.designRefMaxTokens) &&
      Number.isFinite(o.designRefMaxTokens) &&
      o.designRefMaxTokens >= 0
        ? o.designRefMaxTokens
        : (base.designRefMaxTokens ?? 800),
    entryRenderer: typeof o.entryRenderer === "boolean" ? o.entryRenderer : base.entryRenderer,
    shortcuts: typeof o.shortcuts === "boolean" ? o.shortcuts : base.shortcuts,
    planWidget: typeof o.planWidget === "boolean" ? o.planWidget : base.planWidget,
    registerProvider: typeof o.registerProvider === "boolean" ? o.registerProvider : base.registerProvider,
    steerEscalationThreshold: pickPositiveInteger(
      o.steerEscalationThreshold ?? NaN,
      base.steerEscalationThreshold ?? 3,
    ),
    noPlanSteerEscalationThreshold: pickPositiveInteger(
      o.noPlanSteerEscalationThreshold ?? NaN,
      base.noPlanSteerEscalationThreshold ?? 3,
    ),
    requireReviewBeforeDone:
      typeof o.requireReviewBeforeDone === "boolean" ? o.requireReviewBeforeDone : base.requireReviewBeforeDone,
    autoReviewOnSettle: typeof o.autoReviewOnSettle === "boolean" ? o.autoReviewOnSettle : base.autoReviewOnSettle,
    presets: mergePresets(base.presets, o.presets),
    docs: mergeDocs(base.docs, o.docs),
  };
}
