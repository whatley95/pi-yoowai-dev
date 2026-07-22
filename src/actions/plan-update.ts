import { executeWaiPlan } from "./plan.js";
import { getState, setPlan, markStepsComplete } from "../session-state.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DoneResult, PlanResult } from "../types.js";
import type { ProgressReporter } from "../progress.js";

export async function executeWaiPlanUpdate(
  cwd: string,
  description: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager: ExtensionContext["sessionManager"] | undefined,
): Promise<DoneResult> {
  const before = getState(cwd);
  const previousCompleted = before.completedSteps;

  const planResult = await executeWaiPlan(cwd, description, signal, progress, sessionManager);
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
  // Preserve completed progress up to the new plan length. Completed-via-done
  // steps are marked "not reviewed" (not "reviewed and passed") so judge
  // history isn't falsified, and the advanced state is persisted via
  // markStepsComplete (setPlan alone does not persist restored progress).
  if (previousCompleted > 0 && previousCompleted <= newPlan.todo.length) {
    markStepsComplete(cwd, previousCompleted, false);
  }
  const after = getState(cwd);

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
