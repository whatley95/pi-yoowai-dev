import type { ReviewRecovery, WaiToolResult } from "./types.js";
import { planStepDescription } from "./types.js";
import { getState } from "./session-state.js";

function recovery(
  reason: ReviewRecovery["reason"],
  message: string,
  nextAction: string,
  affectedFiles?: string[],
): ReviewRecovery {
  return { reason, message, nextAction, retry: "after-change", ...(affectedFiles?.length ? { affectedFiles } : {}) };
}

/** Diagnose local capture/validation flags, never suggestions or a model's guessed cause. */
export function getReviewRecovery(result: WaiToolResult): ReviewRecovery | undefined {
  if (result.recovery) return result.recovery;
  if (result.action !== "review") return undefined;
  if (result.error) {
    const message = result.error;
    if (/cost budget|budget exceeded|exceed.*cost budget/i.test(message))
      return recovery(
        "budget-exceeded",
        message,
        "Inspect wai_index({topic:'cost'}) and the configured budget; resume only after the budget or request changes.",
      );
    if (/failed to parse review|review could not be produced|invalid JSON/i.test(message))
      return recovery(
        "malformed-output",
        message,
        "Inspect wai logs and response validation; correct output configuration or missing evidence before another review. Keep the requested thinking depth.",
      );
    if (/workspace changed|fingerprinted during review/i.test(message))
      return recovery(
        "workspace-changed",
        message,
        "Finish pending edits and checks, then review the current working tree again.",
      );
    if (/context budget|truncate|too large for/i.test(message))
      return recovery(
        "input-coverage",
        message,
        "Inspect capture and context limits; use a model/strategy that can cover the complete change. Focused reviews give feedback but cannot certify the whole tree.",
      );
    if (/no secondary model configured|missing API key|unauthorized|401|re-login/i.test(message))
      return {
        ...recovery(
          "model-unavailable",
          message,
          "Check /wai-model, /wai-test, and Pi authentication before retrying.",
        ),
        retry: "manual",
      };
    return {
      ...recovery(
        "review-failed",
        message,
        "Inspect wai_index({topic:'logs'}) for the failed operation; correct the cause before retrying. Do not lower thinking depth blindly.",
      ),
      retry: "manual",
    };
  }
  const review = result.review;
  if (!review) return undefined;
  if (review.checksFailed)
    return recovery(
      "checks-failed",
      "A configured project check exited unsuccessfully.",
      "Inspect the check output, fix the failure, and run the checks and review again. A model pass cannot replace passing checks.",
    );
  if (review.inputIncomplete)
    return recovery(
      "diff-unavailable",
      "No complete diff was captured.",
      "Verify the project root, requested paths, and VCS range; include new files and re-run after capture succeeds.",
    );
  if (result.continuation?.status === "truncated-after-cap")
    return recovery(
      "output-truncated",
      "The model output remained truncated after continuation.",
      "Inspect the output limit and continuation diagnostics; obtain a complete result before advancing. Keep the requested thinking depth.",
    );
  if (review.contextLimited || review.truncated || review.droppedFiles?.length)
    return recovery(
      "input-coverage",
      "Some review evidence or file coverage was incomplete.",
      "Inspect omitted files and capture/context diagnostics. Obtain complete whole-tree coverage before certification.",
      review.droppedFiles,
    );
  if (review.planStale)
    return recovery(
      "plan-mismatch",
      "The model reported a plan mismatch; it requires evidence checks.",
      "Compare the cited plan step, code, and explicit user requirements. Correct tracker progress or update the plan only for a confirmed mismatch.",
    );
  if (review.inconclusive)
    return recovery(
      "verdict-without-findings",
      "The non-pass response supplied no actionable finding.",
      "Inspect the response and missing evidence; ask for concrete file/line findings or an evidence-backed verdict. Do not repeat unchanged requests indefinitely.",
    );
  return undefined;
}

export function withReviewRecovery(result: WaiToolResult): WaiToolResult {
  const info = getReviewRecovery(result);
  return info ? { ...result, recovery: info } : result;
}

/** Snapshot actual tracker state after outcome application, not model completion claims. */
export function attachWorkflowMetadata(cwd: string, result: WaiToolResult): void {
  const state = getState(cwd);
  const current = state.plan?.todo[state.completedSteps];
  result.workflow = {
    completedSteps: state.completedSteps,
    totalSteps: state.totalSteps,
    ...(current ? { currentStep: planStepDescription(current) } : {}),
    pendingEdits: state.editsSinceLastReview,
    reviewPending: state.editsSinceLastReview > 0 || state.reviewBlocked === true,
  };
  result.recovery = getReviewRecovery(result);
}
