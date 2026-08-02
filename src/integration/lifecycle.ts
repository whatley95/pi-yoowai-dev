import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  ToolResultEvent,
  TurnEndEvent,
  AgentSettledEvent,
  SessionBeforeCompactEvent,
  SessionBeforeSwitchEvent,
  SessionBeforeForkEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { isWriteToolResult, isEditToolResult } from "@earendil-works/pi-coding-agent";
import { isFileWriteTool } from "../file-write-tools.js";
import { loadYoowaiConfig } from "../config.js";
import { clearPromptCache } from "../prompts.js";
import { getDiff } from "../diff-grabber.js";
import {
  getEditTracker,
  getState,
  recordFileEdit,
  markJudgeCompleted,
  recordUnreviewedTurn,
} from "../session-state.js";
import { executeWaiJudge } from "../actions/judge.js";
import { executeWaiReview } from "../actions/review.js";
import { formatResultText } from "../format.js";
import { clearWaiStatus } from "../progress.js";
import { type LoopDetectionState } from "../loop-detector.js";
import { logEvent } from "../logger.js";
import { planStepDescription, type WaiToolResult } from "../types.js";
import { updateWaiStatus } from "./status.js";
import { publishWaiResult } from "./publish.js";
import { auditUnreviewedEdits } from "./audit.js";
import { setWaiToolExecuting } from "./context-injector.js";
import { flushSessionState, resetEditsSinceReview } from "../session-state.js";
import { unregisterWaiProvider } from "./provider.js";

const STEER_COOLDOWN_MS = 30_000;

/** Tracks cwd's with an in-flight auto-judge so overlapping triggers
 *  (e.g. /wai-done + agent_settled) do not run judge twice. */
const judgingCwds = new Set<string>();

/** Tracks cwd's with an in-flight auto-review so a settle-triggered review
 *  cannot retrigger itself or run twice for the same settle. */
const reviewingCwds = new Set<string>();

export type JudgeRunner = (
  cwd: string,
  description: string,
  signal: AbortSignal | undefined,
  progress: (stage: number, total: number, message: string) => void,
  sessionManager?: ExtensionContext["sessionManager"],
) => Promise<WaiToolResult>;

export type ReviewRunner = (
  cwd: string,
  description: string,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  progress: (stage: number, total: number, message: string) => void,
) => Promise<WaiToolResult>;

const defaultReviewRunner: ReviewRunner = (cwd, description, ctx, signal, progress) =>
  executeWaiReview(cwd, description, ctx, {}, signal, progress);

export interface LifecycleDeps {
  executeWaiJudge?: JudgeRunner;
  executeWaiReview?: ReviewRunner;
  clearPromptCache?: () => void;
}

/** Trigger auto-judge when the plan is complete and autoJudge is enabled.
 *  Safe to call from both /wai-done and agent_settled. */
export async function triggerAutoJudge(
  ctx: ExtensionContext | ExtensionCommandContext,
  situation?: string,
  runJudge: JudgeRunner = executeWaiJudge,
): Promise<void> {
  if (judgingCwds.has(ctx.cwd)) return;

  const config = loadYoowaiConfig(ctx.cwd);
  if (!config.autoJudge) return;

  const state = getState(ctx.cwd);
  if (state.judgeCompleted || state.totalSteps === 0 || state.completedSteps < state.totalSteps) {
    return;
  }

  judgingCwds.add(ctx.cwd);

  const notify = (stage: number, total: number, message: string) => {
    try {
      ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
    } catch {
      // ignore if UI is unavailable
    }
  };

  try {
    const judgeResult = await runJudge(
      ctx.cwd,
      situation ?? `All ${state.totalSteps} plan steps completed.`,
      undefined,
      notify,
      ctx.sessionManager,
    );
    markJudgeCompleted(ctx.cwd);
    // Publish so the auto-judge verdict is audited and the footer/widget
    // reflect any tracker sync immediately, not after the next wai call.
    publishWaiResult(ctx, judgeResult);
    const text = formatResultText(judgeResult);
    ctx.ui.notify(text.slice(0, 500), judgeResult.error ? "error" : "info");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent(ctx.cwd, "error", "Auto-judge failed", { error: message });
    ctx.ui.notify(`Auto-judge failed: ${message}`, "error");
  } finally {
    judgingCwds.delete(ctx.cwd);
    clearWaiStatus(ctx);
  }
}

/** Trigger auto-review when the agent settles with unreviewed edits pending
 *  and autoReviewOnSettle is enabled. Runs before any auto-judge; a budget
 *  error is logged and skipped quietly. Guarded against re-entrancy: one
 *  review per settle, and context injection is suppressed while it runs. */
export async function triggerAutoReview(
  ctx: ExtensionContext | ExtensionCommandContext,
  runReview: ReviewRunner = defaultReviewRunner,
): Promise<void> {
  if (reviewingCwds.has(ctx.cwd)) return;

  const config = loadYoowaiConfig(ctx.cwd);
  if (!config.autoReviewOnSettle) return;

  const pendingEdits = getEditTracker(ctx.cwd).editsSinceLastReview;
  if (pendingEdits <= 0) return;

  reviewingCwds.add(ctx.cwd);
  // Suppress context injection while the review runs so the injector does not
  // feed the workflow reminder back into the review prompt.
  setWaiToolExecuting(ctx.cwd, true);

  const notify = (stage: number, total: number, message: string) => {
    try {
      ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
    } catch {
      // ignore if UI is unavailable
    }
  };

  try {
    const result = await runReview(
      ctx.cwd,
      `Auto-review of ${pendingEdits} unreviewed edit(s) after the agent settled.`,
      ctx,
      undefined,
      notify,
    );
    if (result.error) {
      // A budget error means the review was intentionally skipped to respect
      // the configured cost cap — log it and stay quiet.
      if (result.error.includes("budget")) {
        logEvent(ctx.cwd, "info", "Auto-review skipped: cost budget reached", { error: result.error });
        return;
      }
      logEvent(ctx.cwd, "warn", "Auto-review failed", { error: result.error });
      ctx.ui.notify(`Auto-review failed: ${result.error}`, "error");
      return;
    }
    resetEditsSinceReview(ctx.cwd);
    // Publish so the auto-review verdict is audited and the footer/widget
    // reflect the cleared edit counter immediately.
    publishWaiResult(ctx, result);
    const text = formatResultText(result);
    ctx.ui.notify(text.slice(0, 500), "info");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent(ctx.cwd, "error", "Auto-review failed", { error: message });
    ctx.ui.notify(`Auto-review failed: ${message}`, "error");
  } finally {
    reviewingCwds.delete(ctx.cwd);
    setWaiToolExecuting(ctx.cwd, false);
  }
}

/** Flush session state to disk and append a session audit entry when edits
 *  are still unreviewed, so abandoned review work stays visible. */
export function flushSessionStateWithAudit(ctx: ExtensionContext | ExtensionCommandContext): void {
  const state = getState(ctx.cwd);
  const pendingEdits = state.editsSinceLastReview;
  const unreviewedTurns = state.unreviewedTurns ?? 0;
  flushSessionState(ctx.cwd);
  if (pendingEdits > 0) {
    auditUnreviewedEdits(ctx, pendingEdits, unreviewedTurns);
  }
}

/** Best-effort extraction of the target file path from a write/edit tool
 *  result's input. Tool schemas vary (`path`, `file_path`, ...), so probe the
 *  common keys. Returned relative to cwd for display. */
function extractEditedFilePath(event: ToolResultEvent, cwd: string): string | undefined {
  const input = (event as { input?: unknown }).input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "filename"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      const normalized = value.replace(/\\/g, "/");
      const prefix = cwd.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
      return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    }
  }
  return undefined;
}

export function registerLifecycleHandlers(
  pi: ExtensionAPI,
  _loopStates: Map<string, LoopDetectionState>,
  deps: LifecycleDeps = {},
): void {
  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    try {
      // Count successful file mutations accurately. Failed/aborted/error results
      // do not represent completed edits.
      if ((isWriteToolResult(event) || isEditToolResult(event)) && !event.isError) {
        recordFileEdit(ctx.cwd, extractEditedFilePath(event, ctx.cwd));
        updateWaiStatus(ctx);
      }
    } catch {
      // best-effort lifecycle tracking
    }
  });

  pi.on("turn_end", async (event: TurnEndEvent, ctx) => {
    try {
      // Do not send workflow steers from wai tool results; only from real edits.
      const toolResults = event.toolResults;
      const hadRealEdit = toolResults.some((tr) => isFileWriteTool(tr.toolName) && !tr.isError);
      if (!hadRealEdit) return;

      const editState = getEditTracker(ctx.cwd);
      if (editState.editsSinceLastReview <= 0) return;

      const state = getState(ctx.cwd);
      // The turn ended with review pending and no review call in between.
      recordUnreviewedTurn(ctx.cwd);
      const now = Date.now();
      if (state.lastSteerAt && now - state.lastSteerAt < STEER_COOLDOWN_MS) return;

      const config = loadYoowaiConfig(ctx.cwd);
      // Prefer the files the agent actually edited (accurate and VCS-independent);
      // fall back to the diff's changed files when paths could not be captured.
      let changedFiles = editState.editedFiles;
      if (changedFiles.length === 0) {
        changedFiles = getDiff(ctx.cwd, { maxDiffChars: config.reviewMaxDiffChars }).changedFiles;
      }
      const fileList =
        changedFiles.length > 0
          ? ` in: ${changedFiles.slice(0, 5).join(", ")}${changedFiles.length > 5 ? ` (+${changedFiles.length - 5} more)` : ""}`
          : "";

      state.lastSteerAt = now;
      // Nudge the plan tick too: tracker drift mostly happens because agents
      // review but forget to mark the step done. Only when a plan is active.
      const planNudge =
        state.plan && state.completedSteps < state.totalSteps
          ? ` If this work completes the current plan step (${state.completedSteps + 1}/${state.totalSteps}), call \`wai({ done: true })\` after the review passes to keep the plan tracker in sync.`
          : "";
      const noPlanNudge =
        !state.plan || state.totalSteps === 0
          ? ` No active wai plan — if this is non-trivial work, create one first with \`wai({ plan: '...' })\`.`
          : "";
      // After K consecutive turns with review pending, escalate from a gentle
      // reminder to an explicit stop directive. The counter resets on review.
      const escalated = (state.unreviewedTurns ?? 0) >= (config.steerEscalationThreshold ?? 3);
      // With an active plan, the reminder names the current step so the nag is
      // tied to the plan unit; without one it falls back to the plain message.
      const stepLabel =
        state.plan && state.completedSteps < state.totalSteps
          ? `Step ${state.completedSteps + 1}/${state.totalSteps} (${planStepDescription(state.plan.todo[state.completedSteps])})`
          : undefined;
      const reminder = escalated
        ? stepLabel
          ? `STOP. Do not continue new work until \`wai review\` has been run on the pending edits. ` +
            `${stepLabel} has ${editState.editsSinceLastReview} unreviewed file edit(s)${fileList} spanning ${state.unreviewedTurns} turn(s). ` +
            `Call \`wai({ review: '...' })\` now.`
          : `STOP. Do not continue new work until \`wai review\` has been run on the pending edits. ` +
            `You have ${editState.editsSinceLastReview} unreviewed file edit(s)${fileList} spanning ${state.unreviewedTurns} turn(s). ` +
            `Call \`wai({ review: '...' })\` now.`
        : stepLabel
          ? `WORKFLOW REMINDER: ${stepLabel} has ${editState.editsSinceLastReview} unreviewed file edit(s)${fileList}. ` +
            `Call \`wai({ review: '...' })\` to review the changes before continuing.`
          : `WORKFLOW REMINDER: you have made ${editState.editsSinceLastReview} file edit(s) since the last review. ` +
            `Call \`wai({ review: '...' })\` to review the changes${fileList} before continuing.`;
      pi.sendUserMessage(`${reminder}${planNudge}${noPlanNudge}`, { deliverAs: "steer" });
      updateWaiStatus(ctx);
    } catch {
      // best-effort steer
    }
  });

  pi.on("agent_settled", async (_event: AgentSettledEvent, ctx) => {
    try {
      // Auto-review runs first: pending edits get reviewed before the judge
      // looks at the whole plan, and a passing review may complete the plan.
      await triggerAutoReview(ctx, deps.executeWaiReview);
      await triggerAutoJudge(ctx, undefined, deps.executeWaiJudge);
      updateWaiStatus(ctx);
    } catch {
      // best-effort auto-review/auto-judge
    }
  });

  pi.on("model_select", async () => {
    try {
      (deps.clearPromptCache ?? clearPromptCache)();
    } catch {
      // best-effort cache clear
    }
  });

  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
    try {
      const state = getState(ctx.cwd);
      if (!state.plan || state.totalSteps === 0) return;
      const current = state.plan.todo[state.completedSteps];
      const currentStep = typeof current === "string" ? current : current?.description;
      const lines = [
        `Active wai plan: ${state.plan.summary}`,
        `Progress: ${state.completedSteps}/${state.totalSteps} steps completed.`,
      ];
      if (currentStep) lines.push(`Current step: ${currentStep}`);
      event.customInstructions = [event.customInstructions, ...lines].filter(Boolean).join("\n");
    } catch {
      // best-effort compaction context
    }
  });

  pi.on("session_before_switch", async (_event: SessionBeforeSwitchEvent, ctx) => {
    try {
      flushSessionStateWithAudit(ctx);
      unregisterWaiProvider(pi, ctx.cwd);
    } catch {
      // best-effort flush
    }
  });

  pi.on("session_before_fork", async (_event: SessionBeforeForkEvent, ctx) => {
    try {
      flushSessionStateWithAudit(ctx);
      unregisterWaiProvider(pi, ctx.cwd);
    } catch {
      // best-effort flush
    }
  });

  pi.on("session_compact", async (_event: SessionCompactEvent, ctx) => {
    try {
      flushSessionStateWithAudit(ctx);
    } catch {
      // best-effort flush
    }
  });
}
