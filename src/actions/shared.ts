import { recordCost } from "../cost-tracker.js";
import { loadHeyyooConfig } from "../config.js";
import { logEvent } from "../logger.js";
import { parseJsonResponse, getJsonParseError } from "../prompts.js";
import type { ProgressReporter } from "../progress.js";
import type { UsageCost, SecondaryModelConfig, HeyyooConfig, YooToolResult } from "../types.js";

export const STAGES = {
  plan: 3,
  review: 10,
  suggest: 3,
  recommend: 3,
  judge: 3,
  scan: 4,
  test: 7,
  security: 5,
} as const;

export function secondaryModelLabel(secondary: SecondaryModelConfig): string {
  const { provider, id, backend } = secondary;
  const label = provider && id ? `${provider}:${id}` : "secondary model";
  return backend ? `${label} (${backend})` : label;
}

export function createStreamProgressCallback(
  progress: ProgressReporter,
  stage: number,
  total: number,
): (text: string) => void {
  return (text) => {
    const preview = text.slice(0, 60).replace(/\s+/g, " ").trim();
    progress(stage, total, preview ? `Generating: ${preview}…` : "Generating response…");
  };
}

export function recordCostWithBudget(cwd: string, usage: UsageCost): UsageCost {
  const config = loadHeyyooConfig(cwd);
  return recordCost(cwd, usage, config.costBudgetUsd);
}

/** Build continuation metadata for YooToolResult from callSecondaryModel's rounds
 *  return value. Returns undefined when no continuation occurred. */
export function continuationMeta(rounds: number | undefined, truncated: boolean): YooToolResult["continuation"] {
  if (!rounds || rounds === 0) {
    return truncated ? { rounds: 0, status: "truncated-after-cap" } : undefined;
  }
  return { rounds, status: truncated ? "truncated-after-cap" : "stitched" };
}

export function mergeUsageCost(a: UsageCost, b: UsageCost): UsageCost {
  return {
    estimatedInputTokens: a.estimatedInputTokens + b.estimatedInputTokens,
    estimatedOutputTokens: a.estimatedOutputTokens + b.estimatedOutputTokens,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
    // Both sessionCostUsd values are cumulative totals; keep the latest.
    sessionCostUsd: Math.max(a.sessionCostUsd, b.sessionCostUsd),
  };
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function toolLoopOptions(config: HeyyooConfig): { enableToolLoop: boolean; maxToolIterations?: number } {
  if (!config.toolUseLoop) return { enableToolLoop: false };
  // A numeric value <= 0 is not a valid iteration count. Treat it as "use the
  // default" rather than disabling the loop (which would otherwise return the
  // prompt verbatim as the model response).
  const maxToolIterations =
    typeof config.toolUseLoop === "number" && config.toolUseLoop > 0 ? config.toolUseLoop : undefined;
  return { enableToolLoop: true, maxToolIterations };
}

export function parseStructuredResult<T>(
  cwd: string,
  raw: string,
  options: {
    label: string;
    validate: (data: unknown) => T | null;
    validationErrors: (data: unknown) => Array<{ path: string; message: string; value: unknown }>;
    salvage?: (raw: string) => T | null;
    salvageDetails?: (value: T) => Record<string, unknown>;
  },
): T | null {
  const parsed = parseJsonResponse(raw);
  const result = options.validate(parsed);
  if (result) return result;

  const details = {
    raw: raw.slice(0, 2000),
    parsed: parsed === null ? null : typeof parsed,
    parseError: getJsonParseError(raw),
    validationErrors: parsed ? options.validationErrors(parsed) : [],
  };
  logEvent(cwd, "debug", `${options.label} response was not valid JSON; trying markdown salvage`, details);

  const salvaged = options.salvage?.(raw) ?? null;
  if (salvaged) {
    logEvent(cwd, "info", `Salvaged ${options.label.toLowerCase()} from markdown response`, {
      ...(options.salvageDetails?.(salvaged) ?? {}),
    });
    return salvaged;
  }

  logEvent(cwd, "warn", `Failed to parse ${options.label.toLowerCase()} from secondary model response`, details);
  return null;
}

const POST_STITCH_RETRY_PROMPT =
  "Continue your previous response exactly where it left off. Do not repeat what you already wrote; output only the remaining content. If the response was already complete, output nothing.";

/** Remove a leading prefix shared with `previous` from `next` so a retry that
 *  re-emits the tail of the original response does not duplicate it. */
function stripRetryOverlap(previous: string, next: string): string {
  const maxOverlap = Math.min(previous.length, next.length, 200);
  for (let len = maxOverlap; len > 0; len--) {
    if (previous.endsWith(next.slice(0, len))) {
      return next.slice(len);
    }
  }
  return next;
}

/** When a stitched (multi-round continuation) response fails to parse, issue
 *  one retry continuation asking the model to produce the valid tail. Returns
 *  the re-stitched raw content on success, or null if the retry failed. */
export async function retryStitchedParse(
  cwd: string,
  raw: string,
  signal: AbortSignal | undefined,
  callModel: (prompt: string) => Promise<{ content: string; usage: UsageCost }>,
): Promise<{ raw: string; usage: UsageCost } | null> {
  if (signal?.aborted) throw new Error("Aborted");
  const tail = raw.slice(-2000);
  const prompt = `${POST_STITCH_RETRY_PROMPT}\n\n=== Last content (do not repeat) ===\n${tail}`;
  try {
    const { content, usage } = await callModel(prompt);
    if (content.trim().length === 0) {
      logEvent(cwd, "info", "Post-stitch validation retry returned no additional content", {});
      return { raw, usage };
    }
    const deduped = stripRetryOverlap(raw, content);
    logEvent(cwd, "info", "Post-stitch validation retry returned content", { appendedChars: deduped.length });
    return { raw: raw + deduped, usage };
  } catch (err) {
    if (signal?.aborted) throw err;
    logEvent(cwd, "warn", "Post-stitch validation retry failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
