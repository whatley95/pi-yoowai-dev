import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadYoowaiConfig } from "../config.js";
import { getState, getProgress } from "../session-state.js";
import { planStepDescription } from "../types.js";

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

    const lines = [
      borderLine("┌─ wai plan ─", "─", "┐"),
      contentLine(state.plan.summary),
      contentLine(`${bar} ${pct.toString().padStart(3)}%`),
      contentLine(`${completed}/${total} · ${currentOrNext}`),
      borderLine("└", "─", "┘"),
    ];

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
