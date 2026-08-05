import type { ReviewLevel, YoowaiConfig } from "./types.js";
import { getDefaultReviewLevel } from "./model-registry.js";
import { resolveTaskModel } from "./config.js";

/** Review-strategy choices controlled by review level. */
export type ReviewStrategy = "auto" | "diff-only" | "full-files";

/** Effective review settings after applying a review level.
 *  Explicit config values always override the level's defaults. */
export interface ReviewLevelSettings {
  level: ReviewLevel;
  reviewStrategy: ReviewStrategy;
  selfVerify: boolean;
  reviewMaxDiffChars: number | undefined;
  reviewMaxInputTokens: number | undefined;
  reviewMaxConventionsTokens: number | undefined;
  reviewMaxMemoryTokens: number | undefined;
  codemapMaxTokens: number | undefined;
  instructions: string;
}

const LEVEL_DEFAULTS: Record<
  ReviewLevel,
  {
    reviewStrategy: ReviewStrategy;
    selfVerify: boolean;
    reviewMaxDiffChars: number | undefined;
    reviewMaxInputTokens: number | undefined;
    reviewMaxConventionsTokens: number | undefined;
    reviewMaxMemoryTokens: number | undefined;
    codemapMaxTokens: number | undefined;
    instructions: string;
  }
> = {
  min: {
    reviewStrategy: "diff-only",
    selfVerify: false,
    reviewMaxDiffChars: 3000,
    reviewMaxInputTokens: 4000,
    reviewMaxConventionsTokens: 500,
    reviewMaxMemoryTokens: 400,
    codemapMaxTokens: 0,
    instructions:
      "Review level: MINIMAL. Do a quick, lightweight pass. Only flag obvious bugs, syntax errors, clear regressions, and surface-level style issues. Skip architectural concerns, speculative edge cases, and deep cross-file analysis.",
  },
  med: {
    reviewStrategy: "auto",
    selfVerify: false,
    reviewMaxDiffChars: undefined,
    reviewMaxInputTokens: undefined,
    reviewMaxConventionsTokens: undefined,
    reviewMaxMemoryTokens: undefined,
    codemapMaxTokens: undefined,
    instructions:
      "Review level: STANDARD. Perform a balanced code review. Check logic, correctness, tests, conventions, and cross-file impact. Flag real problems; avoid nit-picking or speculative issues without evidence.",
  },
  high: {
    reviewStrategy: "full-files",
    selfVerify: true,
    reviewMaxDiffChars: 12000,
    reviewMaxInputTokens: undefined,
    reviewMaxConventionsTokens: 1500,
    reviewMaxMemoryTokens: 1200,
    codemapMaxTokens: 2500,
    instructions:
      "Review level: DEEP. Perform a thorough, critical review. Examine architecture, security, edge cases, error handling, concurrency, API contracts, and cross-file implications. Be strict; only pass when the change is genuinely robust.",
  },
};

/** Pick a review level using, in order:
 *  1. explicit tool-call override
 *  2. config setting
 *  3. model-derived default from the effective review model
 */
export function resolveReviewLevel(config: YoowaiConfig, toolOverride?: ReviewLevel): ReviewLevel {
  if (toolOverride) return toolOverride;
  if (config.reviewLevel) return config.reviewLevel;
  const reviewModel = resolveTaskModel(config, "review");
  if (reviewModel.provider && reviewModel.id) {
    return getDefaultReviewLevel(reviewModel.provider, reviewModel.id);
  }
  return "med";
}

/** Build effective review settings by applying the level defaults and then
 *  letting explicit config values override them. */
export function getReviewLevelSettings(config: YoowaiConfig, level: ReviewLevel): ReviewLevelSettings {
  const defaults = LEVEL_DEFAULTS[level];
  const pick = <T>(explicit: T | undefined, preset: T | undefined): T | undefined =>
    explicit !== undefined ? explicit : preset;
  return {
    level,
    reviewStrategy: config.reviewStrategy ?? defaults.reviewStrategy,
    selfVerify: config.selfVerify ?? defaults.selfVerify,
    reviewMaxDiffChars: pick(config.reviewMaxDiffChars, defaults.reviewMaxDiffChars),
    reviewMaxInputTokens: pick(config.reviewMaxInputTokens, defaults.reviewMaxInputTokens),
    reviewMaxConventionsTokens: pick(config.reviewMaxConventionsTokens, defaults.reviewMaxConventionsTokens),
    reviewMaxMemoryTokens: pick(config.reviewMaxMemoryTokens, defaults.reviewMaxMemoryTokens),
    codemapMaxTokens: pick(config.codemapMaxTokens, defaults.codemapMaxTokens),
    instructions: defaults.instructions,
  };
}

/** Resolve the effective review settings for a call. */
export function resolveReviewSettings(config: YoowaiConfig, toolOverride?: ReviewLevel): ReviewLevelSettings {
  const level = resolveReviewLevel(config, toolOverride);
  return getReviewLevelSettings(config, level);
}
