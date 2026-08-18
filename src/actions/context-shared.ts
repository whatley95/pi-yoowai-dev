import { detectAutoPreReviewCommands } from "../pre-review.js";
import { estimateTokens } from "../token-budget.js";
import type { ReviewLevel, YoowaiConfig } from "../types.js";

/** Resolve the effective toolUseLoop setting for a review: explicit config
 *  wins; unset falls back to the level default (min off — one cheap call —
 *  med 3 iterations, high 5). Shared by review, judge, security, and test. */
export function resolveEffectiveToolLoop(config: YoowaiConfig, level: ReviewLevel): boolean | number | undefined {
  if (config.toolUseLoop !== undefined) return config.toolUseLoop;
  return level === "high" ? 5 : level === "med" ? 3 : undefined;
}

/** Resolve the effective pre-review command list for a review: an explicit
 *  preReviewCommands config wins — INCLUDING an explicitly empty list, which
 *  never triggers auto mode (the config default is undefined, so a defined
 *  empty array is user intent). Otherwise auto-detect from the reviewed
 *  project's package.json when autoPreReviewCommands is enabled (min
 *  auto-detects nothing); else no commands. Shared by review and judge. */
export function resolveEffectivePreReviewCommands(cwd: string, config: YoowaiConfig, level: ReviewLevel): string[] {
  if (config.preReviewCommands !== undefined) return config.preReviewCommands;
  if (config.autoPreReviewCommands) return detectAutoPreReviewCommands(cwd, level);
  return [];
}

export interface ActionDiffInput {
  diff: string;
  availableInputTokens: number;
  fileTokens: number;
  /** System-prompt estimate deducted from the diff budget (default 1000). */
  systemPromptEstimate?: number;
  /** Deducted after files, yielding to them like review's runReviewBatch. */
  codemap?: string;
  designRefText?: string;
}

export type ActionDiffResult = { ok: true; diff: string } | { ok: false; error: string };

/** Prepare a diff for a judgment-style action (judge/security/test). These
 *  actions have no hunk/parallel splitting, so a diff that exceeds the
 *  context-derived budget FAILS CLOSED with guidance instead of being
 *  silently truncated ("... diff truncated" markers produced unreliable
 *  results — the footgun eliminated from review). The budget math mirrors
 *  runReviewBatch's remainingForDiff so a diff that fits never errors. */
export function prepareActionDiff(action: "judge" | "security" | "test", input: ActionDiffInput): ActionDiffResult {
  const remainingForDiff = Math.max(
    0,
    input.availableInputTokens -
      input.fileTokens -
      (input.systemPromptEstimate ?? 1000) -
      estimateTokens(input.codemap ?? "") -
      estimateTokens(input.designRefText ?? ""),
  );
  const diffTokens = estimateTokens(input.diff);
  if (diffTokens > remainingForDiff) {
    return {
      ok: false,
      error: `The change is too large for a ${action} review: the diff needs ~${diffTokens.toLocaleString()} tokens but the model's available context budget is ~${remainingForDiff.toLocaleString()} tokens. Scope the review with files:[...], or raise pi-yoowai.reviewMaxInputTokens.`,
    };
  }
  return { ok: true, diff: input.diff };
}
