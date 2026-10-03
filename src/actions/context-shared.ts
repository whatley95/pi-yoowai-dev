import { detectAutoPreReviewCommands } from "../pre-review.js";
import { estimateTokens, type ReviewBudget } from "../token-budget.js";
import { formatLanguageDirective } from "../config.js";
import { logEvent } from "../logger.js";
import type { FileContentEntry } from "../file-loader.js";
import type { CallSecondaryModelOptions, ReviewLevel, YoowaiConfig } from "../types.js";
import { resolveReviewToolContext } from "./review-tool-context.js";
import { toolLoopOptions } from "./shared.js";

type ContextAction = "judge" | "security" | "test";

/** Measure the complete prompt and bound larger read pages by its remaining
 * capacity. Existing off/true/numeric tool-loop settings remain authoritative. */
export function prepareActionContext(
  action: ContextAction,
  config: YoowaiConfig,
  input: {
    cwd: string;
    paths: string[];
    files: FileContentEntry[];
    budget: ReviewBudget;
    system: string;
    user: string;
  },
): { ok: true; options: CallSecondaryModelOptions } | { ok: false; error: string } {
  const loop = toolLoopOptions(config);
  const language = formatLanguageDirective(config.language);
  const system = language ? `${language}\n\n${input.system}` : input.system;
  const maxInputTokens = Math.max(
    0,
    Math.min(
      input.budget.hardInputCap ?? Infinity,
      input.budget.contextWindow - input.budget.reservedOutputTokens - input.budget.safetyMarginTokens,
    ),
  );
  const promptTokens = estimateTokens(system + input.user);
  const requiredTokens = promptTokens + (loop.enableToolLoop ? 1200 : 0);
  if (requiredTokens > maxInputTokens) {
    return {
      ok: false,
      error:
        `The complete prompt is too large for a ${action} review: needs ~${requiredTokens.toLocaleString()} input tokens, ` +
        `but the limit is ~${maxInputTokens.toLocaleString()}. ` +
        "Use a larger-context model or smaller coherent changes; for security/test, scope with files:[...]. " +
        "Raise pi-yoowai.reviewMaxInputTokens only if the model has enough remaining context.",
    };
  }
  const context = loop.enableToolLoop
    ? resolveReviewToolContext({
        ...input,
        system,
        // All fixed sections are already present in this measured prompt.
        budget: { ...input.budget, availableInputTokens: maxInputTokens },
        evidenceTokens: promptTokens,
        maxRequests: loop.maxToolIterations,
        adaptive: false,
      })
    : {};
  logEvent(input.cwd, "info", `${action} prompt prepared`, {
    files: input.paths,
    promptTokens,
    inputLimit: maxInputTokens,
    suppliedFileTokens: input.files.reduce((sum, file) => sum + file.tokenEstimate, 0),
    reservedOutputTokens: input.budget.reservedOutputTokens,
    ...loop,
    ...context,
  });
  return { ok: true, options: { ...loop, ...context, relevantPaths: input.paths } };
}

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
