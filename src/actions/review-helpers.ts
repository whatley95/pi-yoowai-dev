import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callSecondaryModel } from "../secondary-model.js";
import {
  buildAdaptiveReviewPrompt,
  validateReviewResult,
  getReviewValidationErrors,
  salvageReviewFromMarkdown,
} from "../prompts.js";
import { estimateTokens, type ReviewBudget } from "../token-budget.js";
import { type FileContentEntry } from "../file-loader.js";
import type { ProgressReporter } from "../progress.js";
import type { ReviewIssue, ReviewResult, ReviewVerdict, SecondaryModelConfig, UsageCost } from "../types.js";
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
  return results.map((r) => r ?? { ok: false, error: new Error("aborted") });
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
  const truncated = results.some((r) => r.truncated);
  return {
    verdict,
    issues,
    suggestions,
    consensus: verdict === "pass" && issues.length === 0,
    truncated,
    droppedFiles,
    // Conservative merges for the plan-tracker signals: a step is only
    // complete when EVERY per-file sub-review confirms it; a plan is stale
    // when ANY sub-review flags it.
    stepComplete: results.length > 0 && results.every((r) => r.stepComplete === true),
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
  relatedContext?: string;
  codemap?: string;
  truncated: boolean;
  droppedFiles: string[];
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
}

export async function runReviewBatch(input: ReviewBatchInput): Promise<{
  review: ReviewResult;
  usage: UsageCost;
  system: string;
  user: string;
  rounds?: number;
  truncated: boolean;
}> {
  const {
    cwd,
    description,
    files,
    diff,
    vcs,
    criteria,
    currentStep,
    sessionContext,
    conventionsText,
    preReviewOutput,
    memoryContext,
    relatedContext,
    codemap,
    truncated,
    droppedFiles,
    budget,
    modelConfig,
    signal,
    sessionManager,
    relevantPaths,
    progress,
    nativeJson,
    enableToolLoop,
    maxToolIterations,
    focusFiles,
  } = input;

  const systemPromptEstimate = 1000;
  // The codemap is counted within the input budget but yields to file
  // contents: it is deducted from what remains for the diff, after files.
  const remainingForDiff = Math.max(
    0,
    budget.availableInputTokens -
      files.reduce((sum, f) => sum + f.tokenEstimate, 0) -
      systemPromptEstimate -
      estimateTokens(codemap ?? ""),
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
      currentStep,
      sessionContext,
      conventionsText,
      preReviewOutput,
      memoryContext,
      relatedContext,
      codemap,
      truncated: diffTruncated,
      droppedFiles,
      budgetNote: `Context window: ${budget.contextWindow.toLocaleString()} tokens. Reserved output: ${budget.reservedOutputTokens.toLocaleString()}. Available for context: ${budget.availableInputTokens.toLocaleString()}.`,
      nativeJson,
      focusFiles,
      levelInstructions: input.levelInstructions,
    },
  );

  progress?.(8, STAGES.review, `Calling ${secondaryModelLabel(modelConfig)}…`);
  const {
    content: raw,
    usage,
    rounds,
    truncated: modelTruncated,
  } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
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
    enableToolLoop,
    maxToolIterations,
  });

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

  return { review, usage, system, user, rounds, truncated: modelTruncated ?? false };
}
