import { loadState, saveState } from "./plan-store.js";
import { planStepDescription } from "./types.js";
import type { HeyyooSessionState, PlanResult } from "./types.js";

const sessionStates = new Map<string, HeyyooSessionState>();

export function getState(cwd: string): HeyyooSessionState {
  let state = sessionStates.get(cwd);
  if (!state) {
    state = loadState(cwd) ?? {
      completedSteps: 0,
      totalSteps: 0,
      reviewRounds: [],
      reviewedSteps: [],
      judgeCompleted: false,
      editsSinceLastReview: 0,
      editsSinceLastDone: 0,
    };
    state.editsSinceLastReview ??= 0;
    state.editsSinceLastDone ??= 0;
    sessionStates.set(cwd, state);
  }
  return state;
}

export function setPlan(cwd: string, plan: PlanResult): void {
  const state = getState(cwd);
  state.plan = plan;
  state.totalSteps = plan.todo.length;
  state.completedSteps = 0;
  state.reviewRounds = new Array(plan.todo.length).fill(0);
  state.reviewedSteps = new Array(plan.todo.length).fill(false);
  state.judgeCompleted = false;
  state.editsSinceLastReview = 0;
  state.editsSinceLastDone = 0;
  state.lastSteerAt = undefined;
  saveState(cwd, state);
}

export function markStepComplete(cwd: string, reviewed = false): void {
  const state = getState(cwd);
  if (state.totalSteps > 0 && state.completedSteps < state.totalSteps) {
    state.completedSteps++;
    state.reviewedSteps[state.completedSteps - 1] = reviewed;
    saveState(cwd, state);
  }
}

export function markStepsComplete(cwd: string, count: number, reviewed = false): void {
  const state = getState(cwd);
  if (state.totalSteps === 0) return;
  const target = Math.min(count, state.totalSteps);
  while (state.completedSteps < target) {
    state.completedSteps++;
    state.reviewedSteps[state.completedSteps - 1] = reviewed;
  }
  saveState(cwd, state);
}

export function incrementReviewRounds(cwd: string): void {
  const state = getState(cwd);
  const idx = state.completedSteps;
  while (state.reviewRounds.length <= idx) state.reviewRounds.push(0);
  state.reviewRounds[idx]++;
  saveState(cwd, state);
}

export function getProgress(cwd: string): { completed: number; total: number; nextStep?: string } {
  const state = getState(cwd);
  const completed = state.completedSteps;
  const total = state.totalSteps;
  const item = state.plan?.todo[completed];
  const nextStep = item ? planStepDescription(item) : undefined;
  return { completed, total, nextStep };
}

export function buildReviewHistory(cwd: string): string {
  const state = getState(cwd);
  if (!state.plan || state.plan.todo.length === 0) return "";
  const lines: string[] = [];
  for (let i = 0; i < state.plan.todo.length; i++) {
    const desc = planStepDescription(state.plan.todo[i]);
    if (i < state.completedSteps) {
      const reviewed = state.reviewedSteps[i] ? "reviewed and passed" : "marked complete (not reviewed)";
      lines.push(`✓ Step ${i + 1}: ${desc} — ${reviewed}`);
    } else if (i === state.completedSteps) {
      lines.push(`→ Step ${i + 1}: ${desc} — current (may or may not be done)`);
    } else {
      lines.push(`· Step ${i + 1}: ${desc} — not yet started`);
    }
  }
  return lines.join("\n");
}

export function markJudgeCompleted(cwd: string): void {
  const state = getState(cwd);
  state.judgeCompleted = true;
  saveState(cwd, state);
}

export function recordFileEdit(cwd: string): void {
  const state = getState(cwd);
  state.editsSinceLastReview++;
  state.editsSinceLastDone++;
}

export function resetEditsSinceReview(cwd: string): void {
  const state = getState(cwd);
  state.editsSinceLastReview = 0;
}

export function resetEditsSinceDone(cwd: string): void {
  const state = getState(cwd);
  state.editsSinceLastDone = 0;
}

export function getEditTracker(cwd: string): { editsSinceLastReview: number; editsSinceLastDone: number } {
  const state = getState(cwd);
  return { editsSinceLastReview: state.editsSinceLastReview, editsSinceLastDone: state.editsSinceLastDone };
}

export function dropSessionState(cwd: string): void {
  sessionStates.delete(cwd);
}
