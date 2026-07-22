import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadHeyyooConfig, resolveTaskModel } from "../config.js";
import { loadConventions, formatConventions } from "../conventions.js";
import { findRelevantFiles } from "../project-index.js";
import { loadRelevantFileContents } from "../project-snapshot.js";
import { callSecondaryModel, providerSupportsJsonObject } from "../secondary-model.js";
import { resolveBackendType } from "../backends/backend-resolver.js";
import {
  buildRecommendPrompt,
  validateRecommendResult,
  getRecommendValidationErrors,
  salvageRecommendFromMarkdown,
} from "../prompts.js";
import { logEvent } from "../logger.js";
import { getState, getProgress } from "../session-state.js";
import { getPastIssuesForFiles } from "../review-memory.js";
import { loadDocContext, type DocContextRequest } from "../doc-fetcher.js";
import {
  STAGES,
  secondaryModelLabel,
  recordCostWithBudget,
  parseStructuredResult,
  createStreamProgressCallback,
  continuationMeta,
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
  const modelProfile = {
    provider: modelConfig.provider,
    id: modelConfig.id,
    thinking: modelConfig.thinking,
    backend: resolveBackendType(modelConfig.provider, modelConfig),
  };
  const nativeJson = providerSupportsJsonObject(modelConfig.provider, modelConfig.id, modelConfig);

  const state = getState(cwd);
  const progressInfo = getProgress(cwd);
  const currentStep = progressInfo.nextStep;

  progress(1, STAGES.recommend, "Loading project conventions and relevant files…");
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";

  const relevantFiles = findRelevantFiles(cwd, situation, 5);
  if (relevantFiles.length === 0) {
    logEvent(cwd, "info", "yoo recommend found no indexed relevant files; consider running yoo scan deep", {
      query: situation.slice(0, 200),
    });
  }
  const fileContents = loadRelevantFileContents(
    cwd,
    relevantFiles.map((f) => f.file),
  );

  const memoryFiles = relevantFiles.map((f) => f.file);
  const memoryContext = getPastIssuesForFiles(cwd, memoryFiles.length > 0 ? memoryFiles : []);

  let docContext = "";
  if (docRequest.docs?.length) {
    progress(2, STAGES.recommend, "Fetching external docs…");
    docContext = await loadDocContext(cwd, config.docs, docRequest);
  }

  const { system, user } = buildRecommendPrompt(
    situation,
    state.plan?.todo,
    conventionsText,
    nativeJson,
    docContext,
    fileContents,
    currentStep,
    memoryContext,
  );
  progress(2, STAGES.recommend, `Calling ${secondaryModelLabel(modelConfig)}…`);
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
      task: "recommend",
      structuredOutput: true,
      onStreamProgress: createStreamProgressCallback(progress, 2, STAGES.recommend),
    });
    raw = result.content;
    usage = result.usage;
    rounds = result.rounds;
    finalTruncated = result.truncated;
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

  return {
    action: "recommend",
    recommend,
    cost,
    model: modelProfile,
    continuation: continuationMeta(rounds, finalTruncated ?? false),
  };
}
