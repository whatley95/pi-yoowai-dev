import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildReviewEvidencePack } from "./evidence-pack.js";
import { callSecondaryModel } from "../secondary-model.js";
import { ToolLoopCoverageError } from "../tool-loop.js";
import { resolveReviewToolContext } from "./review-tool-context.js";
import { additionContainsSource } from "./review-chunks.js";
import { logEvent } from "../logger.js";
import { emptyRecordedUsage } from "../cost-tracker.js";
import { splitDiffByFile } from "../diff-grabber.js";
import {
  buildAdaptiveReviewPrompt,
  validateReviewResult,
  getReviewValidationErrors,
  salvageReviewFromMarkdown,
} from "../prompts.js";
import { estimateTokens, type ReviewBudget } from "../token-budget.js";
import { type FileContentEntry } from "../file-loader.js";
import type { ProgressReporter } from "../progress.js";
import type {
  ReviewAssignment,
  ReviewIssue,
  ReviewResult,
  ReviewVerdict,
  SecondaryModelConfig,
  UsageCost,
  ReviewExecution,
} from "../types.js";
import { STAGES, secondaryModelLabel, parseStructuredResult, createStreamProgressCallback } from "./shared.js";

const MAX_SESSION_CONTEXT_CHARS = 4000;

export function getSessionContext(ctx: ExtensionContext): string {
  try {
    const entries = ctx.sessionManager?.getEntries();
    if (!Array.isArray(entries) || entries.length === 0) return "";

    // Exclude the most recent entry because it is the current user/tool turn that
    // triggered this wai call; including it would add self-referential noise.
    const recent = entries.length > 1 ? entries.slice(-10, -1) : [];
    const lines: string[] = [];
    let total = 0;

    for (const entry of recent.slice().reverse()) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as unknown as Record<string, unknown>;
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

export type ConcurrencyOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  signal?: AbortSignal,
): Promise<ConcurrencyOutcome<T>[]> {
  const results: (ConcurrencyOutcome<T> | undefined)[] = new Array(tasks.length);
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
  // Workers stop early on abort, leaving unstarted slots as holes. Fill them so
  // callers iterating outcomes don't hit a TypeError on undefined elements.
  return Array.from(results, (r) => r ?? { ok: false, error: new Error("aborted") });
}

function normalizeIssueText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

const SEVERITY_RANK: Record<ReviewIssue["severity"], number> = { high: 3, medium: 2, low: 1 };

/** Cross-batch issue dedup for parallel reviews: with one model batch per
 *  changed file, the same cross-file issue can be flagged from two files'
 *  batches. Collapse only exact repeats — same file + line + normalized text
 *  (file still participates when line is missing; normalized text alone only
 *  when both are absent) — so two genuinely different findings on the same
 *  line both survive. When a repeat carries a higher severity, the worse
 *  occurrence replaces the kept one so severity is never masked. Mirrors the
 *  Set dedup already applied to suggestions in the same merge. */
export function dedupeIssues(issues: ReviewIssue[]): ReviewIssue[] {
  const kept: ReviewIssue[] = [];
  const index = new Map<string, number>();
  for (const issue of issues) {
    const text = normalizeIssueText(issue.issue);
    const key = issue.file ? `${issue.file}:${issue.line ?? ""}:${text}` : `text:${text}`;
    const existingIdx = index.get(key);
    if (existingIdx === undefined) {
      index.set(key, kept.length);
      kept.push(issue);
    } else {
      const existing = kept[existingIdx];
      if (existing && SEVERITY_RANK[issue.severity] > SEVERITY_RANK[existing.severity]) {
        kept[existingIdx] = issue;
      }
    }
  }
  return kept;
}

export function mergeReviewResults(results: ReviewResult[]): ReviewResult {
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
  const issues = dedupeIssues(results.flatMap((r) => r.issues));
  const suggestions = Array.from(new Set(results.flatMap((r) => r.suggestions)));
  const droppedFiles = Array.from(new Set(results.flatMap((r) => r.droppedFiles ?? [])));
  const omittedFileContents = Array.from(new Set(results.flatMap((r) => r.omittedFileContents ?? [])));
  const truncated = results.some((r) => r.truncated);
  const coverageGaps = Array.from(new Set(results.flatMap((r) => r.coverageGaps ?? [])));
  const contextLimited = results.some((r) => r.contextLimited || r.inputIncomplete || r.inconclusive || r.checksFailed);
  const incomplete =
    results.length === 0 || truncated || contextLimited || droppedFiles.length > 0 || coverageGaps.length > 0;
  if (incomplete && verdict === "pass") verdict = "needs-work";
  return {
    verdict,
    issues,
    suggestions,
    consensus: !incomplete && verdict === "pass" && issues.length === 0,
    truncated,
    droppedFiles,
    omittedFileContents,
    contextLimited: incomplete,
    coverageGaps,
    ...(results.some((r) => r.inputIncomplete) ? { inputIncomplete: true } : {}),
    ...(results.some((r) => r.inconclusive) ? { inconclusive: true } : {}),
    ...(results.some((r) => r.checksFailed) ? { checksFailed: true } : {}),
    ...(results.some((r) => r.scopeLimited) ? { scopeLimited: true } : {}),
    // Conservative merges for the plan-tracker signals: a step is only
    // complete when EVERY per-file sub-review confirms it; a plan is stale
    // when ANY sub-review flags it.
    stepComplete: !incomplete && results.length > 0 && results.every((r) => r.stepComplete === true),
    planStale: results.some((r) => r.planStale === true),
  };
}

export interface ReviewBatchInput {
  cwd: string;
  description: string;
  files: FileContentEntry[];
  diff: string;
  vcs?: string;
  criteria?: string;
  currentStep?: string;
  sessionContext: string;
  conventionsText: string;
  preReviewOutput: string;
  memoryContext: string;
  decisionsContext?: string;
  priorRoundContext?: string;
  relatedContext?: string;
  codemap?: string;
  designRefText?: string;
  instructionsText?: string;
  truncated: boolean;
  droppedFiles: string[];
  omittedFileContents?: string[];
  budget: ReviewBudget;
  modelConfig: SecondaryModelConfig;
  signal?: AbortSignal;
  sessionManager?: ExtensionContext["sessionManager"];
  relevantPaths: string[];
  progress?: ProgressReporter;
  nativeJson?: boolean;
  enableToolLoop?: boolean;
  maxToolIterations?: number;
  focusFiles?: string[];
  levelInstructions?: string;
  evidencePackMaxTokens?: number;
  assignment?: ReviewAssignment;
  allowAdaptiveToolContext?: boolean;
}

function batchPrompt(
  input: ReviewBatchInput,
  diff: string,
  files = input.files,
  evidencePack = "",
  omitted = input.omittedFileContents,
) {
  return buildAdaptiveReviewPrompt(input.description, diff, files, {
    vcs: input.vcs,
    criteria: input.criteria,
    currentStep: input.currentStep,
    sessionContext: input.sessionContext,
    conventionsText: input.conventionsText,
    preReviewOutput: input.preReviewOutput,
    memoryContext: input.memoryContext,
    decisionsText: input.decisionsContext,
    priorRoundContext: input.priorRoundContext,
    relatedContext: input.relatedContext,
    codemap: input.codemap,
    evidencePack,
    designRefText: input.designRefText,
    instructionsText: input.instructionsText,
    truncated: input.truncated,
    droppedFiles: input.droppedFiles,
    omittedFileContents: omitted,
    budgetNote: `Context window: ${input.budget.contextWindow.toLocaleString()} tokens. Reserved output: ${input.budget.reservedOutputTokens.toLocaleString()}.`,
    nativeJson: input.nativeJson,
    focusFiles: input.focusFiles,
    levelInstructions: input.levelInstructions,
    assignment: input.assignment,
  });
}

export function reviewPromptLimit(input: ReviewBatchInput): number {
  return Math.max(
    0,
    Math.min(
      input.budget.hardInputCap ?? Infinity,
      input.budget.contextWindow - input.budget.reservedOutputTokens - input.budget.safetyMarginTokens,
    ),
  );
}

/** Measure the actual fixed prompt, including optional guidance and tool
 * instructions, before assigning any diff. File contents yield to patches. */
export function reviewDiffAllowance(input: ReviewBatchInput): number {
  const base = batchPrompt(input, "", [], "", []);
  return Math.max(
    0,
    reviewPromptLimit(input) - estimateTokens(base.system + base.user) - (input.enableToolLoop ? 1200 : 0) - 256,
  );
}

export async function runReviewBatch(input: ReviewBatchInput): Promise<{
  review: ReviewResult;
  usage: UsageCost;
  system: string;
  user: string;
  rounds?: number;
  truncated: boolean;
  execution?: ReviewExecution;
}> {
  const {
    cwd,
    diff,
    budget,
    modelConfig,
    signal,
    sessionManager,
    relevantPaths,
    progress,
    enableToolLoop,
    maxToolIterations,
    evidencePackMaxTokens,
  } = input;

  const byFile = splitDiffByFile(diff, input.vcs as "git" | "svn" | undefined);
  let files = input.files.filter(
    (file) => input.truncated || !additionContainsSource(byFile[file.file] ?? diff, file.content),
  );
  const duplicateSourceFiles = input.files.length - files.length;
  const omitted = new Set(input.omittedFileContents ?? []);
  if (input.truncated) {
    return {
      review: {
        verdict: "needs-work",
        issues: [],
        suggestions: [
          "The captured diff is truncated. Obtain its complete patch before spending another model review request.",
        ],
        consensus: false,
        contextLimited: true,
        inputIncomplete: true,
        coverageGaps: relevantPaths,
        stepComplete: false,
        completedSteps: 0,
      },
      usage: emptyRecordedUsage(cwd),
      system: "",
      user: "",
      rounds: 0,
      truncated: true,
    };
  }
  const limit = reviewPromptLimit(input) - (enableToolLoop ? 1200 : 0);
  let prompt = batchPrompt(input, diff, files, "", [...omitted]);
  while (estimateTokens(prompt.system + prompt.user) > limit && files.length) {
    const largest = files.reduce(
      (best, file, index) => (file.tokenEstimate > files[best].tokenEstimate ? index : best),
      0,
    );
    omitted.add(files[largest].file);
    files = files.filter((_, index) => index !== largest);
    prompt = batchPrompt(input, diff, files, "", [...omitted]);
  }
  // Never spend a provider request on a locally known partial patch.
  if (estimateTokens(prompt.system + prompt.user) > limit) {
    return {
      review: {
        verdict: "needs-work",
        issues: [],
        suggestions: [
          "Complete review evidence cannot fit this batch. Split the diff or use a larger-context model before retrying.",
        ],
        consensus: false,
        contextLimited: true,
        inputIncomplete: true,
        coverageGaps: relevantPaths,
        stepComplete: false,
        completedSteps: 0,
      },
      usage: emptyRecordedUsage(cwd),
      system: prompt.system,
      user: prompt.user,
      rounds: 0,
      truncated: input.truncated,
    };
  }
  const packBudget = Math.max(
    0,
    Math.min(evidencePackMaxTokens ?? 1200, limit - estimateTokens(prompt.system + prompt.user) - 256),
  );
  const evidenceText = buildReviewEvidencePack(cwd, {
    budgetTokens: packBudget,
    changedFiles: [...new Set(relevantPaths)],
  }).text;
  const withPack = batchPrompt(input, diff, files, evidenceText, [...omitted]);
  if (estimateTokens(withPack.system + withPack.user) <= limit) prompt = withPack;
  const { system, user } = prompt;
  const finalDiff = diff;
  const fileTokens = files.reduce((sum, file) => sum + file.tokenEstimate, 0);
  const otherUsed = [
    input.codemap,
    input.designRefText,
    input.instructionsText,
    input.priorRoundContext,
    input.decisionsContext,
    input.relatedContext,
  ].reduce((sum, text) => sum + estimateTokens(text ?? ""), 0);
  logEvent(cwd, "info", "Review prompt prepared", {
    files: relevantPaths,
    promptTokens: estimateTokens(system + user),
    inputLimit: limit,
    diffTokens: estimateTokens(diff),
    suppliedFileTokens: fileTokens,
    omittedFileContents: [...omitted],
    duplicateSourceFiles,
    reservedOutputTokens: budget.reservedOutputTokens,
  });
  progress?.(8, STAGES.review, `Calling ${secondaryModelLabel(modelConfig)}…`);
  const toolContext = enableToolLoop
    ? resolveReviewToolContext({
        cwd,
        paths: relevantPaths,
        files,
        budget,
        system,
        user,
        evidenceTokens: fileTokens + otherUsed + estimateTokens(evidenceText) + estimateTokens(finalDiff),
        maxRequests: maxToolIterations,
        adaptive: input.allowAdaptiveToolContext,
      })
    : {};
  if (enableToolLoop)
    logEvent(cwd, "info", "Review context allowance prepared", {
      files: relevantPaths,
      ...toolContext,
      adaptive: input.allowAdaptiveToolContext === true,
    });
  let response: Awaited<ReturnType<typeof callSecondaryModel>>;
  const execution: ReviewExecution = {
    batches: 1,
    segments: input.assignment?.hunk ? 1 : 0,
    modelCalls: 0,
    contextRequests: 0,
    modelTimeMs: 0,
    contextTimeMs: 0,
    verificationTimeMs: 0,
  };
  const started = Date.now();
  try {
    response = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
      signal,
      thinking: modelConfig.thinking,
      cwd,
      sessionManager,
      relevantPaths,
      task: "review",
      // The model was already resolved in executeWaiReview with the correct
      // fallback chain (level override → review override → base). Without this
      // override, task-based resolution would clobber a per-level model with
      // the generic review task model.
      secondaryOverride: modelConfig,
      structuredOutput: true,
      onStreamProgress: progress ? createStreamProgressCallback(progress, 8, STAGES.review) : undefined,
      onStreamPhase: progress
        ? (phase) =>
            progress(
              8,
              STAGES.review,
              `${relevantPaths.join(", ")}: ${phase === "thinking" ? "model is reasoning" : "model is writing the review"}…`,
            )
        : undefined,
      enableToolLoop,
      maxToolIterations,
      ...toolContext,
      onToolLoopEvent: (event) => {
        if (event.phase === "model") {
          execution.modelCalls++;
          execution.modelTimeMs += event.elapsedMs;
        } else {
          execution.contextRequests++;
          execution.contextTimeMs += event.elapsedMs;
          progress?.(
            8,
            STAGES.review,
            `${relevantPaths.join(", ")}: context request ${execution.contextRequests} completed…`,
          );
        }
      },
    });
  } catch (error) {
    if (!(error instanceof ToolLoopCoverageError)) throw error;
    logEvent(cwd, "warn", "Review context coverage incomplete", {
      files: relevantPaths,
      coverageGaps: error.coverageGaps,
      error: error.message,
    });
    return {
      review: {
        verdict: "needs-work",
        issues: [],
        suggestions: [error.message],
        consensus: false,
        contextLimited: true,
        coverageGaps: error.coverageGaps.length ? error.coverageGaps : relevantPaths,
        stepComplete: false,
        completedSteps: 0,
        omittedFileContents: [...omitted],
      },
      usage: error.usage,
      system,
      user,
      rounds: 0,
      truncated: false,
      execution,
    };
  }
  const { content: raw, usage, rounds, truncated: modelTruncated } = response;
  if (!execution.modelCalls) {
    execution.modelCalls = 1 + (rounds ?? 0);
    execution.modelTimeMs = Date.now() - started;
  }

  const review = parseStructuredResult(cwd, raw, {
    label: "Review",
    validate: validateReviewResult,
    validationErrors: getReviewValidationErrors,
    salvage: salvageReviewFromMarkdown,
    salvageDetails: (salvaged) => ({
      verdict: salvaged.verdict,
      suggestionCount: salvaged.suggestions.length,
    }),
  });

  if (!review) {
    throw new Error("Failed to parse review from secondary model response.");
  }
  const omissions = Array.from(new Set([...[...omitted], ...(review.omittedFileContents ?? [])]));
  if (omissions.length) review.omittedFileContents = omissions;

  return { review, usage, system, user, rounds, truncated: modelTruncated ?? false, execution };
}
