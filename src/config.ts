import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getProjectConfigPath } from "./pi-paths.js";
import { logEvent } from "./logger.js";
import type { HeyyooConfig } from "./types.js";

export { getAgentDir, getProjectConfigPath } from "./pi-paths.js";

export function loadHeyyooConfig(cwd: string): HeyyooConfig {
  const agentDir = getAgentDir();
  const globalPath = join(agentDir, "settings.json");
  const projectPath = getProjectConfigPath(cwd, "settings.json");

  let config: HeyyooConfig = {
    secondary: { provider: "", id: "", thinking: "xhigh" },
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

function mergeConfig(base: HeyyooConfig, override: unknown): HeyyooConfig {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  const o = override as Partial<HeyyooConfig>;
  return {
    secondary: {
      provider: o.secondary?.provider || base.secondary.provider,
      id: o.secondary?.id || base.secondary.id,
      thinking: o.secondary?.thinking ?? base.secondary.thinking,
      contextWindow:
        typeof o.secondary?.contextWindow === "number" ? o.secondary.contextWindow : base.secondary.contextWindow,
      maxOutputTokens:
        typeof o.secondary?.maxOutputTokens === "number" ? o.secondary.maxOutputTokens : base.secondary.maxOutputTokens,
    },
    autoJudge: typeof o.autoJudge === "boolean" ? o.autoJudge : base.autoJudge,
    preReviewCommands: Array.isArray(o.preReviewCommands) ? o.preReviewCommands.map(String) : base.preReviewCommands,
    costBudgetUsd: typeof o.costBudgetUsd === "number" ? o.costBudgetUsd : base.costBudgetUsd,
    reviewMaxDiffChars: typeof o.reviewMaxDiffChars === "number" ? o.reviewMaxDiffChars : base.reviewMaxDiffChars,
    reviewFullFileThresholdLines:
      typeof o.reviewFullFileThresholdLines === "number"
        ? o.reviewFullFileThresholdLines
        : base.reviewFullFileThresholdLines,
    reviewMaxInputTokens:
      typeof o.reviewMaxInputTokens === "number" ? o.reviewMaxInputTokens : base.reviewMaxInputTokens,
    reviewStrategy: ["auto", "diff-only", "full-files"].includes(o.reviewStrategy ?? "")
      ? o.reviewStrategy
      : base.reviewStrategy,
  };
}
