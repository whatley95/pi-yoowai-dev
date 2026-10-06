import {
  resolveAdvisorTaskModel,
  resolveReviewTaskModel,
  resolveTaskModel,
  resolveJudgeCouncilMembers,
  REVIEW_LEVEL_TASKS,
} from "./config.js";
import { resolveReviewLevel } from "./review-level.js";
import type { SecondaryModelConfig, WaiModelTask, YoowaiConfig } from "./types.js";

/** Resolve the model actually used by a role, including the active review depth. */
export function resolveModelTask(
  config: YoowaiConfig,
  task: WaiModelTask,
): { model: SecondaryModelConfig; source: WaiModelTask | "secondary" | "judgeCouncil" } {
  if (task === "judge") {
    const members = resolveJudgeCouncilMembers(config);
    const synthesizer = resolveTaskModel(config, "judge");
    if (members.length === 1 || (members.length > 1 && (!synthesizer.provider || !synthesizer.id))) {
      return { model: members[0], source: "judgeCouncil" };
    }
  }
  if (task === "advisor") {
    const own = config.taskModels?.advisor;
    return {
      model: resolveAdvisorTaskModel(config),
      source: own?.provider || own?.id ? "advisor" : config.taskModels?.suggest ? "suggest" : "secondary",
    };
  }
  if (task === "review" || task === "reviewMin" || task === "reviewMed" || task === "reviewHigh") {
    const level =
      task === "review"
        ? resolveReviewLevel(config)
        : task === "reviewMin"
          ? "min"
          : task === "reviewMed"
            ? "med"
            : "high";
    const depthTask = REVIEW_LEVEL_TASKS[level];
    const own = config.taskModels?.[depthTask];
    return {
      model: resolveReviewTaskModel(config, level),
      source: own?.provider || own?.id ? depthTask : config.taskModels?.review ? "review" : "secondary",
    };
  }
  return { model: resolveTaskModel(config, task), source: config.taskModels?.[task] ? task : "secondary" };
}

/** Labels describe shared and conditional roles rather than promising exclusive use. */
export function modelTaskLabel(task: WaiModelTask): string {
  switch (task) {
    case "plan":
      return "plan (also plan updates)";
    case "review":
      return "review (fallback for all depths)";
    case "reviewMin":
      return "reviewMin (minimum-depth review)";
    case "reviewMed":
      return "reviewMed (standard-depth review)";
    case "reviewHigh":
      return "reviewHigh (deep review)";
    case "advisor":
      return "advisor (falls back to suggest)";
    case "suggest":
      return "suggest (also advisor fallback)";
    case "done":
      return "done (completion verification when enabled)";
    case "judge":
      return "judge (optional council assessment/synthesis)";
    case "explain":
      return "explain (also deep fact verification)";
    default:
      return task;
  }
}
