import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadYoowaiConfig, resolveReviewTaskModel } from "../config.js";
import { getDiff, splitDiffByFile, splitDiffByHunk, getVcsInfo } from "../diff-grabber.js";
import { loadConventions, formatConventions } from "../conventions.js";
import { providerSupportsJsonObject, estimateCost } from "../secondary-model.js";
import { loadFileContentsForReview, isReviewableFile, type FileContentEntry } from "../file-loader.js";
import { buildRelatedContext } from "../context-retrieval.js";
import { buildCodemap } from "../codemap.js";
import { formatDesignRulesForPrompt, isUiFile } from "../design-ref.js";
import { buildAstContext } from "../ast-context.js";
import { getPastIssuesForFiles, recordIssues } from "../review-memory.js";
import { runPreReviewCommands, formatPreReviewOutput } from "../pre-review.js";
import { calculateReviewBudget, estimateTokens, truncateToTokenBudget, type ReviewBudget } from "../token-budget.js";
import { getSessionCost, formatCost, reserveCost, releaseCost } from "../cost-tracker.js";
import { logEvent } from "../logger.js";
import {
  getState,
  markStepsComplete,
  incrementReviewRounds,
  getProgress,
  markJudgeCompleted,
  getLastReviewedCommit,
  setLastReviewedCommit,
  planStaleSuggestionDue,
} from "../session-state.js";
import { planStepDescription } from "../types.js";
import { auditStepDone } from "../integration/audit.js";
import {
  STAGES,
  secondaryModelLabel,
  recordCostWithBudget,
  mergeUsageCost,
  toolLoopOptions,
  continuationMeta,
} from "./shared.js";
import {
  getSessionContext,
  runWithConcurrencyLimit,
  mergeReviewResults,
  runReviewBatch,
  type ConcurrencyOutcome,
} from "./review-helpers.js";
import { executeWaiJudge } from "./judge.js";
import { resolveBackendType } from "../backends/backend-resolver.js";
import { validateReviewResult, getReviewValidationErrors, salvageReviewFromMarkdown } from "../prompts.js";
import { verifyResult, mergeVerifiedCost } from "./verify.js";
import { buildCacheKey, getCachedReview, setCachedResult } from "../review-cache.js";
import { resolveReviewSettings } from "../review-level.js";
import type { ProgressReporter } from "../progress.js";
import type { WaiToolResult, ReviewResult, UsageCost, ReviewLevel } from "../types.js";

/** Error returned when no review model can be resolved — the effective level
 *  drives the per-level task lookup (reviewMin/reviewMed/reviewHigh) with the
 *  `review` task and finally `secondary` as fallbacks. Exported so callers and
 *  tests can reference the exact message. */
export const REVIEW_NO_MODEL_ERROR =
  "No secondary model configured. Set pi-yoowai.secondary, taskModels.review, or taskModels.reviewMin/reviewMed/reviewHigh in settings.json.";

/** Decide whether a passing review advances the plan tracker, and by how
 *  many steps. Guards the guarded auto-completion contract:
 *  - consensus (verdict "pass" with zero issues) advances by the model's
 *    relative "completedSteps" count (default 1), as before;
 *  - an explicit stepComplete: true signal advances exactly one step (the
 *    current one) even when minor issues remain, because the model
 *    explicitly confirmed the step's work is finished and covered;
 *  - anything else (needs-work/blocked, or a bare pass without stepComplete
 *    and without consensus) does not advance.
 *  Returns null when no plan is active; when the plan is already complete the
 *  returned count is 0 (bookkeeping may still run, auto-advance must not). */
export function planAdvanceFromReview(
  review: Pick<ReviewResult, "verdict" | "consensus" | "stepComplete" | "completedSteps">,
  planActive: boolean,
  planComplete: boolean,
): { count: number } | null {
  if (!planActive) return null;
  if (review.consensus) {
    const count = typeof review.completedSteps === "number" && review.completedSteps > 1 ? review.completedSteps : 1;
    return { count: planComplete ? 0 : count };
  }
  if (review.verdict === "pass" && review.stepComplete === true) {
    return { count: planComplete ? 0 : 1 };
  }
  return null;
}

export async function executeWaiReview(
  cwd: string,
  description: string,
  ctx: ExtensionContext,
  options: {
    files?: string[];
    exclude?: string[];
    revision?: string;
    since?: string;
    vcs?: "git" | "svn";
    untracked?: boolean;
    level?: ReviewLevel;
  } = {},
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
): Promise<WaiToolResult> {
  const config = loadYoowaiConfig(cwd);
  const reviewSettings = resolveReviewSettings(config, options.level);
  const level = reviewSettings.level;
  const effectiveConfig = { ...config, ...reviewSettings };
  // Resolve the model from the EFFECTIVE level, not the tool override: the
  // generic `wai review` (and auto-review, /wai review) runs at the resolved
  // level (config.reviewLevel ?? model-derived default), so it must honor the
  // per-level reviewMin/reviewMed/reviewHigh task models the same way the
  // explicit tools do. Configs without per-level entries fall back to the
  // `review` task, so existing setups are unchanged.
  const modelConfig = resolveReviewTaskModel(config, level);
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "review", error: REVIEW_NO_MODEL_ERROR };
  }
  const modelProfile = {
    provider: modelConfig.provider,
    id: modelConfig.id,
    thinking: modelConfig.thinking,
    backend: resolveBackendType(modelConfig.provider, modelConfig),
  };
  const nativeJson = providerSupportsJsonObject(modelConfig.provider, modelConfig.id, modelConfig);

  const state = getState(cwd);
  const currentStep =
    state.plan && state.completedSteps < state.plan.todo.length
      ? planStepDescription(state.plan.todo[state.completedSteps])
      : undefined;
  // Files edited since the current step started (the list resets when a step
  // completes): a focus hint for the reviewer, never a diff filter.
  const stepFocusFiles =
    state.plan && state.editedFiles && state.editedFiles.length > 0 ? state.editedFiles : undefined;

  progress(1, STAGES.review, "Collecting diff…");
  const diffOptions = {
    ...options,
    maxDiffChars: effectiveConfig.reviewMaxDiffChars,
    untracked: options.untracked ?? true,
  };
  const vcsInfo = getVcsInfo(cwd);
  const lastReviewed = getLastReviewedCommit(cwd);
  const canUseIncremental =
    vcsInfo.type === "git" &&
    !vcsInfo.dirty &&
    lastReviewed &&
    !diffOptions.revision &&
    !diffOptions.since &&
    !diffOptions.files?.length &&
    !diffOptions.exclude?.length;
  if (canUseIncremental) {
    diffOptions.since = lastReviewed;
  } else if (!diffOptions.revision && !diffOptions.since) {
    // Default to reviewing everything pending (staged + unstaged + untracked)
    // instead of bare `git diff`, which hides staged changes and new files
    // (e.g. after `git add` before review, or a "create file X" step).
    diffOptions.revision = "HEAD";
  }
  const { diff, truncated, changedFiles, vcs } = getDiff(cwd, diffOptions);
  const relatedContext =
    buildAstContext(cwd, changedFiles, { maxTokens: 1000 }) || buildRelatedContext(cwd, changedFiles).context;
  const codemap = buildCodemap(cwd, changedFiles, effectiveConfig.codemapMaxTokens ?? 1500);
  const designRefText = changedFiles.some(isUiFile)
    ? formatDesignRulesForPrompt(cwd, effectiveConfig.designRefMaxTokens ?? 800)
    : "";
  const sessionContext = getSessionContext(ctx);

  progress(2, STAGES.review, "Loading project conventions…");
  let conventionsText = "";
  const conventions = loadConventions(cwd);
  if (conventions) {
    conventionsText = truncateToTokenBudget(
      formatConventions(conventions),
      effectiveConfig.reviewMaxConventionsTokens ?? 1000,
    );
  }

  const memoryContext = truncateToTokenBudget(
    getPastIssuesForFiles(cwd, changedFiles, description),
    effectiveConfig.reviewMaxMemoryTokens ?? 800,
  );

  const cacheable = !config.preReviewCommands || config.preReviewCommands.length === 0;
  const cacheKey = cacheable
    ? buildCacheKey("review", {
        diff,
        description,
        modelProfile,
        currentStep,
        // Plan progress is part of the key: without it, a cached review with
        // stepComplete/consensus auto-advance could replay after a tracker
        // regression (identical step description + identical diff within the
        // TTL) and advance the plan without a fresh model call.
        planProgress: state.plan ? `${state.completedSteps}/${state.totalSteps}` : "none",
        options,
        reviewMaxDiffChars: effectiveConfig.reviewMaxDiffChars,
        reviewStrategy: effectiveConfig.reviewStrategy,
        reviewFullFileThresholdLines: config.reviewFullFileThresholdLines,
        parallelReview: config.parallelReview,
        selfVerify: config.selfVerify,
        conventionsText,
        memoryContext,
      })
    : undefined;

  if (cacheable && cacheKey) {
    const cached = getCachedReview(cwd, cacheKey);
    if (cached) {
      progress(3, STAGES.review, "Using cached review result…");
      return {
        action: "review",
        review: cached.review,
        model: cached.model,
        cost: cached.cost,
        level,
      };
    }
  }

  progress(3, STAGES.review, "Calculating token budget…");
  const baseBudget = calculateReviewBudget(
    modelConfig.provider,
    modelConfig.id,
    effectiveConfig,
    {
      systemPrompt: "",
      sessionContext,
      conventionsText,
      preReviewOutput: "",
      description,
      memoryContext,
    },
    modelConfig,
  );

  let preReviewOutput = "";
  if (config.preReviewCommands && config.preReviewCommands.length > 0) {
    progress(4, STAGES.review, "Running pre-review commands…");
    const results = await runPreReviewCommands(cwd, config.preReviewCommands);
    preReviewOutput = formatPreReviewOutput(results);
    const preReviewChars = baseBudget.availableInputTokens * 4;
    if (preReviewChars <= 0) {
      preReviewOutput = "";
    } else if (preReviewOutput.length > preReviewChars) {
      preReviewOutput = preReviewOutput.slice(0, preReviewChars) + "\n… (truncated to token budget)";
    }
  } else {
    progress(4, STAGES.review, "Preparing review context…");
  }

  const strategy = effectiveConfig.reviewStrategy ?? "auto";
  const fullFileThresholdLines = config.reviewFullFileThresholdLines ?? 300;
  progress(5, STAGES.review, "Calculating token budget with pre-review output…");
  const budgetWithPreReview = calculateReviewBudget(
    modelConfig.provider,
    modelConfig.id,
    effectiveConfig,
    {
      systemPrompt: "",
      sessionContext,
      conventionsText,
      preReviewOutput,
      description,
      memoryContext,
    },
    modelConfig,
  );
  progress(6, STAGES.review, "Loading changed file contents…");
  const fileDiffs = splitDiffByFile(diff, vcs);

  const reviewableFiles = changedFiles.filter(isReviewableFile);
  const filesWithDiff = reviewableFiles.filter((file) => fileDiffs[file] || !truncated);
  const skippedDueToTruncation = reviewableFiles.filter((file) => !fileDiffs[file] && truncated);
  const diffLikelyTruncated = estimateTokens(diff) > Math.max(0, budgetWithPreReview.availableInputTokens - 1000);
  const shouldParallelize =
    (Boolean(config.parallelReview) || (diffLikelyTruncated && strategy !== "diff-only")) &&
    filesWithDiff.length > 1 &&
    strategy !== "diff-only";
  const maxConcurrency =
    typeof config.parallelReview === "number" && config.parallelReview > 0 ? config.parallelReview : 3;

  // Diff-only reviews (the min level default, or explicit diff-only config)
  // cannot split the diff into hunks or parallelize by file: a single model
  // call must see the whole change. When the diff exceeds the context-derived
  // budget, fail loudly with guidance instead of silently truncating the diff
  // and reviewing only a fragment (the old behavior produced unreliable
  // "diff truncated · context limited" reviews). The budget math mirrors
  // runReviewBatch's remainingForDiff so a diff that fits never errors here.
  if (strategy === "diff-only") {
    const remainingForDiff = Math.max(
      0,
      budgetWithPreReview.availableInputTokens -
        1000 -
        estimateTokens(codemap ?? "") -
        estimateTokens(designRefText ?? ""),
    );
    const diffTokens = estimateTokens(diff);
    if (diffTokens > remainingForDiff) {
      progress(7, STAGES.review, "Diff too large for a diff-only review…");
      return {
        action: "review",
        error: `The change is too large for a diff-only (${level} level) review: the diff needs ~${diffTokens.toLocaleString()} tokens but the model's available context budget is ~${remainingForDiff.toLocaleString()} tokens. Re-run with wai_review_med or wai_review_high (they split large diffs automatically), or scope the review with files:[...].`,
        model: modelProfile,
        level,
      };
    }
  }

  let review: ReviewResult | undefined;
  let cost: UsageCost | undefined;
  let finalDiffTruncated = false;
  let finalDroppedFiles: string[] = [];
  let usedHunkChunking = false;
  let continuationRounds = 0;
  let continuationTruncated = false;

  if (filesWithDiff.length === 1 && diffLikelyTruncated && strategy !== "diff-only") {
    progress(7, STAGES.review, "Diff is large; splitting into hunks for review…");
    const file = filesWithDiff[0];
    const hunks = splitDiffByHunk(fileDiffs[file] ?? "");
    if (hunks.length > 1) {
      const fileMemoryContext = truncateToTokenBudget(
        getPastIssuesForFiles(cwd, [file], description),
        effectiveConfig.reviewMaxMemoryTokens ?? 800,
      );
      const fileBudget = calculateReviewBudget(
        modelConfig.provider,
        modelConfig.id,
        effectiveConfig,
        {
          systemPrompt: "",
          sessionContext,
          conventionsText,
          preReviewOutput,
          description,
          memoryContext: fileMemoryContext,
        },
        modelConfig,
      );
      const fileResult = await loadFileContentsForReview({
        cwd,
        changedFiles: [file],
        budget: fileBudget,
        strategy,
        fullFileThresholdLines,
      });
      const droppedForBudget = fileResult.dropped.filter((f) => isReviewableFile(f));

      const sharedContextEstimate = [sessionContext, conventionsText, preReviewOutput, description].join("\n");
      const outputEstimate =
        modelConfig.thinking && modelConfig.thinking.toLowerCase() !== "off"
          ? (modelConfig.maxOutputTokens ?? 8192)
          : 2048;
      const perHunkInputEstimate =
        1000 +
        estimateTokens(sharedContextEstimate) +
        fileResult.totalTokens +
        estimateTokens(fileDiffs[file] ?? "") / hunks.length +
        estimateTokens(fileMemoryContext);
      const projectedCost = estimateCost(
        modelConfig.provider,
        modelConfig.id,
        perHunkInputEstimate * hunks.length,
        outputEstimate * hunks.length,
      );
      if (config.costBudgetUsd !== undefined && config.costBudgetUsd >= 0) {
        const sessionCost = getSessionCost(cwd).costUsd;
        if (sessionCost + projectedCost > config.costBudgetUsd) {
          return {
            action: "review",
            error: `Hunk-based review would exceed the configured cost budget (${formatCost(config.costBudgetUsd)}).`,
          };
        }
      }
      reserveCost(cwd, projectedCost);

      const hunkTasks = hunks.map((hunk) => async () => {
        const result = await runReviewBatch({
          cwd,
          description,
          files: fileResult.entries,
          diff: hunk,
          vcs,
          criteria: state.plan?.acceptanceCriteria?.join("\n"),
          currentStep,
          sessionContext,
          conventionsText,
          preReviewOutput,
          memoryContext: fileMemoryContext,
          relatedContext,
          codemap,
          designRefText,
          truncated,
          droppedFiles: droppedForBudget,
          budget: fileBudget,
          modelConfig,
          signal,
          sessionManager: ctx.sessionManager,
          relevantPaths: [file],
          nativeJson,
          focusFiles: stepFocusFiles,
          levelInstructions: reviewSettings.instructions,
          ...toolLoopOptions(config),
        });
        return { review: result.review, usage: result.usage, rounds: result.rounds, truncated: result.truncated };
      });

      let outcomes: ConcurrencyOutcome<{
        review: ReviewResult;
        usage: UsageCost;
        rounds?: number;
        truncated?: boolean;
      }>[];
      try {
        outcomes = await runWithConcurrencyLimit(hunkTasks, maxConcurrency, signal);
      } finally {
        releaseCost(cwd, projectedCost);
      }

      const successes: { review: ReviewResult; usage: UsageCost; rounds?: number; truncated?: boolean }[] = [];
      const failures: string[] = [];
      for (const outcome of outcomes) {
        if (outcome.ok) successes.push(outcome.value);
        else failures.push(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
      }

      if (successes.length === 0) {
        return { action: "review", error: failures.join("; "), model: modelProfile };
      }

      review = mergeReviewResults(successes.map((s) => s.review));
      cost = successes.reduce<UsageCost | undefined>(
        (acc, s) => (acc && s.usage ? mergeUsageCost(acc, s.usage) : s.usage),
        undefined,
      );
      if (cost) cost = recordCostWithBudget(cwd, cost);
      finalDiffTruncated = truncated;
      finalDroppedFiles = [...fileResult.dropped, ...skippedDueToTruncation];
      continuationRounds = successes.reduce((sum, s) => sum + (s.rounds ?? 0), 0);
      continuationTruncated = successes.some((s) => s.truncated);

      if (failures.length > 0) {
        review.suggestions.unshift(`Review failed for ${failures.length} hunk(s): ${failures.join("; ")}`);
        review.consensus = false;
      }

      logEvent(cwd, "info", "Hunk-based review completed", {
        file,
        hunkCount: hunks.length,
        successCount: successes.length,
        failureCount: failures.length,
        provider: modelConfig.provider,
        model: modelConfig.id,
      });
      usedHunkChunking = true;
    }
  }

  if (!usedHunkChunking && shouldParallelize) {
    progress(
      7,
      STAGES.review,
      `Reviewing ${filesWithDiff.length} files in parallel with ${secondaryModelLabel(modelConfig)}${diffLikelyTruncated && !config.parallelReview ? " (auto: diff too large for single review)" : ""}…`,
    );

    const sharedContextEstimate = [sessionContext, conventionsText, preReviewOutput, description].join("\n");
    const outputEstimate =
      modelConfig.thinking && modelConfig.thinking.toLowerCase() !== "off"
        ? (modelConfig.maxOutputTokens ?? 8192)
        : 2048;

    interface FilePrep {
      file: string;
      fileMemoryContext: string;
      fileBudget: ReviewBudget;
      fileResult: Awaited<ReturnType<typeof loadFileContentsForReview>>;
      droppedForBudget: string[];
    }
    const preps = await Promise.all(
      filesWithDiff.map(async (file): Promise<FilePrep> => {
        const fileMemoryContext = truncateToTokenBudget(
          getPastIssuesForFiles(cwd, [file], description),
          effectiveConfig.reviewMaxMemoryTokens ?? 800,
        );
        const fileBudget = calculateReviewBudget(
          modelConfig.provider,
          modelConfig.id,
          effectiveConfig,
          {
            systemPrompt: "",
            sessionContext,
            conventionsText,
            preReviewOutput,
            description,
            memoryContext: fileMemoryContext,
          },
          modelConfig,
        );
        const fileResult = await loadFileContentsForReview({
          cwd,
          changedFiles: [file],
          budget: fileBudget,
          strategy,
          fullFileThresholdLines,
        });
        const droppedForBudget = fileResult.dropped.filter((f) => isReviewableFile(f));
        return { file, fileMemoryContext, fileBudget, fileResult, droppedForBudget };
      }),
    );

    let projectedCost = 0;
    for (const p of preps) {
      const contentTokens = p.fileResult.entries.reduce((sum, e) => sum + e.tokenEstimate, 0);
      const diffTokens = estimateTokens(fileDiffs[p.file] ?? "");
      const inputEstimate =
        1000 + estimateTokens(sharedContextEstimate) + contentTokens + diffTokens + estimateTokens(p.fileMemoryContext);
      projectedCost += estimateCost(modelConfig.provider, modelConfig.id, inputEstimate, outputEstimate);
    }
    if (config.costBudgetUsd !== undefined && config.costBudgetUsd >= 0) {
      const sessionCost = getSessionCost(cwd).costUsd;
      if (sessionCost + projectedCost > config.costBudgetUsd) {
        return {
          action: "review",
          error: `Parallel review would exceed the configured cost budget (${formatCost(config.costBudgetUsd)}).`,
        };
      }
    }
    reserveCost(cwd, projectedCost);

    const tasks = preps.map((p) => async () => {
      const result = await runReviewBatch({
        cwd,
        description,
        files: p.fileResult.entries,
        diff: fileDiffs[p.file] ?? "",
        vcs,
        criteria: state.plan?.acceptanceCriteria?.join("\n"),
        currentStep,
        sessionContext,
        conventionsText,
        preReviewOutput,
        memoryContext: p.fileMemoryContext,
        relatedContext,
        codemap,
        designRefText,
        truncated,
        droppedFiles: p.droppedForBudget,
        budget: p.fileBudget,
        modelConfig,
        signal,
        sessionManager: ctx.sessionManager,
        relevantPaths: [p.file],
        nativeJson,
        focusFiles: stepFocusFiles,
        levelInstructions: reviewSettings.instructions,
        ...toolLoopOptions(config),
      });
      return {
        review: result.review,
        usage: result.usage,
        dropped: p.fileResult.dropped,
        rounds: result.rounds,
        truncated: result.truncated,
      };
    });

    let outcomes: ConcurrencyOutcome<{
      review: ReviewResult;
      usage: UsageCost;
      dropped: string[];
      rounds?: number;
      truncated?: boolean;
    }>[];
    try {
      outcomes = await runWithConcurrencyLimit(tasks, maxConcurrency, signal);
    } finally {
      releaseCost(cwd, projectedCost);
    }

    const successes: {
      review: ReviewResult;
      usage: UsageCost;
      dropped: string[];
      rounds?: number;
      truncated?: boolean;
    }[] = [];
    const failures: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) {
        successes.push(outcome.value);
      } else {
        failures.push(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
      }
    }

    if (successes.length === 0) {
      return { action: "review", error: failures.join("; "), model: modelProfile };
    }

    review = mergeReviewResults(successes.map((s) => s.review));
    for (const { usage } of successes) {
      const recorded = recordCostWithBudget(cwd, usage);
      cost = cost ? mergeUsageCost(cost, recorded) : recorded;
    }
    finalDroppedFiles = Array.from(new Set(successes.flatMap((s) => s.dropped).concat(skippedDueToTruncation)));
    if (finalDroppedFiles.length > 0) review.droppedFiles = finalDroppedFiles;
    finalDiffTruncated = truncated || successes.some((s) => s.review.truncated);
    continuationRounds = successes.reduce((sum, s) => sum + (s.rounds ?? 0), 0);
    continuationTruncated = successes.some((s) => s.truncated);

    if (failures.length > 0) {
      review.suggestions.unshift(`Review failed for ${failures.length} file(s): ${failures.join("; ")}`);
      review.consensus = false;
    }

    logEvent(cwd, "info", "Parallel review completed", {
      fileCount: preps.length,
      successCount: successes.length,
      failureCount: failures.length,
      provider: modelConfig.provider,
      model: modelConfig.id,
      estimatedCostUsd: cost?.estimatedCostUsd,
    });
  } else if (!usedHunkChunking) {
    const fileResult =
      strategy === "diff-only"
        ? { entries: [] as FileContentEntry[], dropped: [] as string[], totalTokens: 0 }
        : await loadFileContentsForReview({
            cwd,
            changedFiles,
            budget: budgetWithPreReview,
            strategy,
            fullFileThresholdLines,
          });

    const systemPromptEstimate = 1000;
    const remainingForDiff = Math.max(
      0,
      budgetWithPreReview.availableInputTokens - fileResult.totalTokens - systemPromptEstimate,
    );
    const diffTokens = estimateTokens(diff);
    const finalDiff =
      diffTokens > remainingForDiff ? diff.slice(0, remainingForDiff * 4) + "\n... diff truncated" : diff;
    finalDiffTruncated = truncated || finalDiff !== diff;
    finalDroppedFiles = [...fileResult.dropped, ...skippedDueToTruncation];

    progress(7, STAGES.review, "Building review prompt…");
    let result: Awaited<ReturnType<typeof runReviewBatch>>;
    try {
      result = await runReviewBatch({
        cwd,
        description,
        files: fileResult.entries,
        diff: finalDiff,
        vcs,
        criteria: state.plan?.acceptanceCriteria?.join("\n"),
        currentStep,
        sessionContext,
        conventionsText,
        preReviewOutput,
        memoryContext,
        relatedContext,
        codemap,
        designRefText,
        truncated: finalDiffTruncated,
        droppedFiles: finalDroppedFiles,
        budget: budgetWithPreReview,
        modelConfig,
        signal,
        sessionManager: ctx.sessionManager,
        relevantPaths: Array.from(new Set([...(options.files ?? []), ...changedFiles])),
        progress,
        nativeJson,
        focusFiles: stepFocusFiles,
        levelInstructions: reviewSettings.instructions,
        ...toolLoopOptions(config),
      });
    } catch (err) {
      return {
        action: "review",
        error: err instanceof Error ? err.message : String(err),
        model: modelProfile,
      };
    }
    review = result.review;
    cost = recordCostWithBudget(cwd, result.usage);
    continuationRounds = result.rounds ?? 0;
    continuationTruncated = result.truncated ?? false;

    if (effectiveConfig.selfVerify) {
      progress(8, STAGES.review, "Self-verifying review result…");
      try {
        const verified = await verifyResult(cwd, modelConfig, {
          originalSystem: result.system,
          originalUser: result.user,
          result: review,
          task: "review",
          signal,
          sessionManager: ctx.sessionManager,
          validate: validateReviewResult,
          validationErrors: getReviewValidationErrors,
          salvage: salvageReviewFromMarkdown,
        });
        review = verified.result;
        cost = mergeVerifiedCost(cost, recordCostWithBudget(cwd, verified.usage));
      } catch (err) {
        logEvent(cwd, "warn", "Self-verification failed; keeping original review", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (!review) {
    return { action: "review", error: "Review could not be produced", model: modelProfile };
  }

  progress(8, STAGES.review, "Review response received");
  if (changedFiles.length > 0) {
    const changedFilesSet = new Set(changedFiles);
    const originalIssueCount = review.issues.length;
    review.issues = review.issues.filter((issue) => {
      if (!issue.file) return true;
      return changedFilesSet.has(issue.file);
    });
    if (review.issues.length < originalIssueCount) {
      logEvent(cwd, "info", "Filtered out-of-scope review issues", {
        original: originalIssueCount,
        kept: review.issues.length,
        removed: originalIssueCount - review.issues.length,
      });
    }
  }
  recordIssues(cwd, review.issues);

  // A non-pass verdict with ZERO issues is not actionable: either the model
  // response was truncated and salvage recovered only a bare verdict, or the
  // verdict contradicts its own findings (issues empty, suggestions positive).
  // It is not a pass (no evidence of clean), but it must not count as a failed
  // review round or tell the user to fix nonexistent issues — mark it
  // inconclusive.
  if ((review.verdict === "needs-work" || review.verdict === "blocked") && review.issues.length === 0) {
    review.inconclusive = true;
    review.suggestions.push(
      review.suggestions.length > 0
        ? "The review returned a non-pass verdict but reported no issues — the verdict contradicts its own findings, so it is inconclusive (likely a verdict slip by the model, not a real failure). Re-run wai.review; if the change is genuinely fine the re-run should pass."
        : "The review returned a verdict with no issues, so it is inconclusive — the model response was likely truncated or off-scope. Re-run wai.review; if it repeats, lower the thinking level or scope the diff with files:[...].",
    );
    logEvent(cwd, "warn", "Review verdict had no issues; marked inconclusive", {
      verdict: review.verdict,
      truncated: continuationTruncated,
    });
  }

  if ((review.verdict === "needs-work" || review.verdict === "blocked") && review.issues.length > 0) {
    const plan: string[] = [];
    for (const issue of review.issues) {
      const loc = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "the change";
      const action = issue.suggestion || issue.issue;
      plan.push(`Fix ${issue.severity} issue in ${loc}: ${action}`);
    }
    review.fixPlan = plan.filter((step, index) => index === 0 || step !== plan[index - 1]);
  }

  if (finalDiffTruncated) review.truncated = true;
  if (finalDroppedFiles.length > 0) review.droppedFiles = finalDroppedFiles;
  if (finalDiffTruncated || finalDroppedFiles.length > 0) {
    review.contextLimited = true;
    review.suggestions.push(
      "The change is large and some context was omitted. If the review missed something, scope it with --files or increase reviewMaxInputTokens.",
    );
  }

  if (review.verdict === "blocked" && (finalDiffTruncated || review.truncated || finalDroppedFiles.length > 0)) {
    review.verdict = "needs-work";
    review.consensus = false;
    review.suggestions.push(
      "Verdict was downgraded from 'blocked' to 'needs-work' because the review context was incomplete (truncated diff or omitted files); the review is inconclusive.",
    );
  }

  if (cacheable && cacheKey) {
    setCachedResult(cwd, "review", cacheKey, { review, model: modelProfile, cost });
  }

  // Propose-only staleness: never touch the plan; surface the update
  // suggestion once per review round (auto-review on settle must not repeat
  // it for the same round). The suggestion annotates ONLY the result handed
  // to the caller — the cached payload stays raw so a later cache hit on an
  // identical diff does not replay it outside the guard.
  if (review.planStale && state.plan && planStaleSuggestionDue(cwd)) {
    review = {
      ...review,
      suggestions: [
        "The review flagged the active plan as stale (it no longer matches the code). Once the code is in a consistent state, update the plan with `/wai-plan-update` or `wai({ planUpdate: '...' })`.",
        ...review.suggestions,
      ],
    };
    logEvent(cwd, "info", "Review flagged the plan as stale; suggested a plan update", {
      provider: modelConfig.provider,
      model: modelConfig.id,
    });
  }

  // Guarded auto-completion: consensus (pass with zero issues) advances as
  // before; an explicit stepComplete signal advances exactly the current step.
  const advance = planAdvanceFromReview(
    review,
    state.plan !== undefined && state.totalSteps > 0,
    state.completedSteps >= state.totalSteps,
  );
  if (advance) {
    if (advance.count > 0) {
      const newCompleted = Math.min(state.completedSteps + advance.count, state.totalSteps);
      markStepsComplete(cwd, newCompleted, true);
      auditStepDone(ctx, newCompleted, state.totalSteps, true);
    }
    const planProgress = getProgress(cwd);
    review.planProgress = `${planProgress.completed}/${planProgress.total} steps done`;
    if (planProgress.nextStep) {
      review.nextStep = planProgress.nextStep;
    }

    if (
      config.autoJudge &&
      !state.judgeCompleted &&
      planProgress.completed === planProgress.total &&
      planProgress.total > 0
    ) {
      progress(10, STAGES.review, "Auto-judging completed work…");
      const judgeProgress: ProgressReporter = (stage, _total, message) => {
        progress(STAGES.review, STAGES.review, `[judge] ${message}`);
      };
      try {
        const judgeResult = await executeWaiJudge(
          cwd,
          `All ${planProgress.total} plan steps completed.`,
          signal,
          judgeProgress,
          ctx.sessionManager,
        );
        if (judgeResult.judge) {
          review.autoJudged = true;
          markJudgeCompleted(cwd);
          const mergedCost =
            cost && judgeResult.cost ? mergeUsageCost(cost, judgeResult.cost) : (cost ?? judgeResult.cost);
          return {
            action: "review",
            review,
            judge: judgeResult.judge,
            cost: mergedCost,
            model: modelProfile,
            level,
            continuation: continuationMeta(continuationRounds, continuationTruncated),
          };
        } else if (judgeResult.error) {
          markJudgeCompleted(cwd);
          review.suggestions.push(`Auto-judge failed: ${judgeResult.error}`);
        }
      } catch (err) {
        logEvent(cwd, "warn", "Auto-judge failed; keeping review result", {
          error: err instanceof Error ? err.message : String(err),
        });
        review.suggestions.push(
          `Auto-judge failed: ${err instanceof Error ? err.message : String(err)}. The review result is still available.`,
        );
      }
    }
  } else if (!review.inconclusive) {
    // Inconclusive reviews (verdict with zero issues) are not failed rounds —
    // the model gave us nothing to act on, so they must not feed escalation.
    incrementReviewRounds(cwd);
    const updatedState = getState(cwd);
    if ((updatedState.reviewRounds[updatedState.completedSteps] ?? 0) >= 3) {
      review.escalated = true;
      review.suggestions.push(
        "This step has failed review 3 times. Consider regenerating the plan with `/wai-plan-update` or `wai({ planUpdate: '...' })`, breaking this step into smaller pieces, or asking the user for guidance.",
      );
    }
  }

  progress(10, STAGES.review, "Finalizing review…");
  if (vcsInfo.type === "git" && vcsInfo.revision && review.verdict !== "blocked") {
    setLastReviewedCommit(cwd, vcsInfo.revision);
  }
  return {
    action: "review",
    review,
    cost,
    model: modelProfile,
    level,
    continuation: continuationMeta(continuationRounds, continuationTruncated),
  };
}
