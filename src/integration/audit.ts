import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { planStepDescription } from "../types.js";
import { getState } from "../session-state.js";

export type WaiAuditEntryType =
  | "plan-created"
  | "plan-updated"
  | "step-done"
  | "review-pass"
  | "review-needs-work"
  | "judge-pass"
  | "judge-needs-work"
  | "scan-complete";

export interface WaiAuditEntry {
  type: WaiAuditEntryType;
  timestamp: string;
  cwd: string;
  summary?: string;
  completed?: number;
  total?: number;
  step?: string;
  issueCount?: number;
  message?: string;
}

let extensionAPI: ExtensionAPI | undefined;

/** Store the extension API so audit helpers can append session entries
 *  without threading `pi` through every action. There is one ExtensionAPI
 *  instance per process, so a module-level reference is safe. */
export function setAuditExtensionAPI(pi: ExtensionAPI): void {
  extensionAPI = pi;
}

function appendEntry(entry: Omit<WaiAuditEntry, "timestamp">): void {
  if (!extensionAPI) return;
  try {
    extensionAPI.appendEntry("wai", { ...entry, timestamp: new Date().toISOString() });
  } catch {
    // best-effort audit logging
  }
}

/** Append a session entry recording that a plan was created or updated. */
export function auditPlanEvent(
  ctx: ExtensionContext,
  type: "plan-created" | "plan-updated",
  summary: string,
  total: number,
  completed?: number,
): void {
  appendEntry({
    type,
    cwd: ctx.cwd,
    summary,
    total,
    completed,
  });
}

/** Append a session entry recording step completion via /wai-done. */
export function auditStepDone(ctx: ExtensionContext, completed: number, total: number, verified?: boolean): void {
  const state = getState(ctx.cwd);
  const step =
    state.plan && completed > 0 && completed <= state.plan.todo.length
      ? planStepDescription(state.plan.todo[completed - 1])
      : undefined;
  appendEntry({
    type: "step-done",
    cwd: ctx.cwd,
    completed,
    total,
    step,
    message: verified === false ? "verification failed" : verified === true ? "verified" : undefined,
  });
}

/** Append a session entry recording a review verdict. */
export function auditReview(ctx: ExtensionContext, verdict: "pass" | "needs-work", issueCount?: number): void {
  appendEntry({
    type: verdict === "pass" ? "review-pass" : "review-needs-work",
    cwd: ctx.cwd,
    issueCount,
  });
}

/** Append a session entry recording a judge verdict. */
export function auditJudge(ctx: ExtensionContext, verdict: "pass" | "needs-work", issueCount?: number): void {
  appendEntry({
    type: verdict === "pass" ? "judge-pass" : "judge-needs-work",
    cwd: ctx.cwd,
    issueCount,
  });
}

/** Append a session entry recording that a scan completed. */
export function auditScan(ctx: ExtensionContext): void {
  appendEntry({
    type: "scan-complete",
    cwd: ctx.cwd,
  });
}
