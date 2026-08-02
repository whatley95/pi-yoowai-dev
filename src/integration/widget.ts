import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadYoowaiConfig } from "../config.js";
import { getState, getProgress } from "../session-state.js";
import { planStepDescription } from "../types.js";
import type { YoowaiSessionState } from "../types.js";

export const INNER_WIDTH = 30;
const TOTAL_WIDTH = INNER_WIDTH + 4; // includes borders and side padding

function borderLine(left: string, fill: string, right: string): string {
  const fillCount = Math.max(0, TOTAL_WIDTH - left.length - right.length);
  return left + fill.repeat(fillCount) + right;
}

function contentLine(text: string): string {
  const inner = text.slice(0, INNER_WIDTH).padEnd(INNER_WIDTH);
  return `│ ${inner} │`;
}

/** Step indexes (1-based) that block the given plan step, mirroring the
 *  dependency semantics of findNextEligibleStep: a dependency d is unmet when
 *  its step (d-1) is at or beyond completedSteps. Returns undefined when the
 *  step has no unmet numeric dependencies (string steps are never blocked).
 *  Display-only divergence from findNextEligibleStep: malformed (non-numeric)
 *  dependencies are ignored here — they still make the step ineligible in
 *  getProgress (every() fails), but there is no meaningful blocker number to
 *  display, so the blocked line is omitted rather than showing garbage. */
export function getBlockedBy(state: YoowaiSessionState, index: number): number[] | undefined {
  const step = state.plan?.todo[index];
  if (!step || typeof step === "string") return undefined;
  const deps = step.dependsOn;
  if (!Array.isArray(deps) || deps.length === 0) return undefined;
  const unmet = deps.filter(
    (d) => typeof d === "number" && Number.isFinite(d) && d >= 1 && d - 1 >= state.completedSteps,
  );
  return unmet.length > 0 ? unmet : undefined;
}

/** Update the plan-progress widget above the editor.
 *  Shows the active plan summary, progress bar, and current/next step.
 *  Pass undefined content to hide the widget when no plan is active. */
export function updateWaiPlanWidget(ctx: ExtensionContext): void {
  if (!ctx.ui.setWidget) return;

  const config = loadYoowaiConfig(ctx.cwd);
  if (config.planWidget === false) {
    try {
      ctx.ui.setWidget("wai-plan", undefined);
    } catch {
      // ignore
    }
    return;
  }

  const state = getState(ctx.cwd);
  if (!state.plan || state.totalSteps === 0) {
    try {
      ctx.ui.setWidget("wai-plan", undefined);
    } catch {
      // ignore
    }
    return;
  }

  try {
    const progress = getProgress(ctx.cwd);
    const total = progress.total;
    const completed = progress.completed;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    const barWidth = INNER_WIDTH - 5; // leave room for " NNN%"
    const filled = total > 0 ? Math.round((barWidth * completed) / total) : 0;
    const empty = Math.max(0, barWidth - filled);
    const bar = "█".repeat(filled) + "░".repeat(empty);

    const currentOrNext =
      completed < total ? (progress.nextStep ?? planStepDescription(state.plan.todo[completed])) : "all steps complete";

    // A blocked current step: show the step itself (not the far-away eligible
    // one) plus which steps block it.
    const blockedBy = completed < total ? getBlockedBy(state, completed) : undefined;

    const lines = [
      borderLine("┌─ wai plan ─", "─", "┐"),
      contentLine(state.plan.summary),
      contentLine(`${bar} ${pct.toString().padStart(3)}%`),
      contentLine(
        `${completed}/${total} · ${blockedBy ? planStepDescription(state.plan.todo[completed]) : currentOrNext}`,
      ),
    ];
    if (blockedBy) {
      lines.push(contentLine(`⚠ blocked by step ${blockedBy.join(", ")}`));
    }
    lines.push(borderLine("└", "─", "┘"));

    ctx.ui.setWidget("wai-plan", lines);
  } catch {
    // best-effort widget update
  }
}

/** Hide the plan-progress widget. */
export function hideWaiPlanWidget(ctx: ExtensionContext): void {
  if (!ctx.ui.setWidget) return;
  try {
    ctx.ui.setWidget("wai-plan", undefined);
  } catch {
    // ignore
  }
}
