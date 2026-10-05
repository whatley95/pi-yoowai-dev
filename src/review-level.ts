import type { ReviewLevel, YoowaiConfig } from "./types.js";

/** Balanced review is the fallback regardless of model family or thinking level. */
export const DEFAULT_REVIEW_LEVEL: ReviewLevel = "med";

/** Review-strategy choices controlled by review level. */
export type ReviewStrategy = "auto" | "diff-only" | "full-files";

/** Effective review settings after applying a review level.
 *  Explicit config values always override the level's defaults.
 *
 *  Levels are STRATEGY-ONLY: they no longer cap the diff or input tokens.
 *  The single ceiling for every level is the context-derived budget from
 *  calculateReviewBudget (model context window minus output reservation and
 *  safety margin). Only explicit user config (reviewMaxDiffChars /
 *  reviewMaxInputTokens) imposes fixed caps. */
export interface ReviewLevelSettings {
  level: ReviewLevel;
  reviewStrategy: ReviewStrategy;
  selfVerify: boolean;
  reviewMaxDiffChars: number | undefined;
  reviewMaxInputTokens: number | undefined;
  reviewMaxConventionsTokens: number | undefined;
  reviewMaxMemoryTokens: number | undefined;
  codemapMaxTokens: number | undefined;
  relatedContextMaxTokens: number | undefined;
  instructions: string;
}

export const LEVEL_DEFAULTS: Record<
  ReviewLevel,
  {
    reviewStrategy: ReviewStrategy;
    selfVerify: boolean;
    reviewMaxDiffChars: number | undefined;
    reviewMaxInputTokens: number | undefined;
    reviewMaxConventionsTokens: number | undefined;
    reviewMaxMemoryTokens: number | undefined;
    codemapMaxTokens: number | undefined;
    relatedContextMaxTokens: number | undefined;
    instructions: string;
  }
> = {
  min: {
    reviewStrategy: "diff-only",
    selfVerify: false,
    reviewMaxDiffChars: undefined,
    reviewMaxInputTokens: undefined,
    reviewMaxConventionsTokens: 500,
    reviewMaxMemoryTokens: 400,
    // Compact symbol map for changed files + import neighbors. The diff budget
    // deducts the ACTUAL rendered map length, not this cap, so a high cap costs
    // nothing on typical projects (1-10k token maps) and only binds on huge
    // ones. 20k keeps ~34k tokens for the diff on the smallest 64k-context
    // min-default model; beyond ~30k the map can crowd out the diff (fail-closed
    // at min, not truncation).
    codemapMaxTokens: 20000,
    // Diff-only sends no file contents, so related/AST context is the main
    // cross-file evidence at min — compact budget.
    relatedContextMaxTokens: 1000,
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
    codemapMaxTokens: 8000,
    relatedContextMaxTokens: 2500,
    instructions:
      "Review level: STANDARD. Perform a balanced code review. Check logic, correctness, tests, conventions, and cross-file impact. Flag real problems; avoid nit-picking or speculative issues without evidence.",
  },
  high: {
    reviewStrategy: "full-files",
    selfVerify: true,
    reviewMaxDiffChars: undefined,
    reviewMaxInputTokens: undefined,
    reviewMaxConventionsTokens: 1500,
    reviewMaxMemoryTokens: 1200,
    codemapMaxTokens: 8000,
    relatedContextMaxTokens: 4000,
    instructions:
      "Review level: DEEP. Perform a thorough, critical review. Examine architecture, security, edge cases, error handling, concurrency, API contracts, and cross-file implications. Be strict; only pass when the change is genuinely robust.",
  },
};

/** Pick a review level using, in order:
 *  1. explicit tool-call override
 *  2. config setting
 *  3. balanced default, independent of the review model
 */
export function resolveReviewLevel(config: YoowaiConfig, toolOverride?: ReviewLevel): ReviewLevel {
  if (toolOverride) return toolOverride;
  if (config.reviewLevel) return config.reviewLevel;
  return DEFAULT_REVIEW_LEVEL;
}

/** Conservative, opt-in routing: deepen security/data changes, and spend less
 * on documentation-only changes. Explicit review choices remain authoritative. */
export function resolveRiskReviewLevel(
  config: YoowaiConfig,
  toolOverride: ReviewLevel | undefined,
  changedFiles: string[],
  diff: string,
  truncated = false,
): ReviewLevel {
  const base = resolveReviewLevel(config, toolOverride);
  if (!config.riskBasedReview || toolOverride || config.reviewLevel || changedFiles.length === 0) return base;
  return classifyRiskReviewLevel(base, changedFiles, diff, truncated);
}

export function classifyRiskReviewLevel(
  base: ReviewLevel,
  changedFiles: string[],
  diff: string,
  truncated = false,
): ReviewLevel {
  if (changedFiles.length === 0) return base;
  const sensitivePath =
    /(?:^|[\x2f._-])(auth|security|permission|crypto|payment|billing|migration|schema|database|session|token|credential)(?:[\x2f._-]|$)/i;
  const sensitiveAddition =
    /^\+(?!\+).*(?:innerHTML|\beval\s*\(|\bexec\s*\(|\bspawn\s*\(|child_process|password|secret|api[_-]?key|DELETE\s+FROM)/im;
  if (
    truncated ||
    changedFiles.some((file) => sensitivePath.test(file.replace(/\\/g, "/"))) ||
    sensitiveAddition.test(diff)
  )
    return "high";
  const docsOnly = changedFiles.every((file) => /\.(?:md|mdx|txt|rst)$/i.test(file));
  return docsOnly && base !== "high" ? "min" : base;
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
    relatedContextMaxTokens: pick(config.relatedContextMaxTokens, defaults.relatedContextMaxTokens),
    instructions: defaults.instructions,
  };
}

/** Resolve the effective review settings for a call. */
export function resolveReviewSettings(config: YoowaiConfig, toolOverride?: ReviewLevel): ReviewLevelSettings {
  const level = resolveReviewLevel(config, toolOverride);
  return getReviewLevelSettings(config, level);
}
