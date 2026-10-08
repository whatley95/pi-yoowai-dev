import type { ReviewLevel, ReviewLevelSelection, YoowaiConfig } from "./types.js";
import { splitDiffByFile } from "./diff-grabber.js";
import { normalizeReviewPath } from "./path-security.js";

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
  if (hasFixedReviewLevel(config)) return config.reviewLevel as ReviewLevel;
  return DEFAULT_REVIEW_LEVEL;
}

export function hasFixedReviewLevel(config: YoowaiConfig): boolean {
  return config.reviewLevel !== undefined && config.reviewLevel !== "auto";
}

export function describeReviewLevelMode(config: YoowaiConfig): string {
  if (hasFixedReviewLevel(config))
    return `${config.reviewLevel} (configured${config.riskBasedReview ? "; risk routing bypassed" : ""})`;
  return `automatic (med default; risk routing ${config.riskBasedReview ? "enabled" : "disabled"})`;
}

export function resolveReviewLevelSelection(
  config: YoowaiConfig,
  toolOverride: ReviewLevel | undefined,
  changedFiles: string[],
  diff: string,
  truncated = false,
): ReviewLevelSelection {
  if (toolOverride) return { level: toolOverride, source: "explicit", reason: "Explicit review level requested." };
  if (hasFixedReviewLevel(config))
    return {
      level: resolveReviewLevel(config),
      source: "config",
      reason: `Configured fixed review level.${config.riskBasedReview ? " Risk routing is bypassed." : ""}`,
    };
  if (config.riskBasedReview && changedFiles.length > 0)
    return classifyRiskReviewSelection(DEFAULT_REVIEW_LEVEL, changedFiles, diff, truncated);
  return {
    level: DEFAULT_REVIEW_LEVEL,
    source: "default",
    reason: config.riskBasedReview
      ? "No changed paths available; balanced default."
      : "Balanced default; risk routing is disabled.",
  };
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
  return resolveReviewLevelSelection(config, toolOverride, changedFiles, diff, truncated).level;
}

export function classifyRiskReviewLevel(
  base: ReviewLevel,
  changedFiles: string[],
  diff: string,
  truncated = false,
): ReviewLevel {
  return classifyRiskReviewSelection(base, changedFiles, diff, truncated).level;
}

function classifyRiskReviewSelection(
  base: ReviewLevel,
  changedFiles: string[],
  diff: string,
  truncated: boolean,
): ReviewLevelSelection {
  const selected = (level: ReviewLevel, reason: string): ReviewLevelSelection => ({ level, source: "risk", reason });
  if (changedFiles.length === 0) return selected(base, "No changed paths available for risk routing.");
  if (truncated) return selected("high", "Captured diff is truncated; complete evidence is still required.");
  const isDocumentation = (path: string): boolean => {
    const normalized = path.replace(/\\/g, "/");
    if (/\.(?:md|mdx|rst)$/i.test(normalized)) return true;
    // Plain-text configuration or credential data is not necessarily docs.
    return (
      /\.txt$/i.test(normalized) &&
      (/(?:^|\/)docs?\//i.test(normalized) ||
        /(?:^|\/)(?:readme|changelog|license|notice|contributing)\.txt$/i.test(normalized))
    );
  };
  const sourceFiles = changedFiles.filter((file) => !isDocumentation(file));
  if (sourceFiles.length === 0) return selected(base === "high" ? base : "min", "Documentation-only change.");
  const sensitivePath =
    /(?:^|[\x2f._-])(auth|oauth|jwt|authentication|authorization|security|permissions?|crypto|payments?|billing|migrations?|schema|database|session|credentials?)(?:[\x2f._-]|$)/i;
  const credentialTokenPath = /(?:^|[\x2f._-])(?:access|refresh|auth|bearer)[._-]?tokens?(?:[\x2f._-]|$)/i;
  const sensitiveFile = sourceFiles.find((file) => {
    const path = file.replace(/\\/g, "/");
    return sensitivePath.test(path) || credentialTokenPath.test(path);
  });
  if (sensitiveFile) return selected("high", `Sensitive source path: ${sensitiveFile}`);

  // Associate hunks with their files so a documentation snippet does not deepen
  // an unrelated code change. Both Git and SVN captures carry file headers.
  const blocks = splitDiffByFile(diff, /^Index: /m.test(diff) ? "svn" : "git");
  // If any source path has no parsed block, retain the original patch rather
  // than hiding an unrecognized source hunk while filtering documentation.
  const sourceDiff = sourceFiles.every((file) => Object.hasOwn(blocks, normalizeReviewPath(file)))
    ? Object.entries(blocks)
        .filter(([file]) => !isDocumentation(file))
        .map(([, patch]) => patch)
        .join("\n")
    : diff;
  const sensitiveCode =
    /innerHTML|\b(?:eval|exec|spawn)\s*\(|child_process|\b(?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer)\b|\b(?:DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)\b/i;
  const accessControl =
    /\b(?:is_?(?:admin|authenticated|authorized)|has_?permission|check_?permissions?|require_?auth|verify_?token|validate_?token|authorize|authenticate)\b/i;
  let securityContext = false;
  let changedInHunk = false;
  const hunkHasSecurityChange = (): boolean => securityContext && changedInHunk;
  for (const line of sourceDiff.split(/\r?\n/)) {
    if (/^(?:diff --git |Index: |@@)/.test(line)) {
      if (hunkHasSecurityChange())
        return selected("high", "Changed hunk includes access-control or credential handling.");
      changedInHunk = false;
      securityContext = /^@@/.test(line) && accessControl.test(line);
      continue;
    }
    if (/^(?:\+\+\+|---)/.test(line) || !/^[ +-]/.test(line)) continue;
    const code = line.slice(1);
    if (/^\s*(?:\/\/|#|\*|\/\*)/.test(code)) continue;
    if (/^[+-]/.test(line)) {
      changedInHunk = true;
      if (sensitiveCode.test(code) || accessControl.test(code))
        return selected("high", "Security, data, or execution-sensitive code added or removed.");
    } else if (accessControl.test(code) || sensitiveCode.test(code)) {
      securityContext = true;
    }
  }
  if (hunkHasSecurityChange()) return selected("high", "Changed hunk includes access-control or credential handling.");
  return selected(base, `No risk-routing signal detected; keeping ${base} review.`);
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
