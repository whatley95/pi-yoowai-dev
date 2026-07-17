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
import type { ReviewResult, ReviewVerdict, SecondaryModelConfig, UsageCost } from "../types.js";
import { STAGES, secondaryModelLabel, parseStructuredResult, createStreamProgressCallback } from "./shared.js";

const MAX_SESSION_CONTEXT_CHARS = 4000;

export function getSessionContext(ctx: ExtensionContext): string {
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
}

export async function runReviewBatch(
  input: ReviewBatchInput,
): Promise<{ review: ReviewResult; usage: UsageCost; system: string; user: string }> {
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
      currentStep,
      sessionContext,
      conventionsText,
      preReviewOutput,
      memoryContext,
      relatedContext,
      truncated: diffTruncated,
      droppedFiles,
      budgetNote: `Context window: ${budget.contextWindow.toLocaleString()} tokens. Reserved output: ${budget.reservedOutputTokens.toLocaleString()}. Available for context: ${budget.availableInputTokens.toLocaleString()}.`,
      nativeJson,
    },
  );

  progress?.(8, STAGES.review, `Calling ${secondaryModelLabel(modelConfig)}…`);
  const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
    signal,
    thinking: modelConfig.thinking,
    cwd,
    sessionManager,
    relevantPaths,
    task: "review",
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

  return { review, usage, system, user };
}
