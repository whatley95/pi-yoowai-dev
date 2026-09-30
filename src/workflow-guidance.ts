/** Shared main-agent instructions used by tools, reminders, and reports. */
export const PLAN_GUIDANCE =
  "Before requesting a plan, inspect relevant source and include the requested outcome, confirmed constraints, " +
  "existing work, and established decisions. Use only the steps the task needs, each with an observable outcome " +
  "and completion check. Keep unverified implementation choices flexible and preservation requirements as acceptance criteria.";

export const PLAN_ALIGNMENT_GUIDANCE =
  "PLAN ALIGNMENT: Check the current step before starting a new batch. A partial diff, unfinished step, or unchanged " +
  "preservation check does not make a plan stale. Verify a stale warning against the cited plan text, code, and developer " +
  "decision. Correct a tracker error with done:<step number>; use planUpdate with the changed decision and remaining work " +
  "when the plan itself needs revision. Keep explicit user requirements; do not rewrite them just to obtain a pass.";

export const REVIEW_SCOPE_GUIDANCE =
  "Use files:[...] or exclude:[...] for focused feedback on edited files and directly affected tests/types/config. " +
  "A scoped or historical pass cannot clear the done gate or advance the plan. Before certifying a step or " +
  "completing the task, run a complete whole-tree review without files, exclude, revision, or since, with new files included. " +
  "Naming files in the description is a focus hint, not a diff filter.";

export const REVIEW_PROGRESS_GUIDANCE =
  "A passing whole-tree review may already advance the plan. Inspect review.planProgress/review.nextStep or " +
  "wai_index({ topic: 'plan' }) before calling done:true. Call done only if the same reviewed step remains current " +
  "and its acceptance criteria are met; do not advance an unfinished next step.";

export const INCONCLUSIVE_REVIEW_GUIDANCE =
  "An inconclusive review does not certify completion. Check diagnostics, the working directory, requested files/VCS range, " +
  "input/output truncation, and whether the active plan matches the code. Resolve the cause, then re-run `wai.review`. " +
  "Scoped reviews can help diagnose a large diff, but final certification still requires complete whole-tree coverage. " +
  "If the cause remains unresolved, report the blocker; do not retry unchanged input repeatedly or lower thinking depth blindly.";

export const COMMIT_GUIDANCE =
  "Commit when the user requests or has already authorized it. Before committing, inspect the exact commit contents, " +
  "include intended new files, and preserve unrelated user changes. Otherwise report that the work is ready to commit. " +
  "A review pass is not commit authorization.";

export const GIT_COMMIT_GUIDANCE =
  "GIT WORKFLOW: In Git working trees, before the final whole-tree review, inspect `git status` and stage only intended task files or hunks, " +
  "using explicit paths for `git add`. Before an authorized commit, inspect `git diff --cached` and verify intended new " +
  "files are included and unrelated changes, .pi/, and generated outputs are not accidentally staged. " +
  "If staging changes after review, run the whole-tree review again.";

export const COMPLETION_EVIDENCE_GUIDANCE =
  "In the completion report, state checks actually run and their outcomes, skipped or failing checks, review/judge scope " +
  "and coverage, unresolved findings, acceptance criteria verified or still unverified, and commit status/hash. " +
  "A model pass or generic test success alone does not verify every acceptance criterion.";

export function buildPlanReviewReminder(completedSteps: number, totalSteps: number): string {
  return ` For current plan step (${completedSteps + 1}/${totalSteps}), ${REVIEW_PROGRESS_GUIDANCE}`;
}
