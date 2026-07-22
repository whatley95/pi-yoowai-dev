import { resolveApiKey } from "./auth-reader.js";
import { loadHeyyooConfig, resolveTaskModel } from "./config.js";
import { formatCost, getSessionCost } from "./cost-tracker.js";
import { logEvent } from "./logger.js";
import { resolveModelInfo } from "./model-registry.js";
import { executeToolLoop } from "./tool-loop.js";
import { mergeUsageCost } from "./actions/shared.js";
import {
  callHttpBackend,
  callPiBackend,
  callSdkBackend,
  clearPiSessionId,
  estimateCost,
  estimateTokens,
  getProviderApiInfo,
  getSupportedProviders,
  providerSupportsJsonObject,
  resolveBackend,
  setPiSessionId,
  setPiSpawnResolver,
  setSdkGetModelOverride,
  setSdkStreamSimpleOverride,
} from "./backends/index.js";
import type { CallSecondaryModelOptions, UsageCost } from "./types.js";
import type { SecondaryModelConfig } from "./types/secondary-model.js";
import type { HeyyooConfig } from "./types.js";

export {
  estimateCost,
  getProviderApiInfo,
  providerSupportsJsonObject,
  setPiSessionId,
  clearPiSessionId,
  setPiSpawnResolver,
  setSdkStreamSimpleOverride,
  setSdkGetModelOverride,
};

function isRetryableBackendError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("504") ||
    msg.includes("temporarily unavailable") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("network error") ||
    msg.includes("fetch failed")
  );
}

function isMissingApiKeyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("no api key") || msg.includes("api key not found") || msg.includes("missing api key");
}

type ModelAttempt = {
  provider: string;
  model: string;
  thinking?: string;
  secondary: SecondaryModelConfig | undefined;
};

export async function callSecondaryModel(
  provider: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options: CallSecondaryModelOptions = {},
): Promise<{ content: string; usage: UsageCost; rounds?: number; truncated?: boolean }> {
  const { thinking: optionsThinking, cwd, task } = options;
  const config = cwd ? loadHeyyooConfig(cwd) : undefined;
  const effectiveSecondary = config && task ? resolveTaskModel(config, task) : config?.secondary;

  const attempts: ModelAttempt[] = [
    {
      provider: (effectiveSecondary?.provider || provider).toLowerCase(),
      model: effectiveSecondary?.id || model,
      thinking: optionsThinking ?? effectiveSecondary?.thinking,
      secondary: effectiveSecondary,
    },
  ];
  for (const fallback of config?.secondaryFallback ?? []) {
    attempts.push({
      provider: (fallback.provider || provider).toLowerCase(),
      model: fallback.id || model,
      thinking: fallback.thinking ?? effectiveSecondary?.thinking,
      secondary: fallback,
    });
  }

  const lastErrors: string[] = [];
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    try {
      return await runSingleAttempt(attempt, systemPrompt, userPrompt, options, config, cwd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastErrors.push(`${attempt.provider}:${attempt.model} -> ${msg}`);
      if (cwd) {
        logEvent(cwd, "warn", "Secondary model attempt failed", {
          provider: attempt.provider,
          model: attempt.model,
          attempt: i + 1,
          total: attempts.length,
          error: msg,
        });
      }
    }
  }

  throw new Error(`All secondary model attempts failed: ${lastErrors.join("; ")}`);
}

async function runSingleAttempt(
  attempt: ModelAttempt,
  systemPrompt: string,
  userPrompt: string,
  options: CallSecondaryModelOptions,
  config: HeyyooConfig | undefined,
  cwd: string | undefined,
): Promise<{ content: string; usage: UsageCost; rounds?: number; truncated?: boolean }> {
  const { provider, model, thinking, secondary } = attempt;

  const { backend, apiInfo, sdkModelInfo, modelInfoOverride } = await resolveBackend(
    provider,
    model,
    secondary,
    config?.modelInfo,
  );

  const thinkingEnabledForBudget = Boolean(thinking) && thinking?.toLowerCase() !== "off";
  const modelInfoForBudget = cwd ? resolveModelInfo(provider, model, sdkModelInfo ?? modelInfoOverride) : undefined;

  if (cwd) {
    const budgetUsd = config?.costBudgetUsd;
    if (budgetUsd !== undefined && budgetUsd >= 0) {
      const estimatedInputTokens = estimateTokens(systemPrompt + userPrompt);
      const estimatedOutputTokens = thinkingEnabledForBudget ? (modelInfoForBudget?.maxOutputTokens ?? 8192) : 2048;
      const projectedCost = estimateCost(provider, model, estimatedInputTokens, estimatedOutputTokens);
      const sessionCost = getSessionCost(cwd).costUsd;
      if (sessionCost + projectedCost > budgetUsd) {
        throw new Error(
          `yoo call would exceed cost budget: projected ${formatCost(sessionCost + projectedCost)} / ${formatCost(budgetUsd)}. ` +
            `Increase pi-heyyoo.costBudgetUsd in settings or use /yoo-clear to reset.`,
        );
      }
    }
  }

  const doCall = async (
    sys: string,
    user: string,
    opts: Omit<CallSecondaryModelOptions, "enableToolLoop" | "maxToolIterations">,
  ): Promise<{ content: string; usage: UsageCost }> => {
    try {
      if (backend === "pi") {
        return await callPiBackend(provider, model, sys, user, {
          signal: opts.signal,
          thinking,
          cwd: opts.cwd,
          sessionManager: opts.sessionManager,
          relevantPaths: opts.relevantPaths,
        });
      }

      if (backend === "sdk") {
        return await callSdkBackend(provider, model, sys, user, {
          signal: opts.signal,
          thinking,
          cwd: opts.cwd,
          sessionManager: opts.sessionManager,
          secondary,
          modelInfoOverride,
          sdkModelInfo,
          structuredOutput: opts.structuredOutput,
          onStreamProgress: opts.onStreamProgress,
        });
      }

      if (!apiInfo) {
        throw new Error(
          `Unknown provider: ${provider}. Supported providers: ${getSupportedProviders().join(", ")}. ` +
            `Or set pi-heyyoo.secondary.baseUrl to use any OpenAI-compatible or Anthropic-compatible endpoint.`,
        );
      }

      const apiKey = resolveApiKey(provider, secondary?.apiKey);
      if (!apiKey) {
        throw new Error(
          `No API key found for provider "${provider}". Set the appropriate environment variable, configure auth.json, ` +
            `or set pi-heyyoo.secondary.apiKey.`,
        );
      }

      return await callHttpBackend(
        provider,
        apiInfo,
        apiKey,
        model,
        sys,
        user,
        opts.signal,
        thinking,
        modelInfoOverride,
        opts.cwd,
        opts.structuredOutput,
      );
    } catch (err) {
      if (backend === "sdk" && (isRetryableBackendError(err) || isMissingApiKeyError(err))) {
        if (cwd) {
          logEvent(cwd, "warn", "SDK backend failed; falling back to pi backend", {
            provider,
            model,
            thinking,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        try {
          return await callPiBackend(provider, model, sys, user, {
            signal: opts.signal,
            thinking,
            cwd: opts.cwd,
            sessionManager: opts.sessionManager,
            relevantPaths: opts.relevantPaths,
          });
        } catch (piErr) {
          const sdkMsg = err instanceof Error ? err.message : String(err);
          const piMsg = piErr instanceof Error ? piErr.message : String(piErr);
          const combined = new Error(`SDK backend failed: ${sdkMsg}; pi fallback also failed: ${piMsg}`);
          if (cwd) {
            logEvent(cwd, "error", combined.message, {
              provider,
              model,
              thinking,
              promptTokensEstimate: Math.ceil((sys.length + user.length) / 4),
              backend: "sdk->pi",
            });
          }
          throw combined;
        }
      }

      if (cwd) {
        logEvent(cwd, "error", err instanceof Error ? err.message : String(err), {
          provider,
          model,
          thinking,
          promptTokensEstimate: Math.ceil((sys.length + user.length) / 4),
          backend,
        });
      }
      throw err;
    }
  };

  if (options.enableToolLoop && cwd) {
    // NOTE: The tool-loop path is intentionally excluded from continuation handling.
    // It manages its own multi-turn flow (tool requests/results) and decides when the
    // final structured result is complete, so length-truncation continuation does not apply.
    const result = await executeToolLoop(cwd, systemPrompt, userPrompt, options, doCall, options.maxToolIterations);
    return { ...result, rounds: 0 };
  }

  const maxContinuations =
    typeof config?.maxContinuations === "number" && config.maxContinuations >= 0
      ? Math.floor(config.maxContinuations)
      : DEFAULT_MAX_CONTINUATIONS;

  return callWithContinuation(
    cwd,
    provider,
    model,
    systemPrompt,
    userPrompt,
    options,
    doCall,
    maxContinuations,
    config?.costBudgetUsd,
  );
}

const DEFAULT_MAX_CONTINUATIONS = 3;
const RESUME_ANCHOR_CHARS = 2000;
const MIN_PROGRESS_CHARS = 16;

const CONTINUATION_INSTRUCTION =
  "Continue your previous response exactly where it left off. Do not repeat what you already wrote; output only the remaining content. If the response was already complete, output nothing.";

/**
 * Detect length-truncated backend responses and concatenate continuation calls
 * so callers receive a complete response. Up to `maxContinuations` (default
 * DEFAULT_MAX_CONTINUATIONS) follow-up calls
 * are made; after that the best-effort concatenated content is returned with a
 * warning logged. Continuation is skipped when the tool-use loop is enabled,
 * because the tool-loop handles its own multi-turn flow.
 */
async function callWithContinuation(
  cwd: string | undefined,
  provider: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options: CallSecondaryModelOptions,
  doCall: (
    sys: string,
    user: string,
    opts: Omit<CallSecondaryModelOptions, "enableToolLoop" | "maxToolIterations">,
  ) => Promise<{ content: string; usage: UsageCost; truncated?: boolean }>,
  maxContinuations: number,
  costBudgetUsd: number | undefined,
): Promise<{ content: string; usage: UsageCost; rounds: number; truncated: boolean }> {
  const {
    content: firstContent,
    usage: firstUsage,
    truncated: firstTruncated,
  } = await doCall(systemPrompt, userPrompt, options);
  if (!firstTruncated) return { content: firstContent, usage: firstUsage, rounds: 0, truncated: false };

  return runContinuationLoop(
    cwd,
    provider,
    model,
    systemPrompt,
    options,
    doCall,
    maxContinuations,
    costBudgetUsd,
    firstContent,
    firstUsage,
    true,
  );
}

async function runContinuationLoop(
  cwd: string | undefined,
  provider: string,
  model: string,
  systemPrompt: string,
  options: CallSecondaryModelOptions,
  doCall: (
    sys: string,
    user: string,
    opts: Omit<CallSecondaryModelOptions, "enableToolLoop" | "maxToolIterations">,
  ) => Promise<{ content: string; usage: UsageCost; truncated?: boolean }>,
  maxContinuations: number,
  costBudgetUsd: number | undefined,
  combined: string,
  totalUsage: UsageCost,
  truncated: boolean,
): Promise<{ content: string; usage: UsageCost; rounds: number; truncated: boolean }> {
  // Capture the session cost once at the start; the action executor records cost
  // AFTER callSecondaryModel returns, so getSessionCost won't reflect in-flight calls.
  // We track the continuation's own accumulated cost via totalUsage.estimatedCostUsd.
  const sessionCostAtStart = cwd ? getSessionCost(cwd).costUsd : 0;
  let rounds = 0;
  for (let i = 0; i < maxContinuations && truncated; i++) {
    rounds++;
    // Re-check the cost budget between rounds so continuation cannot silently
    // exceed costBudgetUsd (the pre-check in runSingleAttempt only estimates one call).
    if (cwd && costBudgetUsd !== undefined && costBudgetUsd >= 0) {
      const inFlightCost = sessionCostAtStart + totalUsage.estimatedCostUsd;
      if (inFlightCost > costBudgetUsd) {
        logEvent(cwd, "warn", "Continuation stopped; cost budget reached", {
          provider,
          model,
          continuation: i + 1,
          inFlightCostUsd: formatCost(inFlightCost),
          budgetUsd: formatCost(costBudgetUsd),
        });
        return { content: combined, usage: totalUsage, rounds: rounds - 1, truncated: true };
        // stopCause: budget-exceeded
      }
    }

    if (cwd) {
      logEvent(cwd, "info", "Secondary model response truncated; issuing continuation call", {
        provider,
        model,
        continuation: i + 1,
        max: maxContinuations,
      });
    }

    // Echo only the tail of the accumulated content as a resume anchor to avoid
    // quadratic input-token growth across rounds.
    const anchor = combined.slice(-RESUME_ANCHOR_CHARS);
    const continued = `${CONTINUATION_INSTRUCTION}\n\n=== Last content (do not repeat) ===\n${anchor}`;
    let nextResult: { content: string; usage: UsageCost; truncated?: boolean };
    try {
      nextResult = await doCall(systemPrompt, continued, options);
    } catch (err) {
      if (cwd) {
        logEvent(cwd, "warn", "Continuation call failed; returning best-effort content", {
          provider,
          model,
          continuation: i + 1,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return { content: combined, usage: totalUsage, rounds: rounds - 1, truncated: true };
      // stopCause: error
    }
    const nextContent = nextResult.content ?? "";
    if (nextContent.trim().length === 0) {
      // The model reported it had nothing more to add. Merge usage and stop; re-sending
      // the same prompt would burn another call for no new content.
      totalUsage = mergeUsageCost(totalUsage, nextResult.usage);
      truncated = false;
      break;
    }
    // Avoid accidental duplication: drop a leading overlap of the same text.
    const deduped = stripLeadingOverlap(combined, nextContent);
    combined += deduped;
    truncated = nextResult.truncated ?? false;
    totalUsage = mergeUsageCost(totalUsage, nextResult.usage);

    if (cwd) {
      logEvent(cwd, "info", "Continuation round complete", {
        provider,
        model,
        round: i + 1,
        charsAppended: deduped.length,
        stillTruncated: truncated,
        stopReason: truncated ? "continuing" : "complete",
        cumulativeCost: formatCost(totalUsage.estimatedCostUsd),
      });
    }

    // No-progress guard: if this round added almost nothing after dedup, stop
    // to avoid burning the remaining rounds for no gain.
    if (deduped.trim().length < MIN_PROGRESS_CHARS) {
      truncated = false;
      if (cwd) {
        logEvent(cwd, "info", "Continuation made no progress; stopping early", {
          provider,
          model,
          continuation: i + 1,
          addedChars: deduped.length,
        });
      }
      break;
    }
  }

  if (truncated && cwd) {
    logEvent(cwd, "warn", "Secondary model still truncated after max continuations; returning best-effort content", {
      provider,
      model,
      max: maxContinuations,
    });
  }
  return { content: combined, usage: totalUsage, rounds, truncated };
}

/** Remove a leading prefix of `previous` from `next` so continuation content is not duplicated.
 *  First tries an exact match (preserves boundary spacing exactly). If no exact match
 *  is found, falls back to a whitespace-normalized match that trims the candidate so a
 *  model re-emitting with slightly different internal spacing still dedups — but the
 *  slice length is reduced to the trimmed length so a trailing boundary space is kept. */
/** @internal exported for tests */
export function stripLeadingOverlap(previous: string, next: string): string {
  const maxOverlap = Math.min(previous.length, next.length, 200);
  // Exact match first — preserves spacing at the boundary precisely.
  for (let len = maxOverlap; len > 0; len--) {
    if (previous.endsWith(next.slice(0, len))) {
      return next.slice(len);
    }
  }
  // Whitespace-normalized fallback for internal spacing differences.
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
  const prevNorm = norm(previous);
  for (let len = maxOverlap; len > 0; len--) {
    const candidate = next.slice(0, len);
    const candidateNorm = norm(candidate);
    if (candidateNorm.length === 0) continue;
    if (prevNorm.endsWith(candidateNorm)) {
      // Slice at the end of the trimmed candidate in original-string coordinates so
      // internal whitespace runs (collapsed by norm) don't throw off the offset. This
      // keeps any trailing whitespace in the candidate in the output (boundary spacing
      // preserved) and is immune to internal whitespace collapse.
      const end = candidate.trimEnd().length;
      return next.slice(end);
    }
  }
  return next;
}
