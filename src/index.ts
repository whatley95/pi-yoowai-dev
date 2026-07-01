import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./pi-paths.js";
import { loadHeyyooConfig } from "./config.js";
import { callSecondaryModel } from "./secondary-model.js";
import { getDiff, getVcsInfo } from "./diff-grabber.js";

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
import { calculateReviewBudget, estimateTokens } from "./token-budget.js";
import { loadFileContentsForReview, isReviewableFile } from "./file-loader.js";
import { renderCall, renderResult } from "./render.js";
import { loadState, saveState, clearState } from "./plan-store.js";
import type { YooToolParams, YooToolResult, HeyyooSessionState, PlanResult, YooAction, UsageCost } from "./types.js";
import {
  createLoopDetectionState,
  recordToolCall,
  checkLoop,
  shouldSendSteer,
  type LoopDetectionState,
} from "./loop-detector.js";
import { recordCost, getSessionCost, formatCost, resetCost } from "./cost-tracker.js";
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
} from "./conventions.js";
import { runPreReviewCommands, formatPreReviewOutput } from "./pre-review.js";
import { logEvent, readRecentLogs, clearLogs } from "./logger.js";
import { createProgressReporter, clearYooStatus, type ProgressReporter } from "./progress.js";

const STAGES = {
  plan: 3,
  review: 7,
  suggest: 3,
  recommend: 3,
  judge: 3,
  scan: 4,
} as const;

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
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  if (!config.secondary.provider || !config.secondary.id) {
    return { action: "plan", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }

  progress(1, STAGES.plan, "Loading project conventions…");
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";

  progress(2, STAGES.plan, "Calling secondary model…");
  const { system, user } = buildPlanPrompt(task, conventionsText);
  const { content: raw, usage } = await callSecondaryModel(
    config.secondary.provider,
    config.secondary.id,
    system,
    user,
    signal,
    config.secondary.thinking,
    cwd,
  );

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
  if (!config.secondary.provider || !config.secondary.id) {
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
  const baseBudget = calculateReviewBudget(config.secondary.provider, config.secondary.id, config, {
    systemPrompt: "", // estimated separately below to avoid building prompt twice
    sessionContext,
    conventionsText,
    preReviewOutput: "",
    description,
    memoryContext,
  });

  let preReviewOutput = "";
  if (config.preReviewCommands && config.preReviewCommands.length > 0) {
    progress(4, STAGES.review, "Running pre-review commands…");
    const results = runPreReviewCommands(cwd, config.preReviewCommands);
    preReviewOutput = formatPreReviewOutput(results);
    const preReviewChars = baseBudget.availableInputTokens * 4;
    if (preReviewOutput.length > preReviewChars) {
      preReviewOutput = preReviewOutput.slice(0, preReviewChars) + "\n… (truncated to token budget)";
    }
  } else {
    progress(4, STAGES.review, "Preparing review context…");
  }

  const strategy = config.reviewStrategy ?? "auto";
  const fullFileThresholdLines = config.reviewFullFileThresholdLines ?? 300;
  progress(5, STAGES.review, "Calculating token budget with pre-review output…");
  const budgetWithPreReview = calculateReviewBudget(config.secondary.provider, config.secondary.id, config, {
    systemPrompt: "",
    sessionContext,
    conventionsText,
    preReviewOutput,
    description,
    memoryContext,
  });
  progress(6, STAGES.review, "Loading changed file contents…");
  const fileResult =
    strategy === "diff-only"
      ? { entries: [], dropped: [], totalTokens: 0 }
      : loadFileContentsForReview({
          cwd,
          changedFiles,
          budget: budgetWithPreReview,
          strategy,
          fullFileThresholdLines,
        });

  // Diff gets whatever budget remains after fixed parts and file contents.
  const systemPromptEstimate = 1000; // approximate; safety margin absorbs error
  const remainingForDiff = Math.max(
    0,
    budgetWithPreReview.availableInputTokens - fileResult.totalTokens - systemPromptEstimate,
  );
  const diffTokens = estimateTokens(diff);
  const finalDiff = diffTokens > remainingForDiff ? diff.slice(0, remainingForDiff * 4) + "\n... diff truncated" : diff;
  const diffTruncated = truncated || finalDiff !== diff;

  // Surface context limitations so the user knows the review was scoped.
  const droppedForBudget = fileResult.dropped.filter((f) => isReviewableFile(f));

  progress(7, STAGES.review, "Building review prompt…");
  const { system, user } = buildAdaptiveReviewPrompt(
    description,
    finalDiff,
    fileResult.entries.map((e) => ({
      file: e.file,
      content: e.content,
      mode: e.mode,
    })),
    {
      vcs,
      criteria: state.plan?.acceptanceCriteria?.join("\n"),
      sessionContext,
      conventionsText,
      preReviewOutput,
      memoryContext,
      truncated: diffTruncated,
      droppedFiles: droppedForBudget,
      budgetNote: `Context window: ${baseBudget.contextWindow.toLocaleString()} tokens. Reserved output: ${baseBudget.reservedOutputTokens.toLocaleString()}. Available for context: ${baseBudget.availableInputTokens.toLocaleString()}.`,
    },
  );

  progress(8, STAGES.review, "Calling secondary model…");
  const { content: raw, usage } = await callSecondaryModel(
    config.secondary.provider,
    config.secondary.id,
    system,
    user,
    signal,
    capReviewThinking(config.secondary.thinking),
    cwd,
  );

  progress(9, STAGES.review, "Parsing review…");
  const parsed = parseJsonResponse(raw);
  const review = validateReviewResult(parsed);
  const cost = recordCostWithBudget(cwd, usage);

  if (!review) {
    logEvent(cwd, "warn", "Failed to parse review from secondary model response", {
      raw: raw.slice(0, 2000),
      parsed: parsed === null ? null : typeof parsed,
      parseError: getJsonParseError(raw),
      validationErrors: parsed ? getReviewValidationErrors(parsed) : [],
    });
    return {
      action: "review",
      error: "Failed to parse review from secondary model response.",
      review: { verdict: "needs-work", issues: [], suggestions: [], consensus: false },
      cost,
    };
  }

  progress(10, STAGES.review, "Recording issues…");
  recordIssues(cwd, review.issues);

  if (diffTruncated) review.truncated = true;
  if (droppedForBudget.length > 0) review.droppedFiles = droppedForBudget;
  if (diffTruncated || droppedForBudget.length > 0) {
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
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  if (!config.secondary.provider || !config.secondary.id) {
    return { action: "suggest", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }

  progress(1, STAGES.suggest, "Loading project conventions…");
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";

  const { system, user } = buildSuggestPrompt(question, conventionsText);
  progress(2, STAGES.suggest, "Calling secondary model…");
  const { content: raw, usage } = await callSecondaryModel(
    config.secondary.provider,
    config.secondary.id,
    system,
    user,
    signal,
    config.secondary.thinking,
    cwd,
  );

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
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  if (!config.secondary.provider || !config.secondary.id) {
    return { action: "recommend", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }

  const state = getState(cwd);

  progress(1, STAGES.recommend, "Loading project conventions…");
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";

  const { system, user } = buildRecommendPrompt(situation, state.plan?.todo, conventionsText);
  progress(2, STAGES.recommend, "Calling secondary model…");
  const { content: raw, usage } = await callSecondaryModel(
    config.secondary.provider,
    config.secondary.id,
    system,
    user,
    signal,
    config.secondary.thinking,
    cwd,
  );

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
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  if (!config.secondary.provider || !config.secondary.id) {
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

  progress(2, STAGES.judge, "Calling secondary model…");
  const { content: raw, usage } = await callSecondaryModel(
    config.secondary.provider,
    config.secondary.id,
    system,
    user,
    signal,
    config.secondary.thinking,
    cwd,
  );

  progress(3, STAGES.judge, "Parsing judgment…");
  const parsed = parseJsonResponse(raw);
  const judge = validateJudgeResult(parsed);

  if (!judge) {
    logEvent(cwd, "warn", "Failed to parse judgment from secondary model response", {
      raw: raw.slice(0, 2000),
      parsed: parsed === null ? null : typeof parsed,
      parseError: getJsonParseError(raw),
      validationErrors: parsed ? getJudgeValidationErrors(parsed) : [],
    });
    return {
      action: "judge",
      error: "Failed to parse judgment from secondary model response.",
      cost: recordCostWithBudget(cwd, usage),
    };
  }

  return { action: "judge", judge, cost: recordCostWithBudget(cwd, usage) };
}

async function executeYooScan(
  cwd: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  if (!config.secondary.provider || !config.secondary.id) {
    return { action: "scan", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }

  progress(1, STAGES.scan, "Scanning local project conventions…");
  const localScan = scanProjectConventions(cwd);

  const { system, user } = buildScanPrompt();
  const filesForPrompt = filterSourceFiles(localScan.files).slice(0, 200);
  const configFilesText = formatConfigFiles(cwd);
  progress(2, STAGES.scan, "Calling secondary model…");
  const { content: raw, usage } = await callSecondaryModel(
    config.secondary.provider,
    config.secondary.id,
    system,
    `${user}\n\nFiles:\n${filesForPrompt.join("\n")}${configFilesText}`,
    signal,
    config.secondary.thinking,
    cwd,
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
    sessionCostUsd: b.sessionCostUsd,
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
    return value.filter((v): v is string => typeof v === "string" && v.length > 0);
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
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionStates.delete(ctx.cwd);
    loopStates.delete(ctx.cwd);
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
          result = await executeYooPlan(ctx.cwd, p.plan, signal, progress);
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
          result = await executeYooSuggest(ctx.cwd, p.suggest, signal, progress);
        } else if (p.recommend) {
          result = await executeYooRecommend(ctx.cwd, p.recommend, signal, progress);
        } else if (p.judge) {
          result = await executeYooJudge(ctx.cwd, p.judge, signal, progress);
        } else {
          result = await executeYooScan(ctx.cwd, signal, progress);
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
            result = await executeYooPlan(ctx.cwd, restText, signal, notifyProgress);
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
            result = await executeYooSuggest(ctx.cwd, restText, signal, notifyProgress);
            break;
          case "recommend":
            result = await executeYooRecommend(ctx.cwd, restText || "what next", signal, notifyProgress);
            break;
          case "judge":
            result = await executeYooJudge(ctx.cwd, restText || "all done", signal, notifyProgress);
            break;
          case "scan":
            result = await executeYooScan(ctx.cwd, signal, notifyProgress);
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
    description: "Configure secondary model for yoo pair-programmer",
    handler: async (args, ctx) => {
      const settingsPath = join(getAgentDir(), "settings.json");
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(`Edit ${settingsPath} and set pi-heyyoo.secondary.provider and pi-heyyoo.secondary.id`, "info");
        return;
      }

      const [provider, ...modelParts] = trimmed.split(/\.|\s+/);
      const modelId = modelParts.join(".");
      if (!provider || !modelId) {
        ctx.ui.notify(`Usage: /yoo-config <provider.model> (e.g. /yoo-config openai.gpt-4o)`, "warn");
        return;
      }

      try {
        const existing = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
        existing["pi-heyyoo"] = existing["pi-heyyoo"] || {};
        existing["pi-heyyoo"].secondary = existing["pi-heyyoo"].secondary || {};
        existing["pi-heyyoo"].secondary.provider = provider;
        existing["pi-heyyoo"].secondary.id = modelId;
        writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
        ctx.ui.notify(`Set yoo secondary model to ${provider}.${modelId} in ${settingsPath}`, "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to update settings: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("yoo-model", {
    description: "Interactively pick the secondary model for yoo",
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

        const providers = [...new Set(configuredModels.map((m) => m.provider))].sort();
        let provider: string;
        if (providers.length === 1) {
          provider = providers[0];
        } else {
          const picked = await ctx.ui.select(
            "Pick provider:",
            providers.map((p) => {
              const count = configuredModels.filter((m) => m.provider === p).length;
              return `${p} (${count} models)`;
            }),
          );
          if (!picked) return;
          provider = picked.split(" ")[0];
        }

        const providerModels = configuredModels
          .filter((m) => m.provider === provider)
          .sort((a, b) => a.id.localeCompare(b.id));
        const currentConfig = loadHeyyooConfig(ctx.cwd);
        const isCurrent = currentConfig.secondary.provider === provider && currentConfig.secondary.id;
        const modelItems = providerModels.map((m) => {
          const marker = isCurrent && m.id === currentConfig.secondary.id ? " ✓ current" : "";
          return `${m.id}${marker}`;
        });

        const modelIdPicked = await ctx.ui.select(`Pick model for ${provider}:`, modelItems);
        if (!modelIdPicked) return;
        const modelId = modelIdPicked.replace(/ ✓ current$/, "");

        const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
        const currentThinking = currentConfig.secondary.thinking ?? "xhigh";
        const thinkingItems = thinkingLevels.map(
          (t) =>
            `${t}${t === currentThinking && isCurrent && currentConfig.secondary.id === modelId ? " ✓ current" : ""}`,
        );
        const thinkingPicked = await ctx.ui.select("Pick thinking level:", thinkingItems);
        if (!thinkingPicked) return;
        const thinking = thinkingPicked.replace(" ✓ current", "");

        const agentDir = getAgentDir();
        const settingsPath = join(agentDir, "settings.json");
        if (!existsSync(agentDir)) {
          const { mkdirSync } = await import("node:fs");
          mkdirSync(agentDir, { recursive: true });
        }
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
        if (!settings["pi-heyyoo"]) settings["pi-heyyoo"] = {};
        (settings["pi-heyyoo"] as Record<string, unknown>).secondary = {
          provider,
          id: modelId,
          thinking,
        };
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

        ctx.ui.notify(`Secondary model set to ${provider}:${modelId} (${thinking}).`, "info");
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
    description: "Clear the active yoo plan, state, cost, memory, and conventions",
    handler: async (_args, ctx) => {
      sessionStates.delete(ctx.cwd);
      clearState(ctx.cwd);
      resetCost(ctx.cwd);
      clearMemory(ctx.cwd);
      clearConventions(ctx.cwd);
      ctx.ui.notify("yoo plan, state, cost, memory, and conventions cleared.", "info");
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
      const result = await executeYooRecommend(ctx.cwd, situation, signal, notifyProgress);
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
      const result = await executeYooRecommend(ctx.cwd, situation, signal, notifyProgress);
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
}

async function showYooStatus(ctx: ExtensionContext): Promise<void> {
  const config = loadHeyyooConfig(ctx.cwd);
  const state = getState(ctx.cwd);
  const cost = getSessionCost(ctx.cwd);
  const conventions = loadConventions(ctx.cwd);
  const vcs = getVcsInfo(ctx.cwd);

  const lines = [
    `pi-heyyoo v${VERSION}`,
    HOMEPAGE,
    "",
    "Configuration:",
    config.secondary.provider && config.secondary.id
      ? `  Secondary model: ${config.secondary.provider}:${config.secondary.id}`
      : "  Secondary model: not configured",
    `  Thinking level: ${config.secondary.thinking ?? "off"}`,
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
    } else if (result.review.verdict === "needs-work") {
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
