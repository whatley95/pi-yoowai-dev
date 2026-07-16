import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadHeyyooConfig, resolveTaskModel } from "../config.js";
import { loadConventions, formatConventions } from "../conventions.js";
import { getDiff } from "../diff-grabber.js";
import { loadFileContentsForReview, type FileContentEntry } from "../file-loader.js";
import { callSecondaryModel, providerSupportsJsonObject } from "../secondary-model.js";
import { resolveBackendType } from "../backends/backend-resolver.js";
import {
  buildJudgePrompt,
  validateJudgeResult,
  getJudgeValidationErrors,
  salvageJudgeFromMarkdown,
} from "../prompts.js";
import { getPastIssuesForFiles } from "../review-memory.js";
import { runPreReviewCommands, formatPreReviewOutput } from "../pre-review.js";
import { calculateReviewBudget, estimateTokens } from "../token-budget.js";
import { getState, buildReviewHistory, getProgress, markStepsDoneByIds, getEditTracker } from "../session-state.js";
import { logEvent } from "../logger.js";
import {
  STAGES,
  secondaryModelLabel,
  recordCostWithBudget,
  parseStructuredResult,
  createStreamProgressCallback,
  toolLoopOptions,
} from "./shared.js";
import { verifyResult, mergeVerifiedCost } from "./verify.js";
import type { ProgressReporter } from "../progress.js";
import type { YooToolResult } from "../types.js";

export async function executeYooJudge(
  cwd: string,
  description: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: ExtensionContext["sessionManager"],
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  const modelConfig = resolveTaskModel(config, "judge");
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "judge", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }
  const modelProfile = {
    provider: modelConfig.provider,
    id: modelConfig.id,
    thinking: modelConfig.thinking,
    backend: resolveBackendType(modelConfig.provider, modelConfig),
  };
  const nativeJson = providerSupportsJsonObject(modelConfig.provider, modelConfig.id, modelConfig);

  const state = getState(cwd);
  const reviewHistory = buildReviewHistory(cwd);
  const editTracker = getEditTracker(cwd);
  const currentStepIndex = state.completedSteps;
  const hasUnreviewedEdits =
    editTracker.editsSinceLastReview > 0 &&
    state.totalSteps > 0 &&
    currentStepIndex < state.totalSteps &&
    !state.reviewedSteps[currentStepIndex];

  progress(1, STAGES.judge, "Collecting diff and conventions…");
  const { diff, truncated, changedFiles } = getDiff(cwd, {
    maxDiffChars: config.reviewMaxDiffChars,
    untracked: true,
    revision: "HEAD",
  });

  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";
  const memoryContext = getPastIssuesForFiles(cwd, changedFiles);

  progress(2, STAGES.judge, "Calculating token budget…");
  let preReviewOutput = "";
  if (config.preReviewCommands && config.preReviewCommands.length > 0) {
    progress(2, STAGES.judge, "Running pre-review commands…");
    const results = await runPreReviewCommands(cwd, config.preReviewCommands);
    preReviewOutput = formatPreReviewOutput(results);
  }

  const baseBudget = calculateReviewBudget(
    modelConfig.provider,
    modelConfig.id,
    config,
    {
      systemPrompt: "",
      sessionContext: "",
      conventionsText,
      preReviewOutput,
      description,
      memoryContext,
    },
    modelConfig,
  );

  const preReviewChars = baseBudget.availableInputTokens * 4;
  if (preReviewChars <= 0) {
    preReviewOutput = "";
  } else if (preReviewOutput.length > preReviewChars) {
    preReviewOutput = preReviewOutput.slice(0, preReviewChars) + "\n… (truncated to token budget)";
  }

  const budgetWithPreReview = calculateReviewBudget(
    modelConfig.provider,
    modelConfig.id,
    config,
    {
      systemPrompt: "",
      sessionContext: "",
      conventionsText,
      preReviewOutput,
      description,
      memoryContext,
    },
    modelConfig,
  );

  progress(2, STAGES.judge, "Loading changed file contents…");
  const strategy = config.reviewStrategy ?? "auto";
  const fullFileThresholdLines = config.reviewFullFileThresholdLines ?? 300;
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
  const finalDiff = diffTokens > remainingForDiff ? diff.slice(0, remainingForDiff * 4) + "\n... diff truncated" : diff;
  const finalDiffTruncated = truncated || finalDiff !== diff;
  const finalDroppedFiles = fileResult.dropped;

  const { system, user } = buildJudgePrompt(description, {
    planTodo: state.plan?.todo,
    acceptanceCriteria: state.plan?.acceptanceCriteria,
    reviewHistory,
    conventions: conventionsText,
    preReviewOutput,
    memoryContext,
    diff: finalDiff,
    fileContents: fileResult.entries.map((f) => ({ file: f.file, content: f.content, mode: f.mode })),
    truncated: finalDiffTruncated,
    droppedFiles: finalDroppedFiles,
    budgetNote: `Context window: ${budgetWithPreReview.contextWindow.toLocaleString()} tokens. Reserved output: ${budgetWithPreReview.reservedOutputTokens.toLocaleString()}. Available for context: ${budgetWithPreReview.availableInputTokens.toLocaleString()}.`,
    nativeJson,
  });

  progress(3, STAGES.judge, `Calling ${secondaryModelLabel(modelConfig)}…`);
  const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
    signal,
    thinking: modelConfig.thinking,
    cwd,
    sessionManager,
    task: "judge",
    structuredOutput: true,
    onStreamProgress: createStreamProgressCallback(progress, 3, STAGES.judge),
    ...toolLoopOptions(config),
  });

  progress(3, STAGES.judge, "Parsing judgment…");
  let cost = recordCostWithBudget(cwd, usage);
  let judge = parseStructuredResult(cwd, raw, {
    label: "Judgment",
    validate: validateJudgeResult,
    validationErrors: getJudgeValidationErrors,
    salvage: salvageJudgeFromMarkdown,
    salvageDetails: (salvaged) => ({
      verdict: salvaged.verdict,
      suggestionCount: salvaged.suggestions.length,
    }),
  });
  if (!judge) {
    return {
      action: "judge",
      error: "Failed to parse judgment from secondary model response.",
      cost,
      model: modelProfile,
    };
  }

  if (config.selfVerify) {
    progress(3, STAGES.judge, "Self-verifying judgment…");
    try {
      const verified = await verifyResult(cwd, modelConfig, {
        originalSystem: system,
        originalUser: user,
        result: judge,
        task: "judge",
        signal,
        sessionManager,
        validate: validateJudgeResult,
        validationErrors: getJudgeValidationErrors,
        salvage: salvageJudgeFromMarkdown,
      });
      judge = verified.result;
      cost = mergeVerifiedCost(cost, recordCostWithBudget(cwd, verified.usage)) ?? cost;
    } catch (err) {
      logEvent(cwd, "warn", "Self-verification failed; keeping original judgment", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (hasUnreviewedEdits) {
    judge.unreviewedEdits = true;
    judge.suggestions.push(
      "There are unreviewed edits since the last yoo.review. Consider running yoo.review first, or treat this judgment as covering all changes.",
    );
  }

  if (finalDiffTruncated || finalDroppedFiles.length > 0) {
    judge.truncated = finalDiffTruncated;
    judge.droppedFiles = finalDroppedFiles;
    judge.contextLimited = true;
    judge.suggestions.push(
      "The change is large and some context was omitted. If the judgment missed something, scope it with --files or increase reviewMaxInputTokens.",
    );
  }

  if (judge.verdict === "blocked" && judge.contextLimited) {
    judge.verdict = "needs-work";
    judge.consensus = false;
    judge.suggestions.push(
      "Verdict was downgraded from 'blocked' to 'needs-work' because the judgment context was incomplete (truncated diff or omitted files); the judgment is inconclusive.",
    );
  }

  if (judge.verdict === "pass" && judge.consensus && judge.completedStepIds && judge.completedStepIds.length > 0) {
    const state = getState(cwd);
    if (state.totalSteps > 0) {
      const previousCompleted = state.completedSteps;
      const newCompleted = markStepsDoneByIds(cwd, judge.completedStepIds, true);
      if (newCompleted > previousCompleted) {
        const progress = getProgress(cwd);
        judge.planProgress = `${progress.completed}/${progress.total} steps done`;
        judge.nextStep = progress.nextStep;
        logEvent(cwd, "info", "Judge auto-synced plan tracker", {
          previousCompleted,
          newCompleted,
          completedStepIds: judge.completedStepIds,
        });
      }
    }
  }

  return { action: "judge", judge, cost, model: modelProfile };
}
