import { executeWaiPlan } from "./plan.js";
import { getState, markStepsComplete, flushSessionState } from "../session-state.js";
import { logEvent } from "../logger.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { planStepDescription, type DoneResult, type PlanResult } from "../types.js";
import type { ProgressReporter } from "../progress.js";

/** Only unchanged leading work can retain progress after regeneration.
 *  Priority is presentation metadata; dependency changes affect completion. */
export function preservedCompletedPrefix(previous: PlanResult, next: PlanResult, completedSteps: number): number {
  const limit = Math.min(completedSteps, previous.todo.length, next.todo.length);
  let count = 0;
  for (; count < limit; count++) {
    const oldStep = previous.todo[count];
    const newStep = next.todo[count];
    if (planStepDescription(oldStep).trim() !== planStepDescription(newStep).trim()) break;
    const oldDeps = typeof oldStep === "string" ? [] : (oldStep.dependsOn ?? []);
    const newDeps = typeof newStep === "string" ? [] : (newStep.dependsOn ?? []);
    if (JSON.stringify([...oldDeps].sort()) !== JSON.stringify([...newDeps].sort())) break;
  }
  return count;
}

export async function executeWaiPlanUpdate(
  cwd: string,
  description: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager: ExtensionContext["sessionManager"] | undefined,
): Promise<DoneResult> {
  const before = getState(cwd);
  const previousCompleted = before.completedSteps;
  const previousBase = before.planBaseCommit;
  const previousPlan = before.plan;

  const planResult = await executeWaiPlan(
    cwd,
    description,
    signal,
    progress,
    sessionManager,
    "plan",
    "planUpdate",
    previousPlan ? { plan: previousPlan, completedSteps: previousCompleted } : undefined,
  );
  signal?.throwIfAborted();
  if (planResult.error || !planResult.plan) {
    return {
      completedStep: previousCompleted,
      totalSteps: before.totalSteps,
      allDone: false,
      error: planResult.error ?? "Failed to regenerate plan.",
      message: planResult.error ?? "Failed to regenerate plan.",
    };
  }

  const newPlan: PlanResult = planResult.plan;
  // Regenerating the plan retains the task's original judgment span.
  getState(cwd).planBaseCommit = previousBase ?? getState(cwd).planBaseCommit;
  // Retain progress only through the first changed or reordered step. A raw
  // count could otherwise skip newly inserted work. Restored steps remain
  // manually marked rather than inventing a review of the regenerated plan.
  const restored = previousPlan ? preservedCompletedPrefix(previousPlan, newPlan, previousCompleted) : 0;
  const progressChanged = restored < previousCompleted;
  if (progressChanged) {
    logEvent(cwd, "warn", "Plan update dropped completed progress", {
      previousCompleted,
      restoredCompleted: restored,
      newTotalSteps: newPlan.todo.length,
    });
  }
  if (restored > 0) {
    markStepsComplete(cwd, restored, false);
  }
  const after = getState(cwd);
  flushSessionState(cwd);

  const nextStep = after.plan?.todo[after.completedSteps]
    ? typeof after.plan.todo[after.completedSteps] === "string"
      ? (after.plan.todo[after.completedSteps] as string)
      : (after.plan.todo[after.completedSteps] as { description: string }).description
    : undefined;
  const progressNote = progressChanged
    ? ` Retained ${restored} of ${previousCompleted} previously completed steps; changed, removed, or reordered steps need verification again.`
    : "";

  return {
    completedStep: after.completedSteps,
    totalSteps: after.totalSteps,
    nextStep,
    allDone: after.completedSteps >= after.totalSteps,
    message: `Plan updated: ${after.completedSteps}/${after.totalSteps} steps already completed.${progressNote}`,
  };
}
