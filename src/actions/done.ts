import { loadYoowaiConfig, resolveTaskModel } from "../config.js";
import { getDiff } from "../diff-grabber.js";
import {
  getProgress,
  markStepComplete,
  setPlanProgress,
  getState,
  getEditTracker,
  resetEditsSinceDone,
  syncWorkspaceChanges,
} from "../session-state.js";
import { captureWorkspace, workspaceMatches } from "../workspace-fingerprint.js";
import { callSecondaryModel } from "../secondary-model.js";
import { buildStepVerificationPrompt, parseStepVerificationResponse } from "../prompts.js";
import { capActionInstructions } from "../instructions.js";
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
  if (!Number.isNaN(num) && num >= 0 && Number.isInteger(num)) {
    return { targetStep: num, label: trimmed };
  }
  return {
    label: value,
    error: `Invalid done target: "${value}". Use a step number (0 resets progress), "all", or omit it to mark the current step.`,
  };
}

export async function executeWaiDone(
  cwd: string,
  value?: string | number,
  signal?: AbortSignal,
  force = false,
): Promise<DoneResult> {
  syncWorkspaceChanges(cwd);
  const before = getProgress(cwd);
  if (before.total === 0) {
    return {
      completedStep: 0,
      totalSteps: 0,
      allDone: false,
      message: "No active wai plan. Start one with /wai plan <task>.",
    };
  }

  // Parse the target before the all-complete check: an explicit target BELOW
  // the current progress is a regression request and must not be blocked.
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

  if (
    before.completed >= before.total &&
    (targetStep === undefined || targetStep >= before.completed) &&
    !getState(cwd).reviewBlocked &&
    getEditTracker(cwd).editsSinceLastReview === 0
  ) {
    return {
      completedStep: before.completed,
      totalSteps: before.total,
      allDone: true,
      message: "All plan steps are already complete. Run /wai judge for a final review.",
    };
  }

  const config = loadYoowaiConfig(cwd);
  const state = getState(cwd);

  // Review gate: never silently mark work complete while edits are pending
  // review. Only blocks advancement — explicit targets at or below the current
  // progress are tracker corrections and stay allowed. `force` overrides, and
  // the step is then recorded as manually marked (not reviewed).
  const advancing = targetStep === undefined || targetStep > before.completed;
  const pendingEdits = getEditTracker(cwd).editsSinceLastReview;
  if (config.requireReviewBeforeDone === true && !force && advancing && (pendingEdits > 0 || state.reviewBlocked)) {
    return {
      completedStep: before.completed,
      totalSteps: before.total,
      nextStep: before.nextStep ?? undefined,
      allDone: false,
      blocked: true,
      message:
        (pendingEdits > 0
          ? `Completion blocked: ${pendingEdits} file edit(s) have not been reviewed. `
          : "Completion blocked: the last whole-tree review did not pass completely. ") +
        `Run \`wai({ review: '...' })\` and pass review before marking the step done, ` +
        `or override with \`wai({ done: true, force: true })\` / \`/wai-done --force\`.`,
    };
  }

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
    !force &&
    config.verifyDoneClaims !== false &&
    getEditTracker(cwd).editsSinceLastDone > 0 &&
    stepDescription
  ) {
    try {
      const verificationSnapshot = captureWorkspace(cwd);
      const {
        diff,
        truncated: diffTruncated,
        changedFiles,
        unavailableReason,
      } = getDiff(cwd, {
        maxDiffChars: config.reviewMaxDiffChars,
        untracked: true,
        revision: "HEAD",
      });
      if (unavailableReason || changedFiles.length === 0)
        throw new Error(unavailableReason ?? "No code changes available for done verification");
      if (diffTruncated) throw new Error("Incomplete diff for done verification");
      const modelConfig = resolveTaskModel(config, "done");
      if (!modelConfig.provider || !modelConfig.id) throw new Error("No done-verification model configured");
      if (modelConfig.provider && modelConfig.id) {
        const { system, user } = buildStepVerificationPrompt(
          stepDescription,
          diff,
          capActionInstructions(cwd, "done", config.instructionsMaxTokens ?? 800),
        );
        const {
          content: raw,
          usage,
          truncated,
        } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
          signal,
          thinking: modelConfig.thinking,
          cwd,
          task: "done",
          structuredOutput: true,
        });
        recordCostWithBudget(cwd, usage);
        if (truncated) throw new Error("Incomplete done-verification response");
        const parsed = parseStepVerificationResponse(raw);
        if (!parsed) throw new Error("Invalid done-verification response");
        if (!workspaceMatches(cwd, verificationSnapshot)) throw new Error("Workspace changed during done verification");
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
      logEvent(cwd, "warn", "Done-claim verification failed; completion blocked", {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        completedStep: before.completed,
        totalSteps: before.total,
        nextStep: before.nextStep,
        allDone: false,
        blocked: true,
        verificationReason: err instanceof Error ? err.message : String(err),
        message:
          "Completion blocked: could not verify this step. Retry verification or use /wai-done --force to mark it manually.",
      };
    }
  }

  signal?.throwIfAborted();
  if (targetStep !== undefined) {
    // Explicit targets are corrections and work in both directions: a target
    // below the current progress regresses the tracker.
    setPlanProgress(cwd, targetStep);
  } else {
    markStepComplete(cwd);
  }
  resetEditsSinceDone(cwd);

  const after = getProgress(cwd);
  const regressed = targetStep !== undefined && after.completed < before.completed;
  return {
    completedStep: after.completed,
    totalSteps: after.total,
    nextStep: after.nextStep ?? undefined,
    allDone: after.completed >= after.total,
    verified,
    message: regressed
      ? `Plan tracker regressed to step ${after.completed} (was ${before.completed}/${after.total}); later steps are now marked incomplete.`
      : targetStep !== undefined
        ? `Marked steps up to ${label} complete (${after.completed}/${after.total}).`
        : `Step ${before.completed + 1} marked complete (${after.completed}/${after.total}).`,
  };
}
