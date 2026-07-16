import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadHeyyooConfig, resolveTaskModel } from "../config.js";
import { getDiff, splitDiffByFile } from "../diff-grabber.js";
import { loadConventions, formatConventions } from "../conventions.js";
import { providerSupportsJsonObject, estimateCost } from "../secondary-model.js";
import { loadFileContentsForReview, isReviewableFile, type FileContentEntry } from "../file-loader.js";
import { getPastIssuesForFiles, recordIssues } from "../review-memory.js";
import { runPreReviewCommands, formatPreReviewOutput } from "../pre-review.js";
import { calculateReviewBudget, estimateTokens, type ReviewBudget } from "../token-budget.js";
import { getSessionCost, formatCost, reserveCost, releaseCost } from "../cost-tracker.js";
import { logEvent } from "../logger.js";
import {
  getState,
  markStepsComplete,
  incrementReviewRounds,
  getProgress,
  markJudgeCompleted,
} from "../session-state.js";
import { planStepDescription } from "../types.js";
import { STAGES, secondaryModelLabel, recordCostWithBudget, mergeUsageCost, toolLoopOptions } from "./shared.js";
import {
  getSessionContext,
  runWithConcurrencyLimit,
  mergeReviewResults,
  runReviewBatch,
  type ConcurrencyOutcome,
} from "./review-helpers.js";
import { executeYooJudge } from "./judge.js";
import { resolveBackendType } from "../backends/backend-resolver.js";
import { validateReviewResult, getReviewValidationErrors, salvageReviewFromMarkdown } from "../prompts.js";
import { verifyResult, mergeVerifiedCost } from "./verify.js";
import { buildCacheKey, getCachedReview, setCachedResult } from "../review-cache.js";
import type { ProgressReporter } from "../progress.js";
import type { YooToolResult, ReviewResult, UsageCost } from "../types.js";

export async function executeYooReview(
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
  } = {},
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  const modelConfig = resolveTaskModel(config, "review");
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "review", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
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

  progress(1, STAGES.review, "Collecting diff…");
  const { diff, truncated, changedFiles, vcs } = getDiff(cwd, {
    ...options,
    maxDiffChars: config.reviewMaxDiffChars,
  });
  const sessionContext = getSessionContext(ctx);

  progress(2, STAGES.review, "Loading project conventions…");
  let conventionsText = "";
  const conventions = loadConventions(cwd);
  if (conventions) {
    conventionsText = formatConventions(conventions);
  }

  const memoryContext = getPastIssuesForFiles(cwd, changedFiles);

  const cacheable = !config.preReviewCommands || config.preReviewCommands.length === 0;
  const cacheKey = cacheable
    ? buildCacheKey("review", {
        diff,
        description,
        modelProfile,
        currentStep,
        options,
        reviewMaxDiffChars: config.reviewMaxDiffChars,
        reviewStrategy: config.reviewStrategy,
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
      };
    }
  }

  progress(3, STAGES.review, "Calculating token budget…");
  const baseBudget = calculateReviewBudget(
    modelConfig.provider,
    modelConfig.id,
    config,
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

  const strategy = config.reviewStrategy ?? "auto";
  const fullFileThresholdLines = config.reviewFullFileThresholdLines ?? 300;
  progress(5, STAGES.review, "Calculating token budget with pre-review output…");
  const budgetWithPreReview = calculateReviewBudget(
    modelConfig.provider,
    modelConfig.id,
    config,
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

  let review: ReviewResult;
  let cost: UsageCost | undefined;
  let finalDiffTruncated: boolean;
  let finalDroppedFiles: string[];

  if (shouldParallelize) {
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
        const fileMemoryContext = getPastIssuesForFiles(cwd, [file]);
        const fileBudget = calculateReviewBudget(
          modelConfig.provider,
          modelConfig.id,
          config,
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
        truncated,
        droppedFiles: p.droppedForBudget,
        budget: p.fileBudget,
        modelConfig,
        signal,
        sessionManager: ctx.sessionManager,
        relevantPaths: [p.file],
        nativeJson,
        ...toolLoopOptions(config),
      });
      return { review: result.review, usage: result.usage, dropped: p.fileResult.dropped };
    });

    let outcomes: ConcurrencyOutcome<{ review: ReviewResult; usage: UsageCost; dropped: string[] }>[];
    try {
      outcomes = await runWithConcurrencyLimit(tasks, maxConcurrency, signal);
    } finally {
      releaseCost(cwd, projectedCost);
    }

    const successes: { review: ReviewResult; usage: UsageCost; dropped: string[] }[] = [];
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
  } else {
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
        truncated: finalDiffTruncated,
        droppedFiles: finalDroppedFiles,
        budget: budgetWithPreReview,
        modelConfig,
        signal,
        sessionManager: ctx.sessionManager,
        relevantPaths: Array.from(new Set([...(options.files ?? []), ...changedFiles])),
        progress,
        nativeJson,
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

    if (config.selfVerify) {
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

  if (review.consensus) {
    const completedCount =
      typeof review.completedSteps === "number" && review.completedSteps > 1 ? review.completedSteps : 1;
    markStepsComplete(cwd, completedCount, true);
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
      const judgeResult = await executeYooJudge(
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
        return { action: "review", review, judge: judgeResult.judge, cost: mergedCost, model: modelProfile };
      } else if (judgeResult.error) {
        markJudgeCompleted(cwd);
        review.suggestions.push(`Auto-judge failed: ${judgeResult.error}`);
      }
    }
  } else {
    incrementReviewRounds(cwd);
    const updatedState = getState(cwd);
    if ((updatedState.reviewRounds[updatedState.completedSteps] ?? 0) >= 3) {
      review.escalated = true;
      review.suggestions.push(
        "This step has failed review 3 times. Consider asking the user for guidance or trying a fundamentally different approach.",
      );
    }
  }

  progress(10, STAGES.review, "Finalizing review…");
  return { action: "review", review, cost, model: modelProfile };
}
