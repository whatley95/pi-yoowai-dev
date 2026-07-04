import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./pi-paths.js";
import { loadHeyyooConfig, resolveTaskModel } from "./config.js";
import { callSecondaryModel, setPiSessionId, clearPiSessionId, estimateCost } from "./secondary-model.js";
import { getDiff, getVcsInfo, splitDiffByFile } from "./diff-grabber.js";

const { version: VERSION, homepage: HOMEPAGE = "https://whatley.xyz" } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string; homepage?: string };
import {
  buildPlanPrompt,
  buildAdaptiveReviewPrompt,
  buildSuggestPrompt,
  buildRecommendPrompt,
  buildJudgePrompt,
  buildScanPrompt,
  clearPromptCache,
  parseJsonResponse,
  validatePlanResult,
  validateReviewResult,
  validateSuggestResult,
  validateRecommendResult,
  validateJudgeResult,
  validateConventionsResult,
  getJsonParseError,
  getReviewValidationErrors,
  getSuggestValidationErrors,
  getRecommendValidationErrors,
  getJudgeValidationErrors,
} from "./prompts.js";
import { calculateReviewBudget, estimateTokens, type ReviewBudget } from "./token-budget.js";
import { resolveModelInfo } from "./model-registry.js";
import { loadFileContentsForReview, isReviewableFile, type FileContentEntry } from "./file-loader.js";
import { renderCall, renderResult } from "./render.js";
import { loadState, saveState, clearState } from "./plan-store.js";
import type {
  YooToolParams,
  YooToolResult,
  HeyyooSessionState,
  PlanResult,
  YooAction,
  UsageCost,
  SecondaryModelConfig,
  ReviewResult,
  ReviewVerdict,
} from "./types.js";
import {
  createLoopDetectionState,
  recordToolCall,
  checkLoop,
  shouldSendSteer,
  type LoopDetectionState,
} from "./loop-detector.js";
import { recordCost, getSessionCost, formatCost, resetCost, reserveCost, releaseCost } from "./cost-tracker.js";
import { recordIssues, getPastIssuesForFiles, clearMemory } from "./review-memory.js";
import {
  loadConventions,
  saveConventions,
  scanProjectConventions,
  formatConventions,
  clearConventions,
  mergeConventions,
  filterSourceFiles,
  formatConfigFiles,
  gatherDeepScanSamples,
} from "./conventions.js";
import { runPreReviewCommands, formatPreReviewOutput } from "./pre-review.js";
import { logEvent, readRecentLogs, clearLogs } from "./logger.js";
import { createProgressReporter, clearYooStatus, type ProgressReporter } from "./progress.js";

const STAGES = {
  plan: 3,
  review: 10,
  suggest: 3,
  recommend: 3,
  judge: 3,
  scan: 4,
} as const;

function secondaryModelLabel(secondary: SecondaryModelConfig): string {
  const { provider, id, backend } = secondary;
  const label = provider && id ? `${provider}:${id}` : "secondary model";
  return backend ? `${label} (${backend})` : label;
}

const sessionStates = new Map<string, HeyyooSessionState>();

function getState(cwd: string): HeyyooSessionState {
  let state = sessionStates.get(cwd);
  if (!state) {
    state = loadState(cwd) ?? { completedSteps: 0, totalSteps: 0, reviewRounds: 0, reviewedSteps: [] };
    sessionStates.set(cwd, state);
  }
  return state;
}

function setPlan(cwd: string, plan: PlanResult): void {
  const state = getState(cwd);
  state.plan = plan;
  state.totalSteps = plan.todo.length;
  state.completedSteps = 0;
  state.reviewRounds = 0;
  state.reviewedSteps = new Array(plan.todo.length).fill(false);
  saveState(cwd, state);
}

function markStepComplete(cwd: string, reviewed = false): void {
  const state = getState(cwd);
  if (state.totalSteps > 0 && state.completedSteps < state.totalSteps) {
    state.completedSteps++;
    state.reviewRounds = 0;
    state.reviewedSteps[state.completedSteps - 1] = reviewed;
    saveState(cwd, state);
  }
}

function incrementReviewRounds(cwd: string): void {
  const state = getState(cwd);
  state.reviewRounds++;
  saveState(cwd, state);
}

function getProgress(cwd: string): { current: number; total: number; nextStep?: string } {
  const state = getState(cwd);
  const current = state.completedSteps;
  const total = state.totalSteps;
  const nextStep = state.plan?.todo[current] ?? undefined;
  return { current, total, nextStep };
}

function buildReviewHistory(cwd: string): string {
  const state = getState(cwd);
  if (!state.plan || state.plan.todo.length === 0) return "";
  const lines: string[] = [];
  for (let i = 0; i < state.plan.todo.length; i++) {
    if (i < state.completedSteps) {
      const reviewed = state.reviewedSteps[i] ? "reviewed and passed" : "marked complete (not reviewed)";
      lines.push(`✓ Step ${i + 1}: ${state.plan.todo[i]} — ${reviewed}`);
    } else if (i === state.completedSteps) {
      lines.push(`→ Step ${i + 1}: ${state.plan.todo[i]} — current (may or may not be done)`);
    } else {
      lines.push(`· Step ${i + 1}: ${state.plan.todo[i]} — not yet started`);
    }
  }
  return lines.join("\n");
}

const MAX_SESSION_CONTEXT_CHARS = 4000;

function getSessionContext(ctx: ExtensionContext): string {
  try {
    const entries = ctx.sessionManager?.getEntries();
    if (!Array.isArray(entries) || entries.length === 0) return "";

    // Exclude the most recent entry because it is the current user/tool turn that
    // triggered this yoo call; including it would add self-referential noise.
    const recent = entries.length > 1 ? entries.slice(-10, -1) : [];
    const lines: string[] = [];
    let total = 0;

    for (const entry of recent.slice().reverse()) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const msg = (e.message ?? e) as Record<string, unknown> | undefined;
      if (!msg || typeof msg.role !== "string") continue;
      if (msg.role === "tool") continue;

      const content = extractTextContent(msg);
      if (!content) continue;

      const line = `[${msg.role}] ${content}`;
      if (total + line.length > MAX_SESSION_CONTEXT_CHARS) break;
      lines.push(line);
      total += line.length;
    }

    return lines.reverse().join("\n");
  } catch {
    return "";
  }
}

function extractTextContent(msg: Record<string, unknown>): string {
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(
        (c): c is Record<string, unknown> =>
          c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string",
      )
      .map((c) => (c as Record<string, unknown>).text as string)
      .join(" ");
  }
  if (typeof msg.content === "string") return msg.content;
  return "";
}

async function executeYooPlan(
  cwd: string,
  task: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: ExtensionContext["sessionManager"],
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  const modelConfig = resolveTaskModel(config, "plan");
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "plan", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }

  progress(1, STAGES.plan, "Loading project conventions…");
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";

  progress(2, STAGES.plan, `Calling ${secondaryModelLabel(modelConfig)}…`);
  const { system, user } = buildPlanPrompt(task, conventionsText);
  const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
    signal,
    thinking: modelConfig.thinking,
    cwd,
    sessionManager,
    task: "plan",
  });

  progress(3, STAGES.plan, "Parsing plan…");
  const parsed = parseJsonResponse(raw);
  const plan = validatePlanResult(parsed);

  if (!plan) {
    logEvent(cwd, "warn", "Failed to parse plan from secondary model response", { raw: raw.slice(0, 2000) });
    return {
      action: "plan",
      error: "Failed to parse plan from secondary model response.",
      plan: { todo: [task], acceptanceCriteria: [], summary: raw.slice(0, 200) },
      cost: recordCostWithBudget(cwd, usage),
    };
  }

  setPlan(cwd, plan);
  return { action: "plan", plan, cost: recordCostWithBudget(cwd, usage) };
}

async function executeYooReview(
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

  const state = getState(cwd);

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

  progress(3, STAGES.review, "Calculating token budget…");
  const baseBudget = calculateReviewBudget(
    modelConfig.provider,
    modelConfig.id,
    config,
    {
      systemPrompt: "", // used to size pre-review command output truncation below
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
    const results = runPreReviewCommands(cwd, config.preReviewCommands);
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
  const shouldParallelize = Boolean(config.parallelReview) && filesWithDiff.length > 1 && strategy !== "diff-only";
  const maxConcurrency =
    typeof config.parallelReview === "number" && config.parallelReview > 0 ? config.parallelReview : 3;

  let review: ReviewResult;
  let cost: UsageCost | undefined;
  let finalDiffTruncated: boolean;
  let finalDroppedFiles: string[];

  if (shouldParallelize) {
    progress(7, STAGES.review, `Reviewing ${filesWithDiff.length} files in parallel…`);

    const sharedContextEstimate = [sessionContext, conventionsText, preReviewOutput, description].join("\n");
    const outputEstimate =
      modelConfig.thinking && modelConfig.thinking.toLowerCase() !== "off"
        ? (modelConfig.maxOutputTokens ?? 8192)
        : 2048;

    interface FilePrep {
      file: string;
      fileMemoryContext: string;
      fileBudget: ReviewBudget;
      fileResult: ReturnType<typeof loadFileContentsForReview>;
      droppedForBudget: string[];
    }
    const preps: FilePrep[] = [];
    for (const file of filesWithDiff) {
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
      const fileResult = loadFileContentsForReview({
        cwd,
        changedFiles: [file],
        budget: fileBudget,
        strategy,
        fullFileThresholdLines,
      });
      const droppedForBudget = fileResult.dropped.filter((f) => isReviewableFile(f));
      preps.push({ file, fileMemoryContext, fileBudget, fileResult, droppedForBudget });
    }

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
      return { action: "review", error: failures.join("; ") };
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
        : loadFileContentsForReview({
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
    let result: { review: ReviewResult; usage: UsageCost };
    try {
      result = await runReviewBatch({
        cwd,
        description,
        files: fileResult.entries,
        diff: finalDiff,
        vcs,
        criteria: state.plan?.acceptanceCriteria?.join("\n"),
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
      });
    } catch (err) {
      return {
        action: "review",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    review = result.review;
    cost = recordCostWithBudget(cwd, result.usage);
  }

  progress(8, STAGES.review, "Review response received");
  recordIssues(cwd, review.issues);

  if (finalDiffTruncated) review.truncated = true;
  if (finalDroppedFiles.length > 0) review.droppedFiles = finalDroppedFiles;
  if (finalDiffTruncated || finalDroppedFiles.length > 0) {
    review.suggestions.push(
      "The change is large and some context was omitted. If the review missed something, scope it with --files or increase reviewMaxInputTokens.",
    );
  }

  if (review.consensus) {
    markStepComplete(cwd, true);
    const planProgress = getProgress(cwd);
    review.planProgress = `${planProgress.current}/${planProgress.total} steps done`;
    if (planProgress.nextStep) {
      review.nextStep = planProgress.nextStep;
    }

    if (config.autoJudge && planProgress.current === planProgress.total && planProgress.total > 0) {
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
        const mergedCost =
          cost && judgeResult.cost ? mergeUsageCost(cost, judgeResult.cost) : (cost ?? judgeResult.cost);
        return { action: "review", review, judge: judgeResult.judge, cost: mergedCost };
      } else if (judgeResult.error) {
        review.suggestions.push(`Auto-judge failed: ${judgeResult.error}`);
      }
    }
  } else {
    incrementReviewRounds(cwd);
    const updatedState = getState(cwd);
    if (updatedState.reviewRounds >= 3) {
      review.escalated = true;
      review.suggestions.push(
        "This step has failed review 3 times. Consider asking the user for guidance or trying a fundamentally different approach.",
      );
    }
  }

  progress(10, STAGES.review, "Finalizing review…");
  return { action: "review", review, cost };
}

async function executeYooSuggest(
  cwd: string,
  question: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: ExtensionContext["sessionManager"],
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  const modelConfig = resolveTaskModel(config, "suggest");
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "suggest", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }

  progress(1, STAGES.suggest, "Loading project conventions…");
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";

  const { system, user } = buildSuggestPrompt(question, conventionsText);
  progress(2, STAGES.suggest, `Calling ${secondaryModelLabel(modelConfig)}…`);
  const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
    signal,
    thinking: modelConfig.thinking,
    cwd,
    sessionManager,
    task: "suggest",
  });

  progress(3, STAGES.suggest, "Parsing suggestions…");
  const parsed = parseJsonResponse(raw);
  const suggest = validateSuggestResult(parsed);

  if (!suggest) {
    logEvent(cwd, "warn", "Failed to parse suggestions from secondary model response", {
      raw: raw.slice(0, 2000),
      parsed: parsed === null ? null : typeof parsed,
      parseError: getJsonParseError(raw),
      validationErrors: parsed ? getSuggestValidationErrors(parsed) : [],
    });
    return {
      action: "suggest",
      error: "Failed to parse suggestions from secondary model response.",
      cost: recordCostWithBudget(cwd, usage),
    };
  }

  return { action: "suggest", suggest, cost: recordCostWithBudget(cwd, usage) };
}

async function executeYooRecommend(
  cwd: string,
  situation: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: ExtensionContext["sessionManager"],
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  const modelConfig = resolveTaskModel(config, "recommend");
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "recommend", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }

  const state = getState(cwd);

  progress(1, STAGES.recommend, "Loading project conventions…");
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";

  const { system, user } = buildRecommendPrompt(situation, state.plan?.todo, conventionsText);
  progress(2, STAGES.recommend, `Calling ${secondaryModelLabel(modelConfig)}…`);
  const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
    signal,
    thinking: modelConfig.thinking,
    cwd,
    sessionManager,
    task: "recommend",
  });

  progress(3, STAGES.recommend, "Parsing recommendation…");
  const parsed = parseJsonResponse(raw);
  const recommend = validateRecommendResult(parsed);

  if (!recommend) {
    const parseError = getJsonParseError(raw);
    const validationErrors = parsed ? getRecommendValidationErrors(parsed) : [];
    logEvent(cwd, "warn", "Failed to parse recommendation from secondary model response", {
      raw: raw.slice(0, 2000),
      parsed: parsed === null ? null : typeof parsed,
      parseError,
      validationErrors,
    });
    return {
      action: "recommend",
      error: "Failed to parse recommendation from secondary model response.",
      cost: recordCostWithBudget(cwd, usage),
    };
  }

  return { action: "recommend", recommend, cost: recordCostWithBudget(cwd, usage) };
}

async function executeYooJudge(
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

  const state = getState(cwd);
  const reviewHistory = buildReviewHistory(cwd);
  progress(1, STAGES.judge, "Building review history…");

  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";
  const memoryContext = getPastIssuesForFiles(cwd, []);

  const { system, user } = buildJudgePrompt(
    description,
    state.plan?.todo,
    state.plan?.acceptanceCriteria,
    reviewHistory,
    conventionsText,
    undefined,
    memoryContext,
  );

  progress(2, STAGES.judge, `Calling ${secondaryModelLabel(modelConfig)}…`);
  const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
    signal,
    thinking: modelConfig.thinking,
    cwd,
    sessionManager,
    task: "judge",
  });

  progress(3, STAGES.judge, "Parsing judgment…");
  const parsed = parseJsonResponse(raw);
  let judge = validateJudgeResult(parsed);
  let cost = recordCostWithBudget(cwd, usage);

  if (!judge) {
    logEvent(cwd, "warn", "Failed to parse judgment from secondary model response, retrying with reasoning off", {
      raw: raw.slice(0, 2000),
      parsed: parsed === null ? null : typeof parsed,
      parseError: getJsonParseError(raw),
      validationErrors: parsed ? getJudgeValidationErrors(parsed) : [],
    });
    progress(3, STAGES.judge, "Parsing failed, retrying with reasoning off…");
    const { content: rawRetry, usage: usageRetry } = await callSecondaryModel(
      modelConfig.provider,
      modelConfig.id,
      system,
      `${user}\n\nCRITICAL: Your previous response could not be parsed. Return ONLY valid JSON matching the required structure, with no markdown fences, no explanations, and no extra text.`,
      { signal, thinking: "off", cwd, sessionManager, task: "judge" },
    );
    const parsedRetry = parseJsonResponse(rawRetry);
    const judgeRetry = validateJudgeResult(parsedRetry);
    if (judgeRetry) {
      judge = judgeRetry;
      cost = mergeUsageCost(cost, recordCostWithBudget(cwd, usageRetry));
    } else {
      logEvent(cwd, "warn", "Failed to parse judgment from secondary model response after retry", {
        raw: rawRetry.slice(0, 2000),
        parsed: parsedRetry === null ? null : typeof parsedRetry,
        parseError: getJsonParseError(rawRetry),
        validationErrors: parsedRetry ? getJudgeValidationErrors(parsedRetry) : [],
      });
      return {
        action: "judge",
        error: "Failed to parse judgment from secondary model response.",
        cost,
      };
    }
  }

  return { action: "judge", judge, cost };
}

async function executeYooScan(
  cwd: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: ExtensionContext["sessionManager"],
  deepOverride?: boolean | number,
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  const modelConfig = resolveTaskModel(config, "scan");
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "scan", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }

  progress(1, STAGES.scan, "Scanning local project conventions…");
  const localScan = scanProjectConventions(cwd);

  const { system, user } = buildScanPrompt();
  const configFilesText = formatConfigFiles(cwd);

  const deepScanEnabled = deepOverride ?? config.deepScan;
  const deepScanSamples = deepScanEnabled
    ? gatherDeepScanSamples(cwd, localScan.files, typeof deepScanEnabled === "number" ? deepScanEnabled : 5)
    : [];

  // Cap the scan prompt to the model's context window minus output headroom.
  const modelInfo = resolveModelInfo(modelConfig.provider, modelConfig.id, {
    contextWindow: modelConfig.contextWindow,
    maxOutputTokens: modelConfig.maxOutputTokens,
  });
  const reservedOutputTokens =
    modelConfig.thinking && modelConfig.thinking.toLowerCase() !== "off"
      ? Math.min(modelInfo.maxOutputTokens, 8192)
      : Math.min(modelInfo.maxOutputTokens, 2048);
  const safetyMarginTokens = Math.ceil(modelInfo.contextWindow * 0.1);
  const maxPromptTokens = modelInfo.contextWindow - reservedOutputTokens - safetyMarginTokens;

  let filesForPrompt = filterSourceFiles(localScan.files).slice(0, 200);
  let trimmedSamples = deepScanSamples;
  function buildScanUserPrompt(samples: typeof deepScanSamples): string {
    const samplesText =
      samples.length > 0
        ? `\n\n<code_samples>\n${samples.map((s) => `--- ${s.file} ---\n${s.content}`).join("\n\n")}\n</code_samples>`
        : "";
    return `${user}\n\nFiles:\n${filesForPrompt.join("\n")}${configFilesText}${samplesText}`;
  }
  while (true) {
    const promptText = buildScanUserPrompt(trimmedSamples);
    const totalTokens = estimateTokens(system) + estimateTokens(promptText);
    if (totalTokens <= maxPromptTokens || (filesForPrompt.length <= 50 && trimmedSamples.length === 0)) break;
    if (trimmedSamples.length > 0) {
      trimmedSamples = trimmedSamples.slice(0, Math.max(0, trimmedSamples.length - 1));
    } else if (filesForPrompt.length > 50) {
      filesForPrompt = filesForPrompt.slice(0, Math.max(50, Math.floor(filesForPrompt.length * 0.8)));
    } else {
      break;
    }
  }
  const deepScanText =
    trimmedSamples.length > 0
      ? `\n\n<code_samples>\n${trimmedSamples.map((s) => `--- ${s.file} ---\n${s.content}`).join("\n\n")}\n</code_samples>`
      : "";

  progress(2, STAGES.scan, `Calling ${secondaryModelLabel(modelConfig)}…`);
  const { content: raw, usage } = await callSecondaryModel(
    modelConfig.provider,
    modelConfig.id,
    system,
    `${user}\n\nFiles:\n${filesForPrompt.join("\n")}${configFilesText}${deepScanText}`,
    { signal, thinking: modelConfig.thinking, cwd, sessionManager, task: "scan" },
  );

  progress(3, STAGES.scan, "Merging conventions…");
  const parsed = parseJsonResponse(raw);
  const llmConventions = validateConventionsResult(parsed);
  if (!llmConventions && raw.trim().length > 0) {
    logEvent(cwd, "warn", "Failed to parse scan conventions from secondary model response", {
      raw: raw.slice(0, 2000),
    });
  }
  const conventions = llmConventions ? mergeConventions(localScan.conventions, llmConventions) : localScan.conventions;
  progress(4, STAGES.scan, "Saving conventions…");
  saveConventions(cwd, conventions);

  logEvent(cwd, "info", "Scan completed", {
    deepScan: Boolean(deepScanEnabled),
    sampleCount: trimmedSamples.length,
    filesForPrompt: filesForPrompt.length,
    provider: modelConfig.provider,
    model: modelConfig.id,
    estimatedCostUsd: usage.estimatedCostUsd,
  });

  return { action: "scan", scan: { conventions, files: localScan.files }, cost: recordCostWithBudget(cwd, usage) };
}

function recordCostWithBudget(cwd: string, usage: UsageCost): UsageCost {
  const config = loadHeyyooConfig(cwd);
  return recordCost(cwd, usage, config.costBudgetUsd);
}

function mergeUsageCost(a: UsageCost, b: UsageCost): UsageCost {
  return {
    estimatedInputTokens: a.estimatedInputTokens + b.estimatedInputTokens,
    estimatedOutputTokens: a.estimatedOutputTokens + b.estimatedOutputTokens,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
    // Both sessionCostUsd values are cumulative totals; keep the latest.
    sessionCostUsd: Math.max(a.sessionCostUsd, b.sessionCostUsd),
  };
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function capReviewThinking(configured?: string): string {
  // Review output is structured JSON. High/xhigh reasoning often consumes the output budget
  // and leaves no room for the actual verdict, causing truncation and false positives.
  if (!configured) return "medium";
  if (configured.toLowerCase() === "off") return "off";
  const lowered = configured.toLowerCase();
  if (lowered === "high" || lowered === "xhigh") return "medium";
  return configured;
}

type ConcurrencyOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  signal?: AbortSignal,
): Promise<ConcurrencyOutcome<T>[]> {
  const results: ConcurrencyOutcome<T>[] = new Array(tasks.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < tasks.length) {
      if (signal?.aborted) return;
      const i = nextIndex++;
      try {
        results[i] = { ok: true, value: await tasks[i]() };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function mergeReviewResults(results: ReviewResult[]): ReviewResult {
  let verdict: ReviewVerdict = "pass";
  for (const r of results) {
    if (r.verdict === "blocked") {
      verdict = "blocked";
      break;
    }
    if (r.verdict === "needs-work") {
      verdict = "needs-work";
    }
  }
  const issues = results.flatMap((r) => r.issues);
  const suggestions = Array.from(new Set(results.flatMap((r) => r.suggestions)));
  const droppedFiles = Array.from(new Set(results.flatMap((r) => r.droppedFiles ?? [])));
  const truncated = results.some((r) => r.truncated);
  return {
    verdict,
    issues,
    suggestions,
    consensus: verdict === "pass" && issues.length === 0,
    truncated,
    droppedFiles,
  };
}

interface ReviewBatchInput {
  cwd: string;
  description: string;
  files: FileContentEntry[];
  diff: string;
  vcs?: string;
  criteria?: string;
  sessionContext: string;
  conventionsText: string;
  preReviewOutput: string;
  memoryContext: string;
  truncated: boolean;
  droppedFiles: string[];
  budget: ReviewBudget;
  modelConfig: SecondaryModelConfig;
  signal?: AbortSignal;
  sessionManager?: ExtensionContext["sessionManager"];
  relevantPaths: string[];
}

async function runReviewBatch(input: ReviewBatchInput): Promise<{ review: ReviewResult; usage: UsageCost }> {
  const {
    cwd,
    description,
    files,
    diff,
    vcs,
    criteria,
    sessionContext,
    conventionsText,
    preReviewOutput,
    memoryContext,
    truncated,
    droppedFiles,
    budget,
    modelConfig,
    signal,
    sessionManager,
    relevantPaths,
  } = input;

  const systemPromptEstimate = 1000;
  const remainingForDiff = Math.max(
    0,
    budget.availableInputTokens - files.reduce((sum, f) => sum + f.tokenEstimate, 0) - systemPromptEstimate,
  );
  const diffTokens = estimateTokens(diff);
  const finalDiff = diffTokens > remainingForDiff ? diff.slice(0, remainingForDiff * 4) + "\n... diff truncated" : diff;
  const diffTruncated = truncated || finalDiff !== diff;

  const { system, user } = buildAdaptiveReviewPrompt(
    description,
    finalDiff,
    files.map((f) => ({ file: f.file, content: f.content, mode: f.mode })),
    {
      vcs,
      criteria,
      sessionContext,
      conventionsText,
      preReviewOutput,
      memoryContext,
      truncated: diffTruncated,
      droppedFiles,
      budgetNote: `Context window: ${budget.contextWindow.toLocaleString()} tokens. Reserved output: ${budget.reservedOutputTokens.toLocaleString()}. Available for context: ${budget.availableInputTokens.toLocaleString()}.`,
    },
  );

  const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
    signal,
    thinking: capReviewThinking(modelConfig.thinking),
    cwd,
    sessionManager,
    relevantPaths,
    task: "review",
  });

  const parsed = parseJsonResponse(raw);
  let review = validateReviewResult(parsed);
  let usageOut = usage;

  if (!review) {
    logEvent(cwd, "warn", "Failed to parse review from secondary model response, retrying with reasoning off", {
      raw: raw.slice(0, 2000),
      parsed: parsed === null ? null : typeof parsed,
      parseError: getJsonParseError(raw),
      validationErrors: parsed ? getReviewValidationErrors(parsed) : [],
    });
    const { content: rawRetry, usage: usageRetry } = await callSecondaryModel(
      modelConfig.provider,
      modelConfig.id,
      system,
      `${user}\n\nCRITICAL: Your previous response could not be parsed. Return ONLY valid JSON matching the required structure, with no markdown fences, no explanations, and no extra text.`,
      { signal, thinking: "off", cwd, sessionManager, relevantPaths, task: "review" },
    );
    const parsedRetry = parseJsonResponse(rawRetry);
    const reviewRetry = validateReviewResult(parsedRetry);
    if (reviewRetry) {
      review = reviewRetry;
      usageOut = mergeUsageCost(usageOut, usageRetry);
    } else {
      logEvent(cwd, "warn", "Failed to parse review from secondary model response after retry", {
        raw: rawRetry.slice(0, 2000),
        parsed: parsedRetry === null ? null : typeof parsedRetry,
        parseError: getJsonParseError(rawRetry),
        validationErrors: parsedRetry ? getReviewValidationErrors(parsedRetry) : [],
      });
      throw new Error("Failed to parse review from secondary model response.");
    }
  }

  return { review, usage: usageOut };
}

interface ValidatedParams {
  ok: true;
  params: YooToolParams;
  action: YooAction;
}

interface InvalidParams {
  ok: false;
  error: string;
}

type ValidationResult = ValidatedParams | InvalidParams;

const YOO_ACTIONS: YooAction[] = ["plan", "review", "suggest", "recommend", "judge", "scan"];

function validateYooToolParams(params: unknown): ValidationResult {
  if (!params || typeof params !== "object") {
    return { ok: false, error: "Invalid parameters: expected an object." };
  }
  const p = params as Record<string, unknown>;

  const active = YOO_ACTIONS.filter((a) => {
    const value = p[a];
    if (a === "scan") return value === true;
    return typeof value === "string" && value.length > 0;
  });

  if (active.length === 0) {
    return {
      ok: false,
      error: "No action specified. Provide one of: plan, review, suggest, recommend, judge, or scan.",
    };
  }
  if (active.length > 1) {
    return { ok: false, error: `Only one action per call is allowed. Received: ${active.join(", ")}.` };
  }

  const action = active[0];

  const stringArray = (value: unknown): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return undefined;
    const filtered = value.filter((v): v is string => typeof v === "string" && v.length > 0);
    return filtered.length > 0 ? filtered : undefined;
  };

  const result: YooToolParams = {
    plan: action === "plan" ? (p.plan as string) : undefined,
    review: action === "review" ? (p.review as string) : undefined,
    suggest: action === "suggest" ? (p.suggest as string) : undefined,
    recommend: action === "recommend" ? (p.recommend as string) : undefined,
    judge: action === "judge" ? (p.judge as string) : undefined,
    scan: action === "scan" ? true : undefined,
    files: stringArray(p.files),
    exclude: stringArray(p.exclude),
    revision: typeof p.revision === "string" ? p.revision : undefined,
    since: typeof p.since === "string" ? p.since : undefined,
    vcs: p.vcs === "git" || p.vcs === "svn" ? p.vcs : undefined,
    untracked: p.untracked === true ? true : undefined,
    verify: p.verify === true ? true : undefined,
  };

  return { ok: true, params: result, action } as ValidatedParams;
}

function parseReviewCommandArgs(input: string): {
  description: string;
  options: {
    revision?: string;
    since?: string;
    files?: string[];
    exclude?: string[];
    vcs?: "git" | "svn";
    untracked?: boolean;
  };
} {
  const options: {
    revision?: string;
    since?: string;
    files?: string[];
    exclude?: string[];
    vcs?: "git" | "svn";
    untracked?: boolean;
  } = {};
  const tokens = input.match(/(?:[^\s"']+|["'][^"']*["'])+/g) ?? [];
  const args = tokens.map((t) => t.replace(/^["']|["']$/g, ""));
  const descriptionParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--revision":
      case "-r":
        if (next) {
          options.revision = next;
          i++;
        }
        break;
      case "--since":
      case "-s":
        if (next) {
          options.since = next;
          i++;
        }
        break;
      case "--files":
      case "-f":
        if (next) {
          options.files = next
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean);
          i++;
        }
        break;
      case "--exclude":
      case "-x":
        if (next) {
          options.exclude = next
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean);
          i++;
        }
        break;
      case "--vcs":
        if (next === "git" || next === "svn") {
          options.vcs = next;
          i++;
        }
        break;
      case "--untracked":
        options.untracked = true;
        break;
      default:
        descriptionParts.push(arg);
    }
  }

  return { description: descriptionParts.join(" ") || "review changes", options };
}

export default function (pi: ExtensionAPI) {
  const loopStates = new Map<string, LoopDetectionState>();
  function getLoopState(cwd: string): LoopDetectionState {
    let state = loopStates.get(cwd);
    if (!state) {
      state = createLoopDetectionState();
      loopStates.set(cwd, state);
    }
    return state;
  }

  pi.on("session_start", async (_event, ctx) => {
    const diskState = loadState(ctx.cwd);
    if (diskState) {
      sessionStates.set(ctx.cwd, diskState);
    }
    // cost.json tracks estimated spend for the current Pi session.
    resetCost(ctx.cwd);
    // Make OpenCode session-aware so it can use sticky provider routing.
    try {
      setPiSessionId(ctx.cwd, ctx.sessionManager.getSessionId());
    } catch {
      /* ignore if sessionManager is unavailable */
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionStates.delete(ctx.cwd);
    loopStates.delete(ctx.cwd);
    clearPiSessionId(ctx.cwd);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    try {
      const state = getLoopState(ctx.cwd);
      recordToolCall(state, event);
      const loop = checkLoop(state);
      if (loop && shouldSendSteer(state, loop)) {
        pi.sendUserMessage(loop.message, { deliverAs: "steer" });
      }
    } catch {
      // best-effort loop detection
    }
  });

  pi.registerTool({
    name: "yoo",
    label: "Yoo — Pair Programmer",
    description:
      "Mandatory second-opinion workflow powered by a secondary model. Always use yoo.plan before implementing, yoo.review after every change, yoo.scan when opening a new project, yoo.suggest for non-trivial architectural or design questions, yoo.recommend when deciding next steps, and yoo.judge before declaring work complete.",
    promptSnippet:
      "yoo: always get a second opinion from the secondary model before acting on code or making architectural decisions",
    promptGuidelines: [
      "Always use yoo with plan:true before starting any non-trivial implementation. The secondary model creates a structured todo list with acceptance criteria; do not write code without a plan.",
      "Always use yoo with review:true after every code change. Treat review feedback as blocking; fix issues and re-run review until it returns 'pass'.",
      "Use yoo with review:true and files:[...] to limit the review to specific files, or exclude:[...] to skip files like generated output.",
      "Use yoo with scan:true immediately when opening a project for the first time. Stored conventions improve all future reviews and plans.",
      "Use yoo with suggest:true whenever you are uncertain about the best approach for a specific technical question. If you are stuck, looping, or about to ask the user for help, call yoo.suggest first.",
      "When the user asks a non-trivial architectural or design question where multiple valid approaches exist, call yoo.suggest before answering. For simple factual questions you can verify yourself (reading files, running commands), answer directly without yoo.",
      "Use yoo with recommend:true whenever you need to decide what step to take next. If you have spent more than one turn without clear progress, call yoo.recommend.",
      "Use yoo with judge:true after completing all work for a final holistic review against the original plan.",
      "Enable autoJudge in settings.json to automatically run judge when the last plan step passes review.",
      "Configure preReviewCommands in settings.json to run lint/test/typecheck before each review and include output in the prompt.",
      "Use `verify: true` when a yoo finding is surprising, high-stakes, or unclear. The main agent must then confirm or refute the finding with evidence before acting.",
      "The secondary model should be a DIFFERENT model family than the main model to catch blind spots. Configure in settings.json under pi-heyyoo.secondary.",
      "Only one action (plan/review/suggest/recommend/judge/scan) per call. Do not combine them.",
      "When stuck, confused, or looping, stop and use a yoo tool. Do not spin in place or guess.",
    ],
    parameters: Type.Object({
      plan: Type.Optional(
        Type.String({
          description: "Provide a task description to get a structured todo plan with acceptance criteria.",
        }),
      ),
      review: Type.Optional(
        Type.String({
          description:
            "Provide a description of what you just implemented. The secondary model examines the diff and returns a verdict with issues.",
        }),
      ),
      suggest: Type.Optional(
        Type.String({
          description:
            "Ask a specific technical or architectural question to get alternative approaches and evidence from the secondary model.",
        }),
      ),
      recommend: Type.Optional(
        Type.String({
          description: "Describe your current situation to get a recommended next step from the secondary model.",
        }),
      ),
      judge: Type.Optional(
        Type.String({
          description:
            "Provide a description of all completed work for a final holistic review against the original plan.",
        }),
      ),
      scan: Type.Optional(
        Type.Boolean({
          description:
            "If true, scan project conventions and architecture patterns. Stores results for future reviews.",
        }),
      ),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description: "For review: limit diff to these file paths.",
        }),
      ),
      exclude: Type.Optional(
        Type.Array(Type.String(), {
          description: "For review: exclude these file paths from diff.",
        }),
      ),
      revision: Type.Optional(
        Type.String({
          description: "For review: compare against this revision (e.g. 'HEAD~1', '1234', '1234:HEAD').",
        }),
      ),
      since: Type.Optional(
        Type.String({
          description: "For review: include changes since this revision or commit ID.",
        }),
      ),
      vcs: Type.Optional(
        Type.Union([Type.Literal("git"), Type.Literal("svn")], {
          description: "Version control system to use for diff. Auto-detected if omitted.",
        }),
      ),
      untracked: Type.Optional(
        Type.Boolean({
          description: "For review: include untracked (new) files in the diff.",
        }),
      ),
      verify: Type.Optional(
        Type.Boolean({
          description:
            "If true, the result asks the main agent to confirm or refute the finding with evidence before acting.",
        }),
      ),
    }),
    renderCall,
    renderResult,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const validation = validateYooToolParams(params);
      if (!validation.ok) {
        return {
          content: [{ type: "text", text: `yoo: ${validation.error}` }],
          isError: true,
        };
      }
      const p = validation.params;
      const action = validation.action;
      const config = loadHeyyooConfig(ctx.cwd);

      const progress = createProgressReporter(action, ctx, onUpdate);
      let result: YooToolResult;

      try {
        if (p.plan) {
          result = await executeYooPlan(ctx.cwd, p.plan, signal, progress, ctx.sessionManager);
        } else if (p.review) {
          result = await executeYooReview(
            ctx.cwd,
            p.review,
            ctx,
            {
              files: p.files,
              exclude: p.exclude,
              revision: p.revision,
              since: p.since,
              vcs: p.vcs,
              untracked: p.untracked,
            },
            signal,
            progress,
          );
        } else if (p.suggest) {
          result = await executeYooSuggest(ctx.cwd, p.suggest, signal, progress, ctx.sessionManager);
        } else if (p.recommend) {
          result = await executeYooRecommend(ctx.cwd, p.recommend, signal, progress, ctx.sessionManager);
        } else if (p.judge) {
          result = await executeYooJudge(ctx.cwd, p.judge, signal, progress, ctx.sessionManager);
        } else {
          result = await executeYooScan(ctx.cwd, signal, progress, ctx.sessionManager);
        }
      } catch (err) {
        logEvent(ctx.cwd, "error", `yoo tool ${action} failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
        result = { action, error: err instanceof Error ? err.message : String(err) };
      } finally {
        clearYooStatus(ctx);
      }

      const shouldVerify = p.verify ?? config.verifyByDefault ?? false;
      if (shouldVerify && !result.error) {
        result.verificationRequested = true;
      }

      const text = formatResultText(result);

      return {
        content: [{ type: "text", text }],
        details: result,
        isError: Boolean(result.error),
      };
    },
  });

  pi.registerCommand("yoo", {
    description:
      "Run a yoo action or show status. Usage: /yoo [plan|review|suggest|recommend|judge|scan|status] [args]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        await showYooStatus(ctx);
        return;
      }

      const [subcommand, ...rest] = trimmed.split(/\s+/);
      const restText = rest.join(" ").trim();
      const signal = undefined;

      const actionMap: Record<string, YooAction | "status"> = {
        plan: "plan",
        review: "review",
        suggest: "suggest",
        recommend: "recommend",
        judge: "judge",
        scan: "scan",
        status: "status",
      };
      const known = actionMap[subcommand.toLowerCase()];
      if (!known) {
        ctx.ui.notify(`Unknown /yoo subcommand: ${subcommand}. Try /yoo status`, "warn");
        return;
      }

      const action: YooAction = known === "status" ? "scan" : known;

      const progress = createProgressReporter(action, ctx);
      const notifyProgress: ProgressReporter = (stage, total, message) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };

      let result: YooToolResult;
      try {
        switch (known) {
          case "status":
            await showYooStatus(ctx);
            return;
          case "plan":
            if (!restText) {
              ctx.ui.notify("Usage: /yoo plan <task description>", "warn");
              return;
            }
            result = await executeYooPlan(ctx.cwd, restText, signal, notifyProgress, ctx.sessionManager);
            break;
          case "review": {
            const { description, options: reviewOptions } = parseReviewCommandArgs(restText);
            result = await executeYooReview(ctx.cwd, description, ctx, reviewOptions, signal, notifyProgress);
            break;
          }
          case "suggest":
            if (!restText) {
              ctx.ui.notify("Usage: /yoo suggest <question>", "warn");
              return;
            }
            result = await executeYooSuggest(ctx.cwd, restText, signal, notifyProgress, ctx.sessionManager);
            break;
          case "recommend":
            result = await executeYooRecommend(
              ctx.cwd,
              restText || "what next",
              signal,
              notifyProgress,
              ctx.sessionManager,
            );
            break;
          case "judge":
            result = await executeYooJudge(ctx.cwd, restText || "all done", signal, notifyProgress, ctx.sessionManager);
            break;
          case "scan":
            result = await executeYooScan(ctx.cwd, signal, notifyProgress, ctx.sessionManager);
            break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent(ctx.cwd, "error", `yoo ${subcommand} command failed`, { error: message });
        ctx.ui.notify(`yoo error: ${message}`, "error");
        return;
      } finally {
        clearYooStatus(ctx);
      }

      const text = formatResultText(result);
      ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
    },
  });

  pi.registerCommand("yoo-config", {
    description:
      "View or edit pi-heyyoo settings. Usage: /yoo-config [get|set|list] [key] [value], or /yoo-config <provider.model>",
    handler: async (args, ctx) => {
      const agentDir = getAgentDir();
      const settingsPath = join(agentDir, "settings.json");
      const trimmed = args.trim();

      function readSettings(): Record<string, unknown> {
        if (!existsSync(settingsPath)) return {};
        try {
          return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
        } catch (err) {
          logEvent(ctx.cwd, "error", "Failed to read settings for /yoo-config", {
            error: err instanceof Error ? err.message : String(err),
            path: settingsPath,
          });
          throw new Error("Failed to read settings.json.", { cause: err });
        }
      }

      function writeSettings(settings: Record<string, unknown>): void {
        if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      }

      function getYooSettings(settings: Record<string, unknown>): Record<string, unknown> {
        const yoo = settings["pi-heyyoo"];
        return yoo && typeof yoo === "object" && !Array.isArray(yoo) ? (yoo as Record<string, unknown>) : {};
      }

      function setValueByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
        const parts = path.split(".");
        let current: Record<string, unknown> = obj;
        for (let i = 0; i < parts.length - 1; i++) {
          const key = parts[i];
          const next = current[key];
          if (!next || typeof next !== "object" || Array.isArray(next)) {
            current[key] = {};
          }
          current = current[key] as Record<string, unknown>;
        }
        current[parts[parts.length - 1]] = value;
      }

      function getValueByPath(obj: Record<string, unknown>, path: string): unknown {
        const parts = path.split(".");
        let current: unknown = obj;
        for (const part of parts) {
          if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
          current = (current as Record<string, unknown>)[part];
        }
        return current;
      }

      function parseConfigValue(raw: string): unknown {
        const stripped = raw.trim();
        if (/^".*"$/.test(stripped)) return stripped.slice(1, -1);
        if (/^'.*'$/.test(stripped)) return stripped.slice(1, -1);
        if (stripped.toLowerCase() === "true" || stripped.toLowerCase() === "yes") return true;
        if (stripped.toLowerCase() === "false" || stripped.toLowerCase() === "no") return false;
        if (stripped === "null") return null;
        if (stripped === "undefined") return undefined;
        const num = Number(stripped);
        if (stripped !== "" && !Number.isNaN(num) && Number.isFinite(num)) return num;
        try {
          return JSON.parse(stripped);
        } catch {
          return stripped;
        }
      }

      function tokenize(input: string): string[] {
        const tokens: string[] = [];
        const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(input)) !== null) {
          tokens.push(match[1] ?? match[2] ?? match[0]);
        }
        return tokens;
      }

      // Legacy shorthand: /yoo-config provider.model
      if (trimmed && !trimmed.includes(" ") && trimmed.includes(".")) {
        const [provider, ...modelParts] = trimmed.split(".");
        const modelId = modelParts.join(".");
        if (provider && modelId) {
          try {
            const settings = readSettings();
            settings["pi-heyyoo"] = settings["pi-heyyoo"] || {};
            const yoo = getYooSettings(settings);
            yoo.secondary = (yoo.secondary as Record<string, unknown>) || {};
            (yoo.secondary as Record<string, unknown>).provider = provider;
            (yoo.secondary as Record<string, unknown>).id = modelId;
            settings["pi-heyyoo"] = yoo;
            writeSettings(settings);
            ctx.ui.notify(`Set yoo secondary model to ${provider}.${modelId} in ${settingsPath}`, "info");
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Failed to update settings: ${message}`, "error");
          }
          return;
        }
      }

      const tokens = tokenize(trimmed);
      const subcommand = tokens[0]?.toLowerCase() ?? "";

      try {
        if (!trimmed || subcommand === "list") {
          const settings = readSettings();
          const yoo = getYooSettings(settings);
          const lines = [
            `Settings file: ${settingsPath}`,
            "",
            JSON.stringify(yoo, null, 2) || "(no pi-heyyoo settings configured)",
          ];
          await ctx.ui.select("pi-heyyoo settings", lines);
          return;
        }

        if (subcommand === "get") {
          const key = tokens[1];
          if (!key) {
            ctx.ui.notify("Usage: /yoo-config get <key> (e.g. /yoo-config get secondary.thinking)", "warn");
            return;
          }
          const settings = readSettings();
          const yoo = getYooSettings(settings);
          const value = getValueByPath(yoo, key);
          const display = value === undefined ? "(not set)" : JSON.stringify(value, null, 2);
          ctx.ui.notify(`${key} = ${display}`, "info");
          return;
        }

        if (subcommand === "set") {
          const key = tokens[1];
          const valueText = tokens.slice(2).join(" ");
          if (!key || valueText.length === 0) {
            ctx.ui.notify(
              "Usage: /yoo-config set <key> <value> (e.g. /yoo-config set secondary.thinking medium)",
              "warn",
            );
            return;
          }
          const value = parseConfigValue(valueText);
          const settings = readSettings();
          settings["pi-heyyoo"] = settings["pi-heyyoo"] || {};
          const yoo = getYooSettings(settings);
          setValueByPath(yoo, key, value);
          settings["pi-heyyoo"] = yoo;
          writeSettings(settings);
          ctx.ui.notify(`Set ${key} = ${JSON.stringify(value)} in ${settingsPath}`, "info");
          return;
        }

        ctx.ui.notify(
          "Unknown /yoo-config subcommand. Usage: /yoo-config [get|set|list] [key] [value], or /yoo-config <provider.model>",
          "warn",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to update settings: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("yoo-model", {
    description:
      "Interactively pick the secondary model for yoo, optionally per tool. Usage: /yoo-model [provider] [filter]",
    handler: async (_args, ctx) => {
      try {
        const registry = ctx.modelRegistry as unknown as {
          getAvailable(): Array<{ id: string; provider: string }>;
          getAll?(): Array<{ id: string; provider: string }>;
          getProviderAuthStatus(provider: string): { configured: boolean };
          hasConfiguredAuth(model: { provider: string }): boolean;
        };

        if (!registry || typeof registry.getAvailable !== "function") {
          ctx.ui.notify("Model registry is not available in this environment.", "error");
          return;
        }

        const allModels = typeof registry.getAll === "function" ? registry.getAll() : registry.getAvailable();
        if (!Array.isArray(allModels) || allModels.length === 0) {
          ctx.ui.notify("No models found. Run /login first.", "error");
          return;
        }

        const configuredModels = allModels.filter((m) => {
          try {
            return registry.getProviderAuthStatus(m.provider).configured;
          } catch {
            return registry.hasConfiguredAuth(m);
          }
        });

        if (configuredModels.length === 0) {
          ctx.ui.notify("No configured models found. Run /login first.", "error");
          return;
        }

        const trimmed = _args.trim();
        const tokens: string[] = [];
        const tokenRegex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
        let tokenMatch: RegExpExecArray | null;
        while ((tokenMatch = tokenRegex.exec(trimmed)) !== null) {
          tokens.push(tokenMatch[1] ?? tokenMatch[2] ?? tokenMatch[0]);
        }
        const requestedProvider = tokens[0]?.toLowerCase();
        const filterQuery = tokens[1]?.toLowerCase();

        const currentConfig = loadHeyyooConfig(ctx.cwd);

        // 1. Pick which yoo tool this model is for.
        const scopeOptions = ["Base secondary model", ...YOO_ACTIONS.map((a) => `Use for ${a} only`)];
        const currentScope = (() => {
          if (currentConfig.secondary.provider && currentConfig.secondary.id) return "Base secondary model";
          const action = YOO_ACTIONS.find((a) => {
            const override = currentConfig.taskModels?.[a];
            return override?.provider && override?.id;
          });
          return action ? `Use for ${action} only` : undefined;
        })();
        const scopeModelText = (scope: string): string => {
          const isBase = scope === "Base secondary model";
          const action = isBase ? undefined : (scope.replace(/^Use for /, "").replace(/ only$/, "") as YooAction);
          const model = isBase ? currentConfig.secondary : resolveTaskModel(currentConfig, action!);
          if (!model.provider || !model.id) return "not configured";
          return `${model.provider}:${model.id}${model.thinking ? ` · ${model.thinking}` : ""}`;
        };
        const scopeItems = scopeOptions.map(
          (s) => `${s} — ${scopeModelText(s)}${s === currentScope ? " ✓ current" : ""}`,
        );
        const scopePicked = await ctx.ui.select("Which yoo tool should use this model?", scopeItems);
        if (!scopePicked) return;
        const scope = scopePicked.replace(/ ✓ current$/, "").split(" — ")[0];
        const action =
          scope === "Base secondary model"
            ? undefined
            : (scope.replace(/^Use for /, "").replace(/ only$/, "") as YooAction);

        const target = action ? currentConfig.taskModels?.[action] : currentConfig.secondary;
        const effectiveProvider = target?.provider || currentConfig.secondary.provider;
        const effectiveId = target?.id || currentConfig.secondary.id;
        const effectiveThinking = target?.thinking ?? currentConfig.secondary.thinking ?? "xhigh";

        // 2. Pick provider.
        const providers = [...new Set(configuredModels.map((m) => m.provider))].sort();
        let provider: string;
        if (requestedProvider) {
          const matched = providers.find((p) => p.toLowerCase() === requestedProvider);
          if (!matched) {
            ctx.ui.notify(`No configured provider matching "${tokens[0]}".`, "warn");
            return;
          }
          provider = matched;
        } else if (providers.length === 1) {
          provider = providers[0];
        } else {
          const providerItems = providers.map((p) => {
            const count = configuredModels.filter((m) => m.provider === p).length;
            const marker = p.toLowerCase() === effectiveProvider.toLowerCase() ? " ✓ current" : "";
            return `${p} (${count} models)${marker}`;
          });
          const picked = await ctx.ui.select("Pick provider:", providerItems);
          if (!picked) return;
          provider = picked.replace(/ ✓ current$/, "").split(" ")[0];
        }

        // 3. Pick model.
        let providerModels = configuredModels
          .filter((m) => m.provider === provider)
          .sort((a, b) => a.id.localeCompare(b.id));
        if (filterQuery) {
          providerModels = providerModels.filter((m) => m.id.toLowerCase().includes(filterQuery));
          if (providerModels.length === 0) {
            ctx.ui.notify(`No ${provider} models match "${tokens[1]}".`, "warn");
            return;
          }
        }
        const modelItems = providerModels.map((m) => {
          const marker =
            provider.toLowerCase() === effectiveProvider.toLowerCase() && m.id === effectiveId ? " ✓ current" : "";
          return `${m.id}${marker}`;
        });

        const modelIdPicked = await ctx.ui.select(`Pick model for ${provider}:`, modelItems);
        if (!modelIdPicked) return;
        const modelId = modelIdPicked.replace(/ ✓ current$/, "");

        // 4. Pick thinking level.
        const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
        const thinkingItems = thinkingLevels.map((t) => `${t}${t === effectiveThinking ? " ✓ current" : ""}`);
        const thinkingPicked = await ctx.ui.select("Pick thinking level:", thinkingItems);
        if (!thinkingPicked) return;
        const thinking = thinkingPicked.replace(" ✓ current", "");

        // 5. Save.
        const agentDir = getAgentDir();
        const settingsPath = join(agentDir, "settings.json");
        if (!existsSync(agentDir)) {
          mkdirSync(agentDir, { recursive: true });
        }
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
        if (!settings["pi-heyyoo"]) settings["pi-heyyoo"] = {};
        const yooSettings = settings["pi-heyyoo"] as Record<string, unknown>;

        if (scope === "Base secondary model") {
          yooSettings.secondary = { provider, id: modelId, thinking };
          ctx.ui.notify(`Secondary model set to ${provider}:${modelId} (${thinking}).`, "info");
        } else {
          const taskModels = (yooSettings.taskModels as Record<string, unknown>) || {};
          const taskAction = action as YooAction;
          taskModels[taskAction] = { provider, id: modelId, thinking };
          yooSettings.taskModels = taskModels;
          ctx.ui.notify(`Task model for ${taskAction} set to ${provider}:${modelId} (${thinking}).`, "info");
        }

        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      } catch (err) {
        ctx.ui.notify(`yoo-model failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("yoo-status", {
    description: "Show detailed yoo status (config, plan, VCS, conventions, memory)",
    handler: async (_args, ctx) => {
      await showYooStatus(ctx);
    },
  });

  pi.registerCommand("yoo-info", {
    description: "Alias for /yoo-status",
    handler: async (_args, ctx) => {
      await showYooStatus(ctx);
    },
  });

  pi.registerCommand("yoo-clear", {
    description: "Clear the active yoo plan, state, cost, memory, conventions, loop history, and inherited session",
    handler: async (_args, ctx) => {
      sessionStates.delete(ctx.cwd);
      loopStates.delete(ctx.cwd);
      clearPiSessionId(ctx.cwd);
      clearState(ctx.cwd);
      resetCost(ctx.cwd);
      clearMemory(ctx.cwd);
      clearConventions(ctx.cwd);
      clearPromptCache();
      ctx.ui.notify("yoo plan, state, cost, memory, conventions, loop history, and inherited session cleared.", "info");
    },
  });

  pi.registerCommand("yoo-next", {
    description: "Recommend the next step based on the active yoo plan",
    handler: async (_args, ctx) => {
      const signal = undefined;
      const planProgress = getProgress(ctx.cwd);
      const situation =
        planProgress.total > 0
          ? `Plan progress: ${planProgress.current}/${planProgress.total} steps completed. Current step: ${planProgress.nextStep ?? "none"}`
          : "No active plan. Recommend a next step for this project.";
      const progress = createProgressReporter("recommend", ctx);
      const notifyProgress: ProgressReporter = (stage, total, message) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };
      const result = await executeYooRecommend(ctx.cwd, situation, signal, notifyProgress, ctx.sessionManager);
      clearYooStatus(ctx);
      const text = formatResultText(result);
      ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
    },
  });

  pi.registerCommand("yoo-done", {
    description: "Mark the current yoo plan step complete and recommend the next step",
    handler: async (_args, ctx) => {
      const signal = undefined;
      const planProgress = getProgress(ctx.cwd);
      if (planProgress.total === 0) {
        ctx.ui.notify("No active yoo plan. Start one with /yoo plan <task>.", "warn");
        return;
      }
      if (planProgress.current >= planProgress.total) {
        ctx.ui.notify("All plan steps are already complete. Run /yoo judge for a final review.", "info");
        return;
      }
      markStepComplete(ctx.cwd);
      const newProgress = getProgress(ctx.cwd);
      ctx.ui.notify(`Step ${planProgress.current + 1} marked complete.`, "info");
      const situation = `Plan progress: ${newProgress.current}/${newProgress.total} steps completed. Current step: ${newProgress.nextStep ?? "none"}`;
      const progress = createProgressReporter("recommend", ctx);
      const notifyProgress: ProgressReporter = (stage, total, message) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };
      const result = await executeYooRecommend(ctx.cwd, situation, signal, notifyProgress, ctx.sessionManager);
      clearYooStatus(ctx);
      const text = formatResultText(result);
      ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
    },
  });

  pi.registerCommand("yoo-logs", {
    description: "Show recent yoo error/event log entries for this project",
    handler: async (_args, ctx) => {
      const entries = readRecentLogs(ctx.cwd, 50);
      if (entries.length === 0) {
        ctx.ui.notify("No yoo log entries yet.", "info");
        return;
      }
      await ctx.ui.select("Recent yoo logs", entries);
    },
  });

  pi.registerCommand("yoo-clear-logs", {
    description: "Clear the yoo error/event log for this project",
    handler: async (_args, ctx) => {
      clearLogs(ctx.cwd);
      ctx.ui.notify("yoo log cleared.", "info");
    },
  });

  pi.registerCommand("yoo-test", {
    description:
      "Test connectivity to configured secondary models. Optional: /yoo-test <plan|review|suggest|recommend|judge|scan>",
    handler: async (args, ctx) => {
      const config = loadHeyyooConfig(ctx.cwd);
      const requestedTask = args.trim().toLowerCase();
      const task = YOO_ACTIONS.find((action) => action === requestedTask);
      if (requestedTask && !task) {
        ctx.ui.notify(`Unknown yoo task "${requestedTask}". Use one of: ${YOO_ACTIONS.join(", ")}.`, "warn");
        return;
      }

      const tests: { task?: YooAction; model: SecondaryModelConfig; label: string }[] = [];
      if (task) {
        const model = resolveTaskModel(config, task);
        tests.push({ task, model, label: secondaryModelLabel(model) });
      } else {
        if (config.secondary.provider && config.secondary.id) {
          tests.push({ model: config.secondary, label: secondaryModelLabel(config.secondary) });
        }
        const defaultKey = `${config.secondary.provider}:${config.secondary.id}:${config.secondary.backend ?? "pi"}:${config.secondary.baseUrl ?? ""}`;
        for (const action of YOO_ACTIONS) {
          const override = config.taskModels?.[action];
          if (!override?.provider && !override?.id) continue;
          const model = resolveTaskModel(config, action);
          const key = `${model.provider}:${model.id}:${model.backend ?? "pi"}:${model.baseUrl ?? ""}`;
          if (key === defaultKey) continue;
          tests.push({ task: action, model, label: secondaryModelLabel(model) });
        }
      }

      if (tests.length === 0) {
        ctx.ui.notify("No secondary model configured. Run /yoo-config or /yoo-model first.", "warn");
        return;
      }

      const progress = createProgressReporter("scan", ctx);
      const notifyProgress: ProgressReporter = (stage, total, message) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };

      const runnableTests = tests.filter((t) => t.model.provider && t.model.id);
      if (runnableTests.length === 0) {
        ctx.ui.notify("No configured model has both a provider and model id.", "warn");
        return;
      }

      let failures = 0;
      const totalStages = runnableTests.length * 3;

      for (let i = 0; i < runnableTests.length; i++) {
        const { task: testTask, model, label } = runnableTests[i];
        const taskSuffix = testTask ? ` (${testTask})` : "";
        const baseStage = i * 3;

        notifyProgress(baseStage + 1, totalStages, `Testing ${label}${taskSuffix}…`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);

        try {
          const { content, usage } = await callSecondaryModel(
            model.provider,
            model.id,
            "You are a helpful assistant. Reply with exactly: yoo connection OK",
            "Test connection. Reply with exactly: yoo connection OK",
            {
              signal: controller.signal,
              thinking: model.thinking,
              cwd: ctx.cwd,
              sessionManager: ctx.sessionManager,
              task: testTask,
            },
          );
          clearTimeout(timeout);
          notifyProgress(baseStage + 2, totalStages, `Got response from ${label}${taskSuffix}`);
          const response = content.trim();
          const costText = usage
            ? ` (${formatTokenCount(usage.estimatedInputTokens)} in · ${formatTokenCount(usage.estimatedOutputTokens)} out · ${formatCost(usage.estimatedCostUsd)})`
            : "";
          if (
            response.toLowerCase().includes("yoo connection ok") ||
            response.toLowerCase().includes("connection ok")
          ) {
            notifyProgress(baseStage + 3, totalStages, `${label}${taskSuffix} OK`);
            ctx.ui.notify(`yoo-test OK: ${label}${taskSuffix} is reachable${costText}`, "info");
          } else {
            failures++;
            notifyProgress(baseStage + 3, totalStages, `${label}${taskSuffix} unexpected response`);
            ctx.ui.notify(
              `yoo-test warning: ${label}${taskSuffix} replied but content was unexpected: "${response.slice(0, 100)}"${costText}`,
              "warn",
            );
          }
        } catch (err) {
          failures++;
          clearTimeout(timeout);
          const message = err instanceof Error ? err.message : String(err);
          logEvent(ctx.cwd, "error", "yoo-test failed", {
            provider: model.provider,
            model: model.id,
            error: message,
          });
          notifyProgress(baseStage + 3, totalStages, `${label}${taskSuffix} connection failed`);
          ctx.ui.notify(`yoo-test failed for ${label}${taskSuffix}: ${message}`, "error");
        }
      }

      if (failures === 0) {
        notifyProgress(totalStages, totalStages, "All connections verified");
        ctx.ui.notify("yoo-test complete: all configured models are reachable.", "info");
      } else {
        notifyProgress(totalStages, totalStages, `${failures} connection(s) failed`);
        ctx.ui.notify(`yoo-test complete: ${failures} of ${tests.length} model(s) failed.`, "error");
      }
      clearYooStatus(ctx);
    },
  });

  pi.registerCommand("yoo-scan", {
    description: "Alias for /yoo scan — scan project conventions",
    handler: async (_args, ctx) => {
      const signal = undefined;
      const progress = createProgressReporter("scan", ctx);
      const notifyProgress: ProgressReporter = (stage, total, message) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };

      let result: YooToolResult;
      try {
        result = await executeYooScan(ctx.cwd, signal, notifyProgress, ctx.sessionManager);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent(ctx.cwd, "error", "yoo-scan command failed", { error: message });
        ctx.ui.notify(`yoo-scan error: ${message}`, "error");
        return;
      } finally {
        clearYooStatus(ctx);
      }

      const text = formatResultText(result);
      ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
    },
  });

  pi.registerCommand("yoo-scan-deep", {
    description: "Run /yoo scan with deep source-file sampling enabled",
    handler: async (_args, ctx) => {
      const signal = undefined;
      const progress = createProgressReporter("scan", ctx);
      const notifyProgress: ProgressReporter = (stage, total, message) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };

      let result: YooToolResult;
      try {
        result = await executeYooScan(ctx.cwd, signal, notifyProgress, ctx.sessionManager, true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent(ctx.cwd, "error", "yoo-scan-deep command failed", { error: message });
        ctx.ui.notify(`yoo-scan-deep error: ${message}`, "error");
        return;
      } finally {
        clearYooStatus(ctx);
      }

      const text = formatResultText(result);
      ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
    },
  });

  pi.registerCommand("yoo-backend", {
    description: "Switch secondary model backend between pi (default) and http (legacy)",
    handler: async (args, ctx) => {
      const config = loadHeyyooConfig(ctx.cwd);
      const current = config.secondary.backend ?? "pi";
      const requested = args.trim().toLowerCase();
      const next: "pi" | "http" =
        requested === "pi" ? "pi" : requested === "http" ? "http" : current === "pi" ? "http" : "pi";

      const settingsPath = join(getAgentDir(), "settings.json");
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
        } catch (err) {
          logEvent(ctx.cwd, "error", "Failed to read settings for yoo-backend", {
            error: err instanceof Error ? err.message : String(err),
          });
          ctx.ui.notify("Failed to read settings.json.", "error");
          return;
        }
      }

      if (!settings["pi-heyyoo"] || typeof settings["pi-heyyoo"] !== "object") {
        settings["pi-heyyoo"] = {};
      }
      const yooSettings = settings["pi-heyyoo"] as Record<string, unknown>;
      if (!yooSettings.secondary || typeof yooSettings.secondary !== "object") {
        yooSettings.secondary = {};
      }
      const secondary = yooSettings.secondary as Record<string, unknown>;
      secondary.backend = next;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

      ctx.ui.notify(`yoo secondary backend switched to ${next}. /reload to apply.`, "info");
    },
  });
}

async function showYooStatus(ctx: ExtensionContext): Promise<void> {
  const config = loadHeyyooConfig(ctx.cwd);
  const state = getState(ctx.cwd);
  const cost = getSessionCost(ctx.cwd);
  const conventions = loadConventions(ctx.cwd);
  const vcs = getVcsInfo(ctx.cwd);

  function modelStatusLine(model: SecondaryModelConfig): string {
    const backend = model.backend && model.backend !== "pi" ? ` (${model.backend})` : "";
    const thinking = model.thinking ? ` · ${model.thinking}` : "";
    return `${model.provider}:${model.id}${backend}${thinking}`;
  }

  const taskModelEntries = YOO_ACTIONS.filter((a) => {
    const override = config.taskModels?.[a];
    return override?.provider || override?.id;
  });

  const lines = [
    `pi-heyyoo v${VERSION}`,
    HOMEPAGE,
    "",
    "Configuration:",
    config.secondary.provider && config.secondary.id
      ? `  Base model: ${modelStatusLine(config.secondary)}`
      : "  Base model: not configured",
    `  Backend: ${config.secondary.backend ?? "pi"}`,
    `  Auto-judge: ${config.autoJudge ? "enabled" : "disabled"}`,
    config.preReviewCommands && config.preReviewCommands.length > 0
      ? `  Pre-review commands: ${config.preReviewCommands.join(", ")}`
      : "  Pre-review commands: none",
    "",
    "Session:",
    `  Cost: ${formatCost(cost.costUsd)} (${cost.calls} call${cost.calls === 1 ? "" : "s"})`,
    `  Review rounds this step: ${state.reviewRounds}`,
    "",
    "Plan:",
    state.plan ? `  Summary: ${state.plan.summary}` : "  No active plan",
  ];

  if (taskModelEntries.length > 0) {
    const sessionIndex = lines.indexOf("Session:");
    const insertAt = sessionIndex > 0 ? sessionIndex - 1 : lines.length;
    lines.splice(
      insertAt,
      0,
      "  Per-tool models:",
      ...taskModelEntries.map((action) => `    ${action}: ${modelStatusLine(resolveTaskModel(config, action))}`),
    );
  }

  if (state.plan) {
    lines.push(`  Progress: ${state.completedSteps}/${state.totalSteps} steps completed`);
    for (let i = 0; i < state.plan.todo.length; i++) {
      lines.push(`    ${state.completedSteps > i ? "✓" : "·"} ${state.plan.todo[i]}`);
    }
    if (state.plan.acceptanceCriteria.length > 0) {
      lines.push("  Acceptance criteria:");
      for (const c of state.plan.acceptanceCriteria) {
        lines.push(`    · ${c}`);
      }
    }
  }

  lines.push("", "Version control:");
  if (vcs.type === "unknown") {
    lines.push("  No git or svn repository detected");
  } else {
    lines.push(`  Type: ${vcs.type}`);
    if (vcs.branch) lines.push(`  Branch/URL: ${vcs.branch}`);
    if (vcs.revision) lines.push(`  Revision: ${vcs.revision}`);
    if (vcs.dirty !== undefined) lines.push(`  Dirty: ${vcs.dirty ? "yes" : "no"}`);
    if (vcs.error) lines.push(`  Error: ${vcs.error}`);
  }

  lines.push("", "Project conventions:");
  if (conventions) {
    lines.push(`  Stack: ${conventions.stack}`);
    lines.push(`  Naming: ${conventions.naming}`);
    lines.push(`  Structure: ${conventions.structure}`);
    lines.push(`  Patterns: ${conventions.patterns.length > 0 ? conventions.patterns.join("; ") : "none"}`);
    lines.push(`  Scanned at: ${conventions.generatedAt}`);
  } else {
    lines.push("  Not scanned — run yoo({ scan: true })");
  }

  lines.push("", `${HOMEPAGE} · pi-heyyoo v${VERSION}`);

  await ctx.ui.select("yoo status", lines.filter(Boolean));
}

function issueEmoji(severity: "high" | "medium" | "low"): string {
  switch (severity) {
    case "high":
      return "🔴";
    case "medium":
      return "🟡";
    default:
      return "💡";
  }
}

function formatResultText(result: YooToolResult): string {
  if (result.error) return `yoo error: ${result.error}`;

  const lines: string[] = [];

  if (result.cost) {
    const inTokens = formatTokenCount(result.cost.estimatedInputTokens);
    const outTokens = formatTokenCount(result.cost.estimatedOutputTokens);
    const cost = formatCost(result.cost.estimatedCostUsd);
    const session = formatCost(result.cost.sessionCostUsd);
    lines.push(`_${inTokens} in · ${outTokens} out · ${cost} (session ${session})_`);
    lines.push("");
  }

  if (result.plan) {
    lines.push("## yoo plan");
    lines.push("");
    lines.push(`**Summary:** ${result.plan.summary}`);
    lines.push("");
    lines.push("### Todo");
    for (let i = 0; i < result.plan.todo.length; i++) {
      lines.push(`${i + 1}. ${result.plan.todo[i]}`);
    }
    lines.push("");
    lines.push("### Acceptance Criteria");
    for (const c of result.plan.acceptanceCriteria) {
      lines.push(`- ${c}`);
    }
  }

  if (result.review) {
    const icon = result.review.verdict === "pass" ? "✓" : result.review.verdict === "blocked" ? "✗" : "⚠";
    lines.push(`## yoo review ${icon} ${result.review.verdict}`);
    lines.push("");

    if (result.review.truncated || (result.review.droppedFiles && result.review.droppedFiles.length > 0)) {
      const warnings: string[] = [];
      if (result.review.truncated) warnings.push("diff truncated");
      if (result.review.droppedFiles && result.review.droppedFiles.length > 0)
        warnings.push(`${result.review.droppedFiles.length} file(s) omitted from context`);
      lines.push(`⚠️ **Large change:** ${warnings.join(" · ")}`);
      lines.push("");
    }

    if (result.review.issues.length > 0) {
      lines.push("### Issues");
      for (const issue of result.review.issues) {
        const loc = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "unknown";
        lines.push(`- ${issueEmoji(issue.severity)} **${issue.severity}** ${loc}: ${issue.issue}`);
        if (issue.suggestion) lines.push(`  → ${issue.suggestion}`);
      }
      lines.push("");

      if (result.review.verdict !== "pass") {
        lines.push("### Fix plan");
        for (let i = 0; i < result.review.issues.length; i++) {
          const issue = result.review.issues[i];
          const loc = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "unknown";
          lines.push(
            `${i + 1}. ${issueEmoji(issue.severity)} **${issue.severity}** ${loc}: ${issue.suggestion || issue.issue}`,
          );
        }
        lines.push("");
      }
    }

    if (result.review.suggestions.length > 0) {
      lines.push("### Suggestions");
      for (const s of result.review.suggestions) {
        lines.push(`- 💡 ${s}`);
      }
      lines.push("");
    }

    if (result.review.consensus) {
      lines.push("**Consensus:** Both agents agree — step is complete.");
      if (result.review.planProgress) {
        lines.push(`**Progress:** ${result.review.planProgress}`);
      }
      if (result.review.nextStep) {
        lines.push(`**Next step:** ${result.review.nextStep}`);
      }
      if (result.review.autoJudged) {
        lines.push("**Auto-judge:** Last step done — final review was run automatically.");
      }
    } else if (result.review.verdict === "needs-work" || result.review.verdict === "blocked") {
      lines.push("**Action:** Fix the issues above and call `yoo.review` again.");
      if (result.review.escalated) {
        lines.push(
          "⚠️ **Escalation:** This step has failed review 3+ times. Consider asking the user for guidance or a different approach.",
        );
      }
    }
  }

  if (result.suggest) {
    lines.push("## yoo suggest");
    lines.push("");
    for (const a of result.suggest.approaches) {
      lines.push(`### ${a.title}`);
      lines.push(a.description);
      lines.push("");
      if (a.pros.length > 0) {
        lines.push("**Pros:**");
        for (const p of a.pros) lines.push(`- ${p}`);
        lines.push("");
      }
      if (a.cons.length > 0) {
        lines.push("**Cons:**");
        for (const c of a.cons) lines.push(`- ${c}`);
        lines.push("");
      }
    }
  }

  if (result.recommend) {
    lines.push("## yoo recommend");
    lines.push("");
    lines.push(`**Next step:** ${result.recommend.nextStep}`);
    lines.push("");
    lines.push(`**Reasoning:** ${result.recommend.reasoning}`);
    if (result.recommend.alternatives.length > 0) {
      lines.push("");
      lines.push("**Alternatives considered:**");
      for (const a of result.recommend.alternatives) {
        lines.push(`- ${a}`);
      }
    }
  }

  if (result.judge) {
    const icon = result.judge.verdict === "pass" ? "✓" : result.judge.verdict === "blocked" ? "✗" : "⚠";
    lines.push(`## yoo judge ${icon} ${result.judge.verdict}`);
    lines.push("");
    lines.push(result.judge.summary);
    lines.push("");

    if (result.judge.issues.length > 0) {
      lines.push("### Remaining Issues");
      for (const issue of result.judge.issues) {
        const loc = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "unknown";
        lines.push(`- ${issueEmoji(issue.severity)} **${issue.severity}** ${loc}: ${issue.issue}`);
      }
      lines.push("");
    }

    if (result.judge.consensus) {
      lines.push("**Consensus:** Both agents agree — all work is complete and meets criteria.");
    }
  }

  if (result.scan) {
    lines.push("## yoo scan");
    lines.push("");
    lines.push(formatConventions(result.scan.conventions));
    lines.push("");
    lines.push(`Scanned ${result.scan.files.length} files.`);
  }

  if (result.verificationRequested) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("### Main agent verification required");
    lines.push("");
    lines.push("Before acting on this yoo finding, confirm whether it actually makes sense.");
    lines.push("");
    lines.push("Reply with:");
    lines.push("- **Agreement:** `AGREE` / `DISAGREE` / `UNSURE`");
    lines.push("- **Reasoning:** Why does or doesn't this finding make sense?");
    lines.push(
      "- **Evidence:** Cite specific files, lines, facts, or reasoning from the context that support your position.",
    );
    lines.push("");
    lines.push("Do not treat the finding as accepted until you provide this verification.");
  }

  return lines.join("\n");
}
