import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadYoowaiConfig, resolveTaskModel } from "../config.js";
import { loadConventions, formatConventions } from "../conventions.js";
import { getDiff } from "../diff-grabber.js";
import { buildCodemap } from "../codemap.js";
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
import {
  getState,
  buildReviewHistory,
  getProgress,
  markStepsDoneByIds,
  setPlanProgress,
  getEditTracker,
} from "../session-state.js";
import { logEvent } from "../logger.js";
import {
  STAGES,
  secondaryModelLabel,
  recordCostWithBudget,
  parseStructuredResult,
  createStreamProgressCallback,
  toolLoopOptions,
  continuationMeta,
} from "./shared.js";
import { verifyResult, mergeVerifiedCost } from "./verify.js";
import { runJudgeCouncil } from "./judge-council.js";
import type { ProgressReporter } from "../progress.js";
import type { JudgeResult, UsageCost, WaiToolResult } from "../types.js";

export async function executeWaiJudge(
  cwd: string,
  description: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: ExtensionContext["sessionManager"],
): Promise<WaiToolResult> {
  const config = loadYoowaiConfig(cwd);
  const modelConfig = resolveTaskModel(config, "judge");
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "judge", error: "No secondary model configured. Set pi-yoowai.secondary in settings.json." };
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
  const codemap = buildCodemap(cwd, changedFiles, config.codemapMaxTokens ?? 1500);

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
  // The codemap is counted within the input budget but yields to file
  // contents: it is deducted from what remains for the diff, after files.
  const remainingForDiff = Math.max(
    0,
    budgetWithPreReview.availableInputTokens - fileResult.totalTokens - systemPromptEstimate - estimateTokens(codemap),
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
    codemap,
    diff: finalDiff,
    fileContents: fileResult.entries.map((f) => ({ file: f.file, content: f.content, mode: f.mode })),
    truncated: finalDiffTruncated,
    droppedFiles: finalDroppedFiles,
    budgetNote: `Context window: ${budgetWithPreReview.contextWindow.toLocaleString()} tokens. Reserved output: ${budgetWithPreReview.reservedOutputTokens.toLocaleString()}. Available for context: ${budgetWithPreReview.availableInputTokens.toLocaleString()}.`,
    nativeJson,
  });

  let judge: JudgeResult | null;
  let cost: UsageCost | undefined;
  let rounds: number | undefined;
  let finalTruncated: boolean | undefined;

  // When a judge council is configured (>= 2 valid members), fan the same prompt
  // out to all members and synthesize their verdicts. Returns null when the
  // council cannot run, falling through to the standard single-model judge.
  const councilOutcome = await runJudgeCouncil({
    cwd,
    config,
    description,
    system,
    user,
    synthesizer: modelConfig,
    signal,
    sessionManager,
    progress,
  });

  if (councilOutcome) {
    judge = councilOutcome.judge;
    cost = councilOutcome.cost;
  } else {
    progress(3, STAGES.judge, `Calling ${secondaryModelLabel(modelConfig)}…`);
    const {
      content: raw,
      usage,
      rounds: singleRounds,
      truncated: singleTruncated,
    } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
      signal,
      thinking: modelConfig.thinking,
      cwd,
      sessionManager,
      task: "judge",
      structuredOutput: true,
      onStreamProgress: createStreamProgressCallback(progress, 3, STAGES.judge),
      ...toolLoopOptions(config),
    });
    rounds = singleRounds;
    finalTruncated = singleTruncated;

    progress(3, STAGES.judge, "Parsing judgment…");
    cost = recordCostWithBudget(cwd, usage);
    judge = parseStructuredResult(cwd, raw, {
      label: "Judgment",
      validate: validateJudgeResult,
      validationErrors: getJudgeValidationErrors,
      salvage: salvageJudgeFromMarkdown,
      salvageDetails: (salvaged) => ({
        verdict: salvaged.verdict,
        suggestionCount: salvaged.suggestions.length,
      }),
    });
  }
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
      "There are unreviewed edits since the last wai.review. Consider running wai.review first, or treat this judgment as covering all changes.",
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

  // The judge is the holistic authority on which plan steps the code actually
  // completes, so sync the tracker whenever it reports step IDs — even on a
  // needs-work verdict (quality issues do not mean the steps are not done).
  // The "reviewed" flag stays tied to a passing verdict so judge history is
  // not falsified. Sync is advance-only; it never regresses the tracker.
  if (judge.completedStepIds && judge.completedStepIds.length > 0) {
    const state = getState(cwd);
    if (state.totalSteps > 0) {
      const reviewed = judge.verdict === "pass" && judge.consensus;
      const previousCompleted = state.completedSteps;
      const newCompleted = markStepsDoneByIds(cwd, judge.completedStepIds, reviewed);
      if (newCompleted > previousCompleted) {
        const progress = getProgress(cwd);
        judge.planProgress = `${progress.completed}/${progress.total} steps done`;
        judge.nextStep = progress.nextStep;
        logEvent(cwd, "info", "Judge auto-synced plan tracker", {
          previousCompleted,
          newCompleted,
          completedStepIds: judge.completedStepIds,
          verdict: judge.verdict,
        });
      }
    }
  }

  // Explicit regression: the judge names steps the tracker marks complete
  // that the code does not actually satisfy. Steps are sequential, so roll
  // back to just before the earliest incomplete step. This only fires when
  // the model explicitly reports incomplete steps — never inferred from a
  // short completedStepIds list, which may just reflect partial examination.
  if (judge.incompleteStepIds && judge.incompleteStepIds.length > 0) {
    const state = getState(cwd);
    const earliest = Math.min(...judge.incompleteStepIds);
    if (state.totalSteps > 0 && earliest <= state.completedSteps) {
      const previousCompleted = state.completedSteps;
      setPlanProgress(cwd, earliest - 1);
      const progress = getProgress(cwd);
      judge.planProgress = `${progress.completed}/${progress.total} steps done`;
      judge.nextStep = progress.nextStep;
      logEvent(cwd, "info", "Judge regressed plan tracker", {
        previousCompleted,
        newCompleted: progress.completed,
        incompleteStepIds: judge.incompleteStepIds,
        verdict: judge.verdict,
      });
    }
  }

  return {
    action: "judge",
    judge,
    cost,
    model: modelProfile,
    continuation: continuationMeta(rounds, finalTruncated ?? false),
  };
}
