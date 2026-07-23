import { executeWaiPlan } from "./plan.js";
import { getState, setPlan, markStepsComplete } from "../session-state.js";
import { logEvent } from "../logger.js";
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
  // If the regenerated plan is shorter than the previous progress, clamp to
  // the new length and warn — otherwise the completed count silently resets
  // to 0 with no explanation.
  const restored = Math.min(previousCompleted, newPlan.todo.length);
  const clamped = previousCompleted > newPlan.todo.length;
  if (clamped) {
    logEvent(cwd, "warn", "Plan update dropped completed progress", {
      previousCompleted,
      newTotalSteps: newPlan.todo.length,
    });
  }
  if (restored > 0) {
    markStepsComplete(cwd, restored, false);
  }
  const after = getState(cwd);

  const nextStep = after.plan?.todo[after.completedSteps]
    ? typeof after.plan.todo[after.completedSteps] === "string"
      ? (after.plan.todo[after.completedSteps] as string)
      : (after.plan.todo[after.completedSteps] as { description: string }).description
    : undefined;
  const clampNote = clamped
    ? ` Warning: previous progress (${previousCompleted} steps) exceeded the new plan length (${newPlan.todo.length}) and was clamped; re-review the affected work.`
    : "";

  return {
    completedStep: after.completedSteps,
    totalSteps: after.totalSteps,
    nextStep,
    allDone: after.completedSteps >= after.totalSteps,
    message: `Plan updated: ${after.completedSteps}/${after.totalSteps} steps already completed.${clampNote}`,
  };
}
