import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadYoowaiConfig, resolveAdvisorTaskModel } from "../config.js";
import { loadConventions, formatConventions } from "../conventions.js";
import { findRelevantFiles } from "../project-index.js";
import { loadRelevantFileContents } from "../project-snapshot.js";
import { callSecondaryModel } from "../secondary-model.js";
import { resolveBackendType } from "../backends/backend-resolver.js";
import { capActionInstructions } from "../instructions.js";
import { buildAdvisorPrompt } from "../prompts.js";
import { logEvent } from "../logger.js";
import { STAGES, secondaryModelLabel, recordCostWithBudget, createStreamProgressCallback } from "./shared.js";
import type { ProgressReporter } from "../progress.js";
import type { WaiToolResult, UsageCost } from "../types.js";

/** The pair-programming advisor: a lightweight, conversational advice action.
 *  Deliberately cheap: plain-text answer (no JSON contract), no doc fetching,
 *  no structured validation, no tool loop. Model resolution falls back from
 *  the advisor task override to the suggest task override to the base
 *  secondary model (resolveAdvisorTaskModel). */
export async function executeWaiAdvisor(
  cwd: string,
  question: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: ExtensionContext["sessionManager"],
): Promise<WaiToolResult> {
  const config = loadYoowaiConfig(cwd);
  const modelConfig = resolveAdvisorTaskModel(config);
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "advisor", error: "No secondary model configured. Set pi-yoowai.secondary in settings.json." };
  }
  const modelProfile = {
    provider: modelConfig.provider,
    id: modelConfig.id,
    thinking: modelConfig.thinking,
    backend: resolveBackendType(modelConfig.provider, modelConfig),
  };

  progress(1, STAGES.advisor, "Loading project conventions and relevant files…");
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";

  const relevantFiles = findRelevantFiles(cwd, question, 5);
  const fileContents = loadRelevantFileContents(
    cwd,
    relevantFiles.map((f) => f.file),
  );

  const { system, user } = buildAdvisorPrompt(
    question,
    conventionsText,
    fileContents,
    capActionInstructions(cwd, "advisor", config.instructionsMaxTokens ?? 800),
  );
  progress(2, STAGES.advisor, `Calling ${secondaryModelLabel(modelConfig)}…`);
  let raw: string;
  let usage: UsageCost;
  try {
    const result = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
      signal,
      thinking: modelConfig.thinking,
      cwd,
      sessionManager,
      task: "advisor",
      onStreamProgress: createStreamProgressCallback(progress, 2, STAGES.advisor),
    });
    raw = result.content;
    usage = result.usage;
  } catch (err) {
    if (signal?.aborted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    logEvent(cwd, "error", "wai tool advisor failed", { error: msg });
    return {
      action: "advisor",
      error: `Secondary model unavailable: ${msg.slice(0, 200)}. Try again or configure a different model via /wai-model.`,
      model: modelProfile,
    };
  }

  progress(3, STAGES.advisor, "Advice ready.");
  const advice = raw.trim();
  if (!advice) {
    logEvent(cwd, "warn", "Advisor returned an empty response", {
      provider: modelConfig.provider,
      model: modelConfig.id,
    });
    return {
      action: "advisor",
      error: "The advisor returned an empty response. Try again or ask the question differently.",
      model: modelProfile,
    };
  }
  const cost = recordCostWithBudget(cwd, usage);
  return {
    action: "advisor",
    advisor: { advice },
    cost,
    model: modelProfile,
  };
}
