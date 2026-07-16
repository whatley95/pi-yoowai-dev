import { resolveApiKey } from "./auth-reader.js";
import { loadHeyyooConfig, resolveTaskModel } from "./config.js";
import { formatCost, getSessionCost } from "./cost-tracker.js";
import { logEvent } from "./logger.js";
import { resolveModelInfo } from "./model-registry.js";
import { executeToolLoop } from "./tool-loop.js";
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
): Promise<{ content: string; usage: UsageCost }> {
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
): Promise<{ content: string; usage: UsageCost }> {
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
      if (backend === "sdk" && isRetryableBackendError(err)) {
        if (cwd) {
          logEvent(cwd, "warn", "SDK backend failed with retryable error; falling back to pi backend", {
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
    return executeToolLoop(cwd, systemPrompt, userPrompt, options, doCall, options.maxToolIterations);
  }

  return doCall(systemPrompt, userPrompt, options);
}
