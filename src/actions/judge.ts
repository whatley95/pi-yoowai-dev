import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadHeyyooConfig, resolveTaskModel } from "../config.js";
import { loadConventions, formatConventions } from "../conventions.js";
import { callSecondaryModel, providerSupportsJsonObject } from "../secondary-model.js";
import {
  buildJudgePrompt,
  validateJudgeResult,
  getJudgeValidationErrors,
  salvageJudgeFromMarkdown,
} from "../prompts.js";
import { getPastIssuesForFiles } from "../review-memory.js";
import { getState, buildReviewHistory } from "../session-state.js";
import { STAGES, secondaryModelLabel, recordCostWithBudget, parseStructuredResult } from "./shared.js";
import type { ProgressReporter } from "../progress.js";
import type { YooToolResult } from "../types.js";

export async function executeYooJudge(
  cwd: string,
  description: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: ExtensionContext["sessionManager"],
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  const modelConfig = resolveTaskModel(config, "judge");
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "judge", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }
  const nativeJson = providerSupportsJsonObject(modelConfig.provider, modelConfig.id, modelConfig);

  const state = getState(cwd);
  const reviewHistory = buildReviewHistory(cwd);
  progress(1, STAGES.judge, "Building review history…");

  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";
  const memoryContext = getPastIssuesForFiles(cwd, []);

  const { system, user } = buildJudgePrompt(
    description,
    state.plan?.todo,
    state.plan?.acceptanceCriteria,
    reviewHistory,
    conventionsText,
    undefined,
    memoryContext,
    nativeJson,
  );

  progress(2, STAGES.judge, `Calling ${secondaryModelLabel(modelConfig)}…`);
  const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
    signal,
    thinking: modelConfig.thinking,
    cwd,
    sessionManager,
    task: "judge",
    structuredOutput: true,
  });

  progress(3, STAGES.judge, "Parsing judgment…");
  const cost = recordCostWithBudget(cwd, usage);
  const judge = parseStructuredResult(cwd, raw, {
    label: "Judgment",
    validate: validateJudgeResult,
    validationErrors: getJudgeValidationErrors,
    salvage: salvageJudgeFromMarkdown,
    salvageDetails: (salvaged) => ({
      verdict: salvaged.verdict,
      suggestionCount: salvaged.suggestions.length,
    }),
  });
  if (!judge) {
    return {
      action: "judge",
      error: "Failed to parse judgment from secondary model response.",
      cost,
    };
  }

  return { action: "judge", judge, cost };
}
