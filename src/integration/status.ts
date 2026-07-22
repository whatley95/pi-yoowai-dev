import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSessionCost, formatCost } from "../cost-tracker.js";
import { loadYoowaiConfig } from "../config.js";
import { getEditTracker, getProgress, getState } from "../session-state.js";
import { planStepDescription } from "../types.js";

/** Update the Pi footer status lines for wai:
 *  - "wai-plan" shows the active plan progress and next step.
 *  - "wai-cost" shows the session cost and pending-review edit count.
 *
 *  Call this whenever plan state, edits, or cost changes. It is best-effort:
 *  non-TUI modes or missing UI methods are ignored. */
export function updateWaiStatus(ctx: ExtensionContext): void {
  if (!ctx.ui.setStatus) return;

  const state = getState(ctx.cwd);
  const cost = getSessionCost(ctx.cwd);
  const edits = getEditTracker(ctx.cwd);
  const config = loadYoowaiConfig(ctx.cwd);

  try {
    if (state.plan && state.totalSteps > 0) {
      const progress = getProgress(ctx.cwd);
      const current =
        progress.completed < progress.total
          ? planStepDescription(state.plan.todo[progress.completed])
          : "all steps complete";
      const planText = `wai ${progress.completed}/${progress.total} · ${current}`;
      ctx.ui.setStatus("wai-plan", planText);
    } else {
      ctx.ui.setStatus("wai-plan", undefined);
    }

    const parts: string[] = [];
    if (cost.calls > 0) {
      parts.push(`${formatCost(cost.costUsd)} · ${cost.calls} call${cost.calls === 1 ? "" : "s"}`);
    }
    const reviewThreshold = config.reviewReminderEdits ?? 3;
    if (edits.editsSinceLastReview >= reviewThreshold && edits.editsSinceLastReview > 0) {
      parts.push(`review pending (${edits.editsSinceLastReview} edits)`);
    }
    ctx.ui.setStatus("wai-cost", parts.length > 0 ? `wai ${parts.join(" · ")}` : undefined);
  } catch {
    // best-effort status update
  }
}

/** Clear the persistent footer status lines. */
export function clearWaiStatusLines(ctx: ExtensionContext): void {
  if (!ctx.ui.setStatus) return;
  try {
    ctx.ui.setStatus("wai-plan", undefined);
    ctx.ui.setStatus("wai-cost", undefined);
  } catch {
    // ignore
  }
}
