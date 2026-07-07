import { resolveApiKey } from "./auth-reader.js";
import { loadHeyyooConfig, resolveTaskModel } from "./config.js";
import { formatCost, getSessionCost, getReservedCost } from "./cost-tracker.js";
import { logEvent } from "./logger.js";
import { resolveModelInfo } from "./model-registry.js";
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

export async function callSecondaryModel(
  provider: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options: CallSecondaryModelOptions = {},
): Promise<{ content: string; usage: UsageCost }> {
  const { signal, thinking: optionsThinking, cwd, sessionManager, relevantPaths, task, structuredOutput } = options;
  const config = cwd ? loadHeyyooConfig(cwd) : undefined;
  const effectiveSecondary = config && task ? resolveTaskModel(config, task) : config?.secondary;
  provider = (effectiveSecondary?.provider || provider).toLowerCase();
  model = effectiveSecondary?.id || model;
  const thinking = optionsThinking ?? effectiveSecondary?.thinking;

  const { backend, apiInfo, sdkModelInfo, modelInfoOverride } = await resolveBackend(
    provider,
    model,
    effectiveSecondary,
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
      const sessionCost = getSessionCost(cwd).costUsd + getReservedCost(cwd);
      if (sessionCost + projectedCost > budgetUsd) {
        throw new Error(
          `yoo call would exceed cost budget: projected ${formatCost(sessionCost + projectedCost)} / ${formatCost(budgetUsd)}. ` +
            `Increase pi-heyyoo.costBudgetUsd in settings or use /yoo-clear to reset.`,
        );
      }
    }
  }

  try {
    if (backend === "pi") {
      return await callPiBackend(provider, model, systemPrompt, userPrompt, {
        signal,
        thinking,
        cwd,
        sessionManager,
        relevantPaths,
      });
    }

    if (backend === "sdk") {
      return await callSdkBackend(provider, model, systemPrompt, userPrompt, {
        signal,
        thinking,
        cwd,
        sessionManager,
        secondary: effectiveSecondary,
        modelInfoOverride,
        sdkModelInfo,
      });
    }

    if (!apiInfo) {
      throw new Error(
        `Unknown provider: ${provider}. Supported providers: ${getSupportedProviders().join(", ")}. ` +
          `Or set pi-heyyoo.secondary.baseUrl to use any OpenAI-compatible or Anthropic-compatible endpoint.`,
      );
    }

    const apiKey = resolveApiKey(provider, effectiveSecondary?.apiKey);
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
      systemPrompt,
      userPrompt,
      signal,
      thinking,
      modelInfoOverride,
      cwd,
      structuredOutput,
    );
  } catch (err) {
    if (cwd) {
      logEvent(cwd, "error", err instanceof Error ? err.message : String(err), {
        provider,
        model,
        thinking,
        promptTokensEstimate: Math.ceil((systemPrompt.length + userPrompt.length) / 4),
        backend,
      });
    }
    throw err;
  }
}
