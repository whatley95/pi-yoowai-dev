import { executeWaiPlan } from "./plan.js";
import { getState, planStateToken, commitPlanUpdate, syncWorkspaceChanges } from "../session-state.js";
import { captureWorkspace } from "../workspace-fingerprint.js";
import {
  identifyPlan,
  identifyUpdatedPlan,
  editPlan,
  parsePlanUpdateInput,
  planChangeSummary,
  sameStepOutcome,
  samePlanCriteria,
} from "../plan-editor.js";
import { logEvent } from "../logger.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  planStepDescription,
  type DoneResult,
  type PlanResult,
  type PlanUpdateRequest,
  type YoowaiSessionState,
} from "../types.js";
import type { ProgressReporter } from "../progress.js";

function oldStepIndex(previous: PlanResult, next: PlanResult, index: number): number {
  const step = next.todo[index];
  if (typeof step !== "string" && step.id)
    return previous.todo.findIndex((old) => typeof old !== "string" && old.id === step.id);
  return index;
}

/** Retain a complete leading run of unchanged outcomes, matched by stable identity. */
export function preservedCompletedPrefix(previous: PlanResult, next: PlanResult, completedSteps: number): number {
  if (!samePlanCriteria(previous, next)) return 0;
  let count = 0;
  for (; count < next.todo.length; count++) {
    const oldIndex = oldStepIndex(previous, next, count);
    if (
      oldIndex < 0 ||
      oldIndex >= completedSteps ||
      oldIndex >= previous.todo.length ||
      !sameStepOutcome(previous, oldIndex, next, count)
    )
      break;
  }
  return count;
}

function resultFor(state: YoowaiSessionState, message: string, changes?: string[]): DoneResult {
  return {
    completedStep: state.completedSteps,
    totalSteps: state.totalSteps,
    nextStep: state.plan?.todo[state.completedSteps]
      ? planStepDescription(state.plan.todo[state.completedSteps])
      : undefined,
    allDone: state.totalSteps > 0 && state.completedSteps >= state.totalSteps,
    message,
    changes,
    undoAvailable: !!state.planUndo,
  };
}

export async function executeWaiPlanUpdate(
  cwd: string,
  input: string | PlanUpdateRequest,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager: ExtensionContext["sessionManager"] | undefined,
): Promise<DoneResult> {
  syncWorkspaceChanges(cwd);
  const before = structuredClone(getState(cwd));
  const token = planStateToken(cwd);
  try {
    signal?.throwIfAborted();
    if (!before.plan) throw new Error("No active wai plan. Create one with /wai plan <task> before updating it.");
    const request = parsePlanUpdateInput(input);
    const workspace = captureWorkspace(cwd);
    if (typeof request !== "string" && "undo" in request) {
      const undo = before.planUndo;
      if (!undo) throw new Error("No plan update is available to undo.");
      const unchanged = workspace.status === "ready" && workspace.fingerprint === undo.workspaceFingerprint;
      const next: YoowaiSessionState = {
        ...before,
        plan: undo.plan,
        totalSteps: undo.plan.todo.length,
        completedSteps: unchanged ? undo.completedSteps : 0,
        reviewRounds: unchanged ? undo.reviewRounds : undo.plan.todo.map(() => 0),
        reviewedSteps: unchanged ? undo.reviewedSteps : undo.plan.todo.map(() => false),
        completionEvidence: unchanged ? undo.completionEvidence : undefined,
        planUndo: undefined,
        reviewedFiles: undefined,
        planStaleSuggestedRound: undefined,
        judgeCompleted: false,
      };
      signal?.throwIfAborted();
      commitPlanUpdate(cwd, token, next);
      return resultFor(
        next,
        `Undid the last plan update.${unchanged ? " Preserved the previous completion and review records." : " Source evidence changed or could not be verified; restored steps need verification again."}`,
        ["Restored the previous plan"],
      );
    }

    const previous = identifyPlan(before.plan);
    let candidate: PlanResult;
    if (typeof request === "string") {
      const generated = await executeWaiPlan(
        cwd,
        request,
        signal,
        progress,
        sessionManager,
        "plan",
        "planUpdate",
        { plan: previous, completedSteps: before.completedSteps },
        { persist: false },
      );
      if (generated.error || !generated.plan) throw new Error(generated.error ?? "Failed to generate an updated plan.");
      candidate = generated.plan;
    } else candidate = editPlan(previous, request);
    signal?.throwIfAborted();
    syncWorkspaceChanges(cwd);
    const plan = identifyUpdatedPlan(previous, candidate);
    const changes = planChangeSummary(previous, plan);
    if (changes.length === 0) {
      if (planStateToken(cwd) !== token)
        throw new Error("Plan or tracking changed while the update was being prepared. Inspect /wai-plan and retry.");
      return resultFor(getState(cwd), "No plan changes were needed.", []);
    }
    const completed = preservedCompletedPrefix(previous, plan, before.completedSteps);
    const criteriaUnchanged = samePlanCriteria(previous, plan);
    const requirementsUnchanged =
      criteriaUnchanged &&
      previous.todo.length === plan.todo.length &&
      plan.todo.every((_, i) => {
        const oldIndex = oldStepIndex(previous, plan, i);
        return oldIndex >= 0 && sameStepOutcome(previous, oldIndex, plan, i);
      });
    const oldCurrent = previous.todo[before.completedSteps];
    const newCurrent = plan.todo[completed];
    const sameCurrent =
      criteriaUnchanged &&
      oldCurrent?.id === newCurrent?.id &&
      oldCurrent !== undefined &&
      newCurrent !== undefined &&
      sameStepOutcome(previous, before.completedSteps, plan, completed);
    const next: YoowaiSessionState = {
      ...before,
      plan,
      totalSteps: plan.todo.length,
      completedSteps: completed,
      reviewedSteps: plan.todo.map(
        (_, i) => i < completed && before.reviewedSteps[oldStepIndex(previous, plan, i)] === true,
      ),
      reviewRounds: plan.todo.map((_, i) => {
        const oldIndex = oldStepIndex(previous, plan, i);
        return criteriaUnchanged && oldIndex >= 0 && sameStepOutcome(previous, oldIndex, plan, i)
          ? (before.reviewRounds[oldIndex] ?? 0)
          : 0;
      }),
      judgeCompleted: requirementsUnchanged ? before.judgeCompleted : false,
      completionEvidence:
        criteriaUnchanged && completed === before.completedSteps && (sameCurrent || completed === plan.todo.length)
          ? before.completionEvidence
          : undefined,
      reviewedFiles: sameCurrent ? before.reviewedFiles : undefined,
      planStaleSuggestedRound: undefined,
      planUndo: {
        plan: previous,
        completedSteps: before.completedSteps,
        reviewedSteps: before.reviewedSteps,
        reviewRounds: before.reviewRounds,
        workspaceFingerprint: workspace.status === "ready" ? workspace.fingerprint : undefined,
        completionEvidence: before.completionEvidence,
      },
    };
    commitPlanUpdate(cwd, token, next);
    const note =
      completed < before.completedSteps
        ? ` Retained ${completed} of ${before.completedSteps} previously completed steps; affected and later steps need verification again.`
        : " Unchanged completed steps keep their review records.";
    logEvent(cwd, "info", "Plan update applied", {
      changes,
      previousCompleted: before.completedSteps,
      completedSteps: completed,
    });
    return resultFor(next, `Plan updated: ${completed}/${plan.todo.length} steps completed.${note}`, changes);
  } catch (err) {
    if (signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    logEvent(cwd, "warn", "Plan update not applied", { error: message });
    return { ...resultFor(getState(cwd), message), error: message };
  }
}
