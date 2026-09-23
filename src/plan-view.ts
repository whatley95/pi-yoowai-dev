import { formatCost } from "./cost-tracker.js";
import type { PlanTodoItem } from "./types.js";
import type { YoowaiSessionState } from "./types.js";
import { planStepDescription } from "./types.js";

/** Minimal structural view of the session cost (from cost-tracker.ts's
 *  CostLog) so plan-view.ts does not need to import the tracker. */
export interface PlanViewCost {
  calls: number;
  costUsd: number;
}

export interface PlanViewOptions {
  /** Edits still awaiting review (defaults to state.editsSinceLastReview when omitted). */
  unreviewedEdits?: number;
}

/** How wide a description line may get before it wraps. Generous on purpose:
 *  this view is shown in a scrollable TUI list, not the 30-char widget. */
const WRAP_WIDTH = 100;

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

/** Wrap a single line into continuation lines at word boundaries. Content is
 *  never discarded — long descriptions wrap instead of truncating. */
function wrapLine(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const lines: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= 0) cut = width; // no space — hard wrap
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) lines.push(rest);
  return lines.length > 0 ? lines : [text];
}

function indentedWrap(text: string, prefix: string, indent: string): string[] {
  return wrapLine(text, WRAP_WIDTH - indent.length).map((line, i) =>
    i === 0 ? `${prefix}${line}` : `${indent}${line}`,
  );
}

/** Status glyph for a plan step, shared by /wai-plan and the widget so the
 *  precedence never diverges: ✓ completed-and-reviewed, ⚠ completed-but-
 *  manually-marked (no passing review), → current incomplete, · pending. */
export function stepGlyph(state: YoowaiSessionState, index: number): "✓" | "⚠" | "→" | "·" {
  if (index < state.completedSteps) return state.reviewedSteps[index] ? "✓" : "⚠";
  if (index === state.completedSteps) return "→";
  return "·";
}

/** Latest file-review summary from state.reviewedFiles: the newest entry by
 *  `at` plus how many files carry verdicts. Returns undefined when no
 *  per-file review has been recorded. */
export function latestFileReview(state: YoowaiSessionState): { verdict: string; files: number } | undefined {
  const entries = Object.values(state.reviewedFiles ?? {});
  if (entries.length === 0) return undefined;
  const latest = entries.reduce((best, e) => (e.at > best.at ? e : best), entries[0]!);
  return { verdict: latest.verdict, files: entries.length };
}

function reviewedCount(state: YoowaiSessionState, completed: number): number {
  let count = 0;
  for (let i = 0; i < completed; i++) {
    if (state.reviewedSteps[i]) count++;
  }
  return count;
}

/** Pure renderer for the full, untruncated plan view shown by /wai-plan.
 *  Returns plain-text lines (no ANSI escapes) suitable for ctx.ui.select.
 *  Distinguishes completed-and-reviewed (✓) from completed-but-manually-marked
 *  (⚠), shows the current step with blockers, pending steps, the acceptance
 *  criteria checklist, review-pending state with edited-file samples, and the
 *  session cost. The acceptance criteria are a checklist, not a verification:
 *  nothing here claims a criterion has been verified. */
export function buildPlanView(state: YoowaiSessionState, cost: PlanViewCost, opts?: PlanViewOptions): string[] {
  if (!state.plan || state.totalSteps === 0) {
    return ["No active plan."];
  }

  const plan = state.plan;
  const completed = state.completedSteps;
  const total = state.totalSteps;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const reviewed = reviewedCount(state, completed);

  const lines: string[] = [];
  for (const line of indentedWrap(`wai plan — ${plan.summary}`, "", "  ")) {
    lines.push(line);
  }
  lines.push(`Progress: ${completed}/${total} steps (${pct}%) · reviewed: ${reviewed}/${completed || 0}`);
  lines.push("");

  // Steps — the full list, untruncated, with the completed-vs-reviewed
  // distinction the widget cannot show at its width. The whole display line
  // (indent + number + glyph + description + status suffix) wraps as one
  // unit so no line exceeds the wrap width.
  for (let i = 0; i < plan.todo.length; i++) {
    const item: PlanTodoItem = plan.todo[i]!;
    const description = planStepDescription(item);
    const indent = "  ";
    const glyph = stepGlyph(state, i);
    let suffix = "";
    if (i < completed) {
      const rounds = state.reviewRounds[i] ?? 0;
      if (glyph === "✓") {
        suffix = ` — reviewed (${rounds} round${rounds === 1 ? "" : "s"})`;
      } else {
        suffix = " — completed (manually marked, not reviewed)";
      }
    } else if (i === completed) {
      suffix = " — current";
      const blockedBy = getBlockedBy(state, i);
      if (blockedBy) suffix += `, blocked by step ${blockedBy.join(", ")}`;
    }
    const base = `${indent}${i + 1}. ${glyph} `;
    for (const line of indentedWrap(`${description}${suffix}`, base, " ".repeat(base.length))) {
      lines.push(line);
    }
  }
  lines.push("");

  // Sections below are only emitted when non-empty, always separated by
  // exactly one blank line, so an empty review-state (e.g. a complete plan
  // with no verdicts and no pending edits) never produces adjacent blanks.
  const pushSection = (sectionLines: string[]) => {
    if (sectionLines.length === 0) return;
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push(...sectionLines);
    lines.push("");
  };

  // Review state.
  const reviewLines: string[] = [];
  const unreviewedEdits = opts?.unreviewedEdits ?? state.editsSinceLastReview;
  if (completed < total) {
    const rounds = state.reviewRounds[completed] ?? 0;
    reviewLines.push(`Review: step ${completed + 1} has ${rounds} review round${rounds === 1 ? "" : "s"} so far`);
  }
  const fileReview = latestFileReview(state);
  if (fileReview) {
    reviewLines.push(
      `Last file review: ${fileReview.verdict} (${fileReview.files} file${fileReview.files === 1 ? "" : "s"} with verdicts)`,
    );
  }
  if (unreviewedEdits > 0) {
    reviewLines.push(
      `⚠ review pending: ${unreviewedEdits} edit${unreviewedEdits === 1 ? "" : "s"} since the last review`,
    );
    const edited = state.editedFiles ?? [];
    if (edited.length > 0) {
      const sample = edited.slice(0, 5).join(", ");
      const more = edited.length > 5 ? `, +${edited.length - 5} more` : "";
      for (const line of indentedWrap(`edited: ${sample}${more}`, "  ", "    ")) {
        reviewLines.push(line);
      }
    }
  }
  pushSection(reviewLines);

  // Acceptance criteria — a checklist, not a verification.
  const acceptanceLines: string[] = [];
  if (plan.acceptanceCriteria.length > 0) {
    acceptanceLines.push("Acceptance criteria (not yet verified — the judge evaluates these):");
    for (const criterion of plan.acceptanceCriteria) {
      for (const line of indentedWrap(criterion, "· ", "  ")) {
        acceptanceLines.push(line);
      }
    }
  }
  pushSection(acceptanceLines);

  // Completion state.
  if (completed >= total) {
    lines.push(
      state.judgeCompleted ? "Plan complete · final judge verdict recorded." : "Plan complete · final judge pending.",
    );
  } else {
    lines.push(`Next: wai({ review: "..." }) when step ${completed + 1} is done.`);
  }
  lines.push("");
  lines.push(`Session cost: ${formatCost(cost.costUsd)} (${cost.calls} call${cost.calls === 1 ? "" : "s"})`);
  return lines;
}
