import { getProgress, markStepComplete, markStepsComplete } from "../session-state.js";
import type { DoneResult } from "../types.js";

function parseDoneTarget(value: string | number | undefined): { targetStep?: number; label: string } {
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
  if (!Number.isNaN(num) && num > 0) {
    return { targetStep: num, label: trimmed };
  }
  return { label: value };
}

export function executeYooDone(cwd: string, value?: string | number): DoneResult {
  const before = getProgress(cwd);
  if (before.total === 0) {
    return {
      completedStep: 0,
      totalSteps: 0,
      allDone: false,
      message: "No active yoo plan. Start one with /yoo plan <task>.",
    };
  }
  if (before.completed >= before.total) {
    return {
      completedStep: before.completed,
      totalSteps: before.total,
      allDone: true,
      message: "All plan steps are already complete. Run /yoo judge for a final review.",
    };
  }

  const { targetStep, label } = parseDoneTarget(value);
  if (targetStep !== undefined) {
    markStepsComplete(cwd, targetStep, false);
  } else {
    markStepComplete(cwd);
  }

  const after = getProgress(cwd);
  return {
    completedStep: after.completed,
    totalSteps: after.total,
    nextStep: after.nextStep ?? undefined,
    allDone: after.completed >= after.total,
    message:
      targetStep !== undefined
        ? `Marked steps up to ${label} complete (${after.completed}/${after.total}).`
        : `Step ${before.completed + 1} marked complete (${after.completed}/${after.total}).`,
  };
}
