import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getProjectConfigPath } from "./pi-paths.js";
import { logEvent } from "./logger.js";
import type { HeyyooConfig, SecondaryModelConfig, YooAction } from "./types.js";

export { getAgentDir, getProjectConfigPath } from "./pi-paths.js";

function isValidBackend(value: unknown): value is "pi" | "http" {
  return value === "pi" || value === "http";
}

function pickOptionalString(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : fallback;
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
    style: pickOptionalStyle(override.style, base.style),
    authHeader: pickOptionalString(override.authHeader, base.authHeader),
    authPrefix: pickOptionalString(override.authPrefix, base.authPrefix),
  };
}

function mergeSecondary(base: SecondaryModelConfig, override: unknown): SecondaryModelConfig {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  return mergeSecondaryFields(base, override as Partial<SecondaryModelConfig>) as SecondaryModelConfig;
}

export function resolveTaskModel(config: HeyyooConfig, action: YooAction): SecondaryModelConfig {
  const override = config.taskModels?.[action];
  if (!override) return config.secondary;
  return mergeSecondary(config.secondary, override);
}

export function loadHeyyooConfig(cwd: string): HeyyooConfig {
  const agentDir = getAgentDir();
  const globalPath = join(agentDir, "settings.json");
  const projectPath = getProjectConfigPath(cwd, "settings.json");

  let config: HeyyooConfig = {
    secondary: { provider: "", id: "", thinking: "xhigh", backend: "pi" },
    autoJudge: false,
    preReviewCommands: [],
    reviewFullFileThresholdLines: 300,
    reviewStrategy: "auto",
  };

  if (existsSync(globalPath)) {
    try {
      const global = JSON.parse(readFileSync(globalPath, "utf-8"));
      if (global["pi-heyyoo"]) {
        config = mergeConfig(config, global["pi-heyyoo"]);
      }
    } catch (err) {
      logEvent(cwd, "warn", "Failed to parse global yoo settings", {
        error: err instanceof Error ? err.message : String(err),
        path: globalPath,
      });
    }
  }

  if (existsSync(projectPath)) {
    try {
      const project = JSON.parse(readFileSync(projectPath, "utf-8"));
      if (project["pi-heyyoo"]) {
        config = mergeConfig(config, project["pi-heyyoo"]);
      }
    } catch (err) {
      logEvent(cwd, "warn", "Failed to parse project yoo settings", {
        error: err instanceof Error ? err.message : String(err),
        path: projectPath,
      });
    }
  }

  return config;
}

function normalizeCostBudgetUsd(value: unknown, fallback: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return undefined;
  return value;
}

function mergeModelInfo(base: HeyyooConfig["modelInfo"], override: unknown): HeyyooConfig["modelInfo"] {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  const result: NonNullable<HeyyooConfig["modelInfo"]> = base ? { ...base } : {};
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

const VALID_YOO_ACTIONS = new Set<string>(["plan", "review", "suggest", "recommend", "judge", "scan"]);

function mergeTaskModels(base: HeyyooConfig["taskModels"], override: unknown): HeyyooConfig["taskModels"] {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  const o = override as Partial<Record<YooAction, Partial<SecondaryModelConfig>>>;
  const result: NonNullable<HeyyooConfig["taskModels"]> = base ? { ...base } : {};
  for (const [action, value] of Object.entries(o)) {
    if (!VALID_YOO_ACTIONS.has(action)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    result[action as YooAction] = mergePartialSecondary(result[action as YooAction] ?? {}, value);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeFlag(base: boolean | number | undefined, override: unknown): boolean | number | undefined {
  if (typeof override === "boolean") return override;
  if (typeof override === "number" && Number.isFinite(override)) return override;
  return base;
}

function mergeConfig(base: HeyyooConfig, override: unknown): HeyyooConfig {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  const o = override as Partial<HeyyooConfig>;
  return {
    secondary: mergeSecondary(base.secondary, o.secondary),
    taskModels: mergeTaskModels(base.taskModels, o.taskModels),
    autoJudge: typeof o.autoJudge === "boolean" ? o.autoJudge : base.autoJudge,
    preReviewCommands: Array.isArray(o.preReviewCommands)
      ? o.preReviewCommands.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      : base.preReviewCommands,
    costBudgetUsd: normalizeCostBudgetUsd(o.costBudgetUsd, base.costBudgetUsd),
    reviewMaxDiffChars: pickOptionalNumber(o.reviewMaxDiffChars, base.reviewMaxDiffChars),
    reviewFullFileThresholdLines: pickOptionalNumber(o.reviewFullFileThresholdLines, base.reviewFullFileThresholdLines),
    reviewMaxInputTokens: pickOptionalNumber(o.reviewMaxInputTokens, base.reviewMaxInputTokens),
    reviewStrategy: ["auto", "diff-only", "full-files"].includes(o.reviewStrategy ?? "")
      ? o.reviewStrategy
      : base.reviewStrategy,
    verifyByDefault: typeof o.verifyByDefault === "boolean" ? o.verifyByDefault : base.verifyByDefault,
    parallelReview: mergeFlag(base.parallelReview, o.parallelReview),
    deepScan: mergeFlag(base.deepScan, o.deepScan),
    modelInfo: mergeModelInfo(base.modelInfo, o.modelInfo),
  };
}
