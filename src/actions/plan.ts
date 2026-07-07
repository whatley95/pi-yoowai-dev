import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadHeyyooConfig, resolveTaskModel } from "../config.js";
import { loadConventions, formatConventions } from "../conventions.js";
import { callSecondaryModel } from "../secondary-model.js";
import { buildPlanPrompt, validatePlanResult, getPlanValidationErrors, salvagePlanFromMarkdown } from "../prompts.js";
import { setPlan } from "../session-state.js";
import { STAGES, secondaryModelLabel, recordCostWithBudget, parseStructuredResult } from "./shared.js";
import type { ProgressReporter } from "../progress.js";
import type { YooToolResult } from "../types.js";

export async function executeYooPlan(
  cwd: string,
  task: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: ExtensionContext["sessionManager"],
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  const modelConfig = resolveTaskModel(config, "plan");
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "plan", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }

  progress(1, STAGES.plan, "Loading project conventions…");
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";

  progress(2, STAGES.plan, `Calling ${secondaryModelLabel(modelConfig)}…`);
  const { system, user } = buildPlanPrompt(task, conventionsText);
  const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
    signal,
    thinking: modelConfig.thinking,
    cwd,
    sessionManager,
    task: "plan",
  });

  progress(3, STAGES.plan, "Parsing plan…");
  const cost = recordCostWithBudget(cwd, usage);
  const plan = parseStructuredResult(cwd, raw, {
    label: "Plan",
    validate: validatePlanResult,
    validationErrors: getPlanValidationErrors,
    salvage: (text) => salvagePlanFromMarkdown(text, task),
    salvageDetails: (salvaged) => ({
      todoCount: salvaged.todo.length,
      summary: salvaged.summary.slice(0, 100),
    }),
  });

  if (!plan) {
    return {
      action: "plan",
      error: "Failed to parse plan from secondary model response.",
      plan: { todo: [task], acceptanceCriteria: [], summary: raw.slice(0, 200) },
      cost,
    };
  }

  setPlan(cwd, plan);
  return { action: "plan", plan, cost };
}
