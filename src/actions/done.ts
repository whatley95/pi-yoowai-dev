import { loadYoowaiConfig, resolveTaskModel } from "../config.js";
import { getDiff } from "../diff-grabber.js";
import {
  getProgress,
  markStepComplete,
  markStepsComplete,
  getState,
  getEditTracker,
  resetEditsSinceDone,
} from "../session-state.js";
import { callSecondaryModel } from "../secondary-model.js";
import { buildStepVerificationPrompt, parseStepVerificationResponse } from "../prompts.js";
import { recordCostWithBudget } from "./shared.js";
import { logEvent } from "../logger.js";
import type { DoneResult } from "../types.js";

function parseDoneTarget(value: string | number | undefined): { targetStep?: number; label: string; error?: string } {
  if (value === undefined || value === "") {
    return { label: "current" };
  }
  if (typeof value === "number") {
    return { targetStep: value, label: String(value) };
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "all") {
    return { targetStep: Number.MAX_SAFE_INTEGER, label: "all" };
  }
  const num = Number(trimmed);
  if (!Number.isNaN(num) && num > 0 && Number.isInteger(num)) {
    return { targetStep: num, label: trimmed };
  }
  return {
    label: value,
    error: `Invalid done target: "${value}". Use a step number, "all", or omit it to mark the current step.`,
  };
}

export async function executeWaiDone(cwd: string, value?: string | number, signal?: AbortSignal): Promise<DoneResult> {
  const before = getProgress(cwd);
  if (before.total === 0) {
    return {
      completedStep: 0,
      totalSteps: 0,
      allDone: false,
      message: "No active wai plan. Start one with /wai plan <task>.",
    };
  }
  if (before.completed >= before.total) {
    return {
      completedStep: before.completed,
      totalSteps: before.total,
      allDone: true,
      message: "All plan steps are already complete. Run /wai judge for a final review.",
    };
  }

  const config = loadYoowaiConfig(cwd);
  const { targetStep, label, error } = parseDoneTarget(value);
  if (error) {
    return {
      completedStep: before.completed,
      totalSteps: before.total,
      allDone: false,
      verified: undefined,
      message: error,
    };
  }
  const state = getState(cwd);
  const currentStepIndex = state.completedSteps;
  const stepDescription =
    state.plan && currentStepIndex < state.plan.todo.length
      ? typeof state.plan.todo[currentStepIndex] === "string"
        ? (state.plan.todo[currentStepIndex] as string)
        : (state.plan.todo[currentStepIndex] as { description: string }).description
      : "";

  let verified: boolean | undefined = undefined;
  // Verification applies only to a bare "current step is done" claim. An
  // explicit target (done:3 / done:"all") is the agent correcting the
  // tracker, not claiming fresh work — verifying the current step there would
  // both block legitimate corrections and check the wrong step.
  if (
    targetStep === undefined &&
    config.verifyDoneClaims !== false &&
    getEditTracker(cwd).editsSinceLastDone > 0 &&
    stepDescription
  ) {
    try {
      const { diff } = getDiff(cwd, { maxDiffChars: config.reviewMaxDiffChars, untracked: true, revision: "HEAD" });
      const modelConfig = resolveTaskModel(config, "done");
      if (modelConfig.provider && modelConfig.id) {
        const { system, user } = buildStepVerificationPrompt(stepDescription, diff);
        const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
          signal,
          thinking: modelConfig.thinking,
          cwd,
          task: "done",
          structuredOutput: true,
        });
        recordCostWithBudget(cwd, usage);
        const parsed = parseStepVerificationResponse(raw);
        if (parsed) {
          verified = parsed.satisfied;
          if (!parsed.satisfied) {
            return {
              completedStep: before.completed,
              totalSteps: before.total,
              nextStep: before.nextStep ?? undefined,
              allDone: false,
              verified: false,
              verificationReason: parsed.reason,
              message: `Step ${before.completed + 1} does not appear to be complete: ${parsed.reason}. Continue working or run wai.review to confirm.`,
            };
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      logEvent(cwd, "warn", "Done-claim verification failed; allowing step to advance", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (targetStep !== undefined) {
    markStepsComplete(cwd, targetStep, false);
  } else {
    markStepComplete(cwd);
  }
  resetEditsSinceDone(cwd);

  const after = getProgress(cwd);
  return {
    completedStep: after.completed,
    totalSteps: after.total,
    nextStep: after.nextStep ?? undefined,
    allDone: after.completed >= after.total,
    verified,
    message:
      targetStep !== undefined
        ? `Marked steps up to ${label} complete (${after.completed}/${after.total}).`
        : `Step ${before.completed + 1} marked complete (${after.completed}/${after.total}).`,
  };
}
