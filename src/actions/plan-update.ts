import { executeYooPlan } from "./plan.js";
import { getState, setPlan } from "../session-state.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DoneResult, PlanResult } from "../types.js";
import type { ProgressReporter } from "../progress.js";

export async function executeYooPlanUpdate(
  cwd: string,
  description: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager: ExtensionContext["sessionManager"] | undefined,
): Promise<DoneResult> {
  const before = getState(cwd);
  const previousCompleted = before.completedSteps;

  const planResult = await executeYooPlan(cwd, description, signal, progress, sessionManager);
  if (planResult.error || !planResult.plan) {
    return {
      completedStep: previousCompleted,
      totalSteps: before.totalSteps,
      allDone: false,
      message: planResult.error ?? "Failed to regenerate plan.",
    };
  }

  const newPlan: PlanResult = planResult.plan;
  setPlan(cwd, newPlan);
  const after = getState(cwd);
  // Preserve completed progress up to the new plan length.
  if (previousCompleted > 0 && previousCompleted <= after.totalSteps) {
    after.completedSteps = previousCompleted;
    after.reviewedSteps.fill(false);
    after.reviewedSteps.fill(true, 0, previousCompleted);
  }

  return {
    completedStep: after.completedSteps,
    totalSteps: after.totalSteps,
    nextStep: after.plan?.todo[after.completedSteps]
      ? typeof after.plan.todo[after.completedSteps] === "string"
        ? (after.plan.todo[after.completedSteps] as string)
        : (after.plan.todo[after.completedSteps] as { description: string }).description
      : undefined,
    allDone: after.completedSteps >= after.totalSteps,
    message: `Plan updated: ${after.completedSteps}/${after.totalSteps} steps already completed.`,
  };
}
