import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadHeyyooConfig, resolveTaskModel } from "../config.js";
import { loadConventions, formatConventions } from "../conventions.js";
import { callSecondaryModel, providerSupportsJsonObject } from "../secondary-model.js";
import {
  buildRecommendPrompt,
  validateRecommendResult,
  getRecommendValidationErrors,
  salvageRecommendFromMarkdown,
} from "../prompts.js";
import { logEvent } from "../logger.js";
import { getState } from "../session-state.js";
import { loadDocContext, type DocContextRequest } from "../doc-fetcher.js";
import {
  STAGES,
  secondaryModelLabel,
  recordCostWithBudget,
  parseStructuredResult,
  createStreamProgressCallback,
} from "./shared.js";
import type { ProgressReporter } from "../progress.js";
import type { YooToolResult, UsageCost } from "../types.js";

export async function executeYooRecommend(
  cwd: string,
  situation: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: ExtensionContext["sessionManager"],
  docRequest: DocContextRequest = {},
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  const modelConfig = resolveTaskModel(config, "recommend");
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "recommend", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }
  const modelProfile = { provider: modelConfig.provider, id: modelConfig.id, thinking: modelConfig.thinking };
  const nativeJson = providerSupportsJsonObject(modelConfig.provider, modelConfig.id, modelConfig);

  const state = getState(cwd);

  progress(1, STAGES.recommend, "Loading project conventions…");
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";

  let docContext = "";
  if (docRequest.docs?.length) {
    progress(2, STAGES.recommend, "Fetching external docs…");
    docContext = await loadDocContext(cwd, config.docs, docRequest);
  }

  const { system, user } = buildRecommendPrompt(situation, state.plan?.todo, conventionsText, nativeJson, docContext);
  progress(2, STAGES.recommend, `Calling ${secondaryModelLabel(modelConfig)}…`);
  let raw: string;
  let usage: UsageCost;
  try {
    const result = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
      signal,
      thinking: modelConfig.thinking,
      cwd,
      sessionManager,
      task: "recommend",
      structuredOutput: true,
      onStreamProgress: createStreamProgressCallback(progress, 2, STAGES.recommend),
    });
    raw = result.content;
    usage = result.usage;
  } catch (err) {
    if (signal?.aborted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    logEvent(cwd, "error", "yoo tool recommend failed", { error: msg });
    return {
      action: "recommend",
      error: `Secondary model unavailable: ${msg.slice(0, 200)}. Try again or configure a different model via /yoo-model.`,
      model: modelProfile,
    };
  }

  progress(3, STAGES.recommend, "Parsing recommendation…");
  const cost = recordCostWithBudget(cwd, usage);
  const recommend = parseStructuredResult(cwd, raw, {
    label: "Recommendation",
    validate: validateRecommendResult,
    validationErrors: getRecommendValidationErrors,
    salvage: salvageRecommendFromMarkdown,
    salvageDetails: (salvaged) => ({
      nextStep: salvaged.nextStep.slice(0, 100),
      alternativeCount: salvaged.alternatives.length,
    }),
  });

  if (!recommend) {
    return {
      action: "recommend",
      error: "Failed to parse recommendation from secondary model response.",
      cost,
      model: modelProfile,
    };
  }

  return { action: "recommend", recommend, cost, model: modelProfile };
}
