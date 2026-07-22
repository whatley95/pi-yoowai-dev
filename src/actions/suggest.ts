import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadHeyyooConfig, resolveTaskModel } from "../config.js";
import { loadConventions, formatConventions } from "../conventions.js";
import { findRelevantFiles } from "../project-index.js";
import { loadRelevantFileContents } from "../project-snapshot.js";
import { callSecondaryModel, providerSupportsJsonObject } from "../secondary-model.js";
import { resolveBackendType } from "../backends/backend-resolver.js";
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
  continuationMeta,
  retryStitchedParse,
  mergeUsageCost,
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
  const modelProfile = {
    provider: modelConfig.provider,
    id: modelConfig.id,
    thinking: modelConfig.thinking,
    backend: resolveBackendType(modelConfig.provider, modelConfig),
  };
  const nativeJson = providerSupportsJsonObject(modelConfig.provider, modelConfig.id, modelConfig);

  progress(1, STAGES.suggest, "Loading project conventions and relevant files…");
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";

  const relevantFiles = findRelevantFiles(cwd, question, 5);
  if (relevantFiles.length === 0) {
    logEvent(cwd, "info", "yoo suggest found no indexed relevant files; consider running yoo scan deep", {
      query: question.slice(0, 200),
    });
  }
  const fileContents = loadRelevantFileContents(
    cwd,
    relevantFiles.map((f) => f.file),
  );

  let docContext = "";
  if (docRequest.docs?.length) {
    progress(2, STAGES.suggest, "Fetching external docs…");
    docContext = await loadDocContext(cwd, config.docs, docRequest);
  }

  const { system, user } = buildSuggestPrompt(question, conventionsText, nativeJson, docContext, fileContents);
  progress(2, STAGES.suggest, `Calling ${secondaryModelLabel(modelConfig)}…`);
  let raw: string;
  let usage: UsageCost;
  let rounds: number | undefined;
  let finalTruncated: boolean | undefined;
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
    rounds = result.rounds;
    finalTruncated = result.truncated;
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
  let cost = recordCostWithBudget(cwd, usage);
  let suggest = parseStructuredResult(cwd, raw, {
    label: "Suggestions",
    validate: validateSuggestResult,
    validationErrors: getSuggestValidationErrors,
    salvage: salvageSuggestFromMarkdown,
    salvageDetails: (salvaged) => ({ approachCount: salvaged.approaches.length }),
  });

  // When the stitched output fails to parse and continuation rounds were used,
  // retry once with a validation-tail prompt to recover from mid-structure splices.
  if (!suggest && rounds && rounds > 0) {
    const retryResult = await retryStitchedParse(cwd, raw, signal, async (prompt) => {
      const result = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, prompt, {
        signal,
        thinking: modelConfig.thinking,
        cwd,
        sessionManager,
        task: "suggest",
        structuredOutput: true,
      });
      return result;
    });
    if (retryResult) {
      // Re-record only the retry's incremental cost to avoid double-counting.
      const retryCost = recordCostWithBudget(cwd, retryResult.usage);
      cost = mergeUsageCost(cost, retryCost);
      suggest = parseStructuredResult(cwd, retryResult.raw, {
        label: "Suggestions (post-stitch retry)",
        validate: validateSuggestResult,
        validationErrors: getSuggestValidationErrors,
        salvage: salvageSuggestFromMarkdown,
        salvageDetails: (salvaged) => ({ approachCount: salvaged.approaches.length }),
      });
      if (suggest) {
        logEvent(cwd, "info", "Post-stitch validation retry succeeded", {
          approaches: suggest.approaches.length,
        });
      } else {
        logEvent(cwd, "warn", "Post-stitch validation retry returned content that still did not parse", {
          rawLength: retryResult.raw.length,
        });
      }
    }
  }
  if (!suggest) {
    return {
      action: "suggest",
      error: "Failed to parse suggestions from secondary model response.",
      cost,
      model: modelProfile,
    };
  }

  return {
    action: "suggest",
    suggest,
    cost,
    model: modelProfile,
    continuation: continuationMeta(rounds, finalTruncated ?? false),
  };
}
