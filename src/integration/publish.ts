import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WaiToolResult } from "../types.js";
import { updateWaiStatus } from "./status.js";
import { updateWaiPlanWidget } from "./widget.js";
import { auditPlanEvent, auditStepDone, auditReview, auditJudge, auditScan } from "./audit.js";

/** Publish a wai result to all Pi integration surfaces: footer status and
 *  session audit entries. Called from both the tool executor and slash commands.
 *  Errors are swallowed so publishing cannot break a tool/command. */
export function publishWaiResult(ctx: ExtensionContext, result: WaiToolResult): void {
  try {
    updateWaiStatus(ctx);
  } catch {
    // best-effort status update
  }

  try {
    updateWaiPlanWidget(ctx);
  } catch {
    // best-effort widget update
  }

  if (result.error) return;

  try {
    switch (result.action) {
      case "plan":
        if (result.plan) {
          auditPlanEvent(ctx, "plan-created", result.plan.summary, result.plan.todo.length);
        }
        break;
      case "planUpdate":
        if (result.done) {
          auditPlanEvent(ctx, "plan-updated", result.done.message, result.done.totalSteps, result.done.completedStep);
        }
        break;
      case "review":
        if (result.review) {
          auditReview(ctx, result.review.verdict === "pass" ? "pass" : "needs-work", result.review.issues.length);
        }
        break;
      case "judge":
        if (result.judge) {
          auditJudge(ctx, result.judge.verdict === "pass" ? "pass" : "needs-work", result.judge.issues.length);
        }
        break;
      case "done":
        if (result.done) {
          auditStepDone(ctx, result.done.completedStep, result.done.totalSteps, result.done.verified);
        }
        break;
      case "scan":
        if (result.scan) {
          auditScan(ctx);
        }
        break;
    }
  } catch {
    // best-effort audit
  }
}
