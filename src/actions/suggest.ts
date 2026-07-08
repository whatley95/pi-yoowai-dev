import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadHeyyooConfig, resolveTaskModel } from "../config.js";
import { loadConventions, formatConventions } from "../conventions.js";
import { callSecondaryModel, providerSupportsJsonObject } from "../secondary-model.js";
import {
  buildSuggestPrompt,
  validateSuggestResult,
  getSuggestValidationErrors,
  salvageSuggestFromMarkdown,
} from "../prompts.js";
import { logEvent } from "../logger.js";
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

export async function executeYooSuggest(
  cwd: string,
  question: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: ExtensionContext["sessionManager"],
  docRequest: DocContextRequest = {},
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  const modelConfig = resolveTaskModel(config, "suggest");
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "suggest", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }
  const modelProfile = { provider: modelConfig.provider, id: modelConfig.id, thinking: modelConfig.thinking };
  const nativeJson = providerSupportsJsonObject(modelConfig.provider, modelConfig.id, modelConfig);

  progress(1, STAGES.suggest, "Loading project conventions…");
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";

  let docContext = "";
  if (docRequest.docs?.length) {
    progress(2, STAGES.suggest, "Fetching external docs…");
    docContext = await loadDocContext(cwd, config.docs, docRequest);
  }

  const { system, user } = buildSuggestPrompt(question, conventionsText, nativeJson, docContext);
  progress(2, STAGES.suggest, `Calling ${secondaryModelLabel(modelConfig)}…`);
  let raw: string;
  let usage: UsageCost;
  try {
    const result = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
      signal,
      thinking: modelConfig.thinking,
      cwd,
      sessionManager,
      task: "suggest",
      structuredOutput: true,
      onStreamProgress: createStreamProgressCallback(progress, 2, STAGES.suggest),
    });
    raw = result.content;
    usage = result.usage;
  } catch (err) {
    if (signal?.aborted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    logEvent(cwd, "error", "yoo tool suggest failed", { error: msg });
    return {
      action: "suggest",
      error: `Secondary model unavailable: ${msg.slice(0, 200)}. Try again or configure a different model via /yoo-model.`,
      model: modelProfile,
    };
  }

  progress(3, STAGES.suggest, "Parsing suggestions…");
  const cost = recordCostWithBudget(cwd, usage);
  const suggest = parseStructuredResult(cwd, raw, {
    label: "Suggestions",
    validate: validateSuggestResult,
    validationErrors: getSuggestValidationErrors,
    salvage: salvageSuggestFromMarkdown,
    salvageDetails: (salvaged) => ({ approachCount: salvaged.approaches.length }),
  });
  if (!suggest) {
    return {
      action: "suggest",
      error: "Failed to parse suggestions from secondary model response.",
      cost,
      model: modelProfile,
    };
  }

  return { action: "suggest", suggest, cost, model: modelProfile };
}
