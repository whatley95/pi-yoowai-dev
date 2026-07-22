import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadHeyyooConfig, resolveTaskModel } from "../config.js";
import { loadConventions, formatConventions } from "../conventions.js";
import { buildProjectSnapshot, formatProjectSnapshot } from "../project-snapshot.js";
import { callSecondaryModel } from "../secondary-model.js";
import { resolveBackendType } from "../backends/backend-resolver.js";
import { buildPlanPrompt, validatePlanResult, getPlanValidationErrors, salvagePlanFromMarkdown } from "../prompts.js";
import { setPlan } from "../session-state.js";
import {
  STAGES,
  secondaryModelLabel,
  recordCostWithBudget,
  parseStructuredResult,
  createStreamProgressCallback,
  continuationMeta,
} from "./shared.js";
import { logEvent } from "../logger.js";
import type { ProgressReporter } from "../progress.js";
import type { YooToolResult, UsageCost, YooModelTask } from "../types.js";

export async function executeYooPlan(
  cwd: string,
  task: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: ExtensionContext["sessionManager"],
  modelTask: YooModelTask = "plan",
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  const modelConfig = resolveTaskModel(config, modelTask);
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "plan", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }
  const modelProfile = {
    provider: modelConfig.provider,
    id: modelConfig.id,
    thinking: modelConfig.thinking,
    backend: resolveBackendType(modelConfig.provider, modelConfig),
  };

  progress(1, STAGES.plan, "Loading project conventions and snapshot…");
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";
  const snapshot = buildProjectSnapshot(cwd);
  const snapshotText = formatProjectSnapshot(snapshot);

  progress(2, STAGES.plan, `Calling ${secondaryModelLabel(modelConfig)}…`);
  const { system, user } = buildPlanPrompt(task, conventionsText, snapshotText);
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
      task: modelTask,
      structuredOutput: true,
      onStreamProgress: createStreamProgressCallback(progress, 2, STAGES.plan),
    });
    raw = result.content;
    usage = result.usage;
    rounds = result.rounds;
    finalTruncated = result.truncated;
  } catch (err) {
    if (signal?.aborted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    logEvent(cwd, "error", "yoo tool plan failed", { error: msg });
    return {
      action: "plan",
      error: `Secondary model unavailable: ${msg.slice(0, 200)}. Try again or configure a different model via /yoo-model.`,
      model: modelProfile,
    };
  }

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
      model: modelProfile,
    };
  }

  setPlan(cwd, plan);
  return {
    action: "plan",
    plan,
    cost,
    model: modelProfile,
    continuation: continuationMeta(rounds, finalTruncated ?? false),
  };
}
