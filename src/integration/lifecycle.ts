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
import { getEditTracker, getState, recordFileEdit, markJudgeCompleted } from "../session-state.js";
import { executeWaiJudge } from "../actions/judge.js";
import { formatResultText } from "../format.js";
import { clearWaiStatus } from "../progress.js";
import { type LoopDetectionState } from "../loop-detector.js";
import { logEvent } from "../logger.js";
import type { WaiToolResult } from "../types.js";
import { updateWaiStatus } from "./status.js";
import { flushSessionState } from "../session-state.js";
import { unregisterWaiProvider } from "./provider.js";

const STEER_COOLDOWN_MS = 30_000;

/** Tracks cwd's with an in-flight auto-judge so overlapping triggers
 *  (e.g. /wai-done + agent_settled) do not run judge twice. */
const judgingCwds = new Set<string>();

export type JudgeRunner = (
  cwd: string,
  description: string,
  signal: AbortSignal | undefined,
  progress: (stage: number, total: number, message: string) => void,
  sessionManager?: ExtensionContext["sessionManager"],
) => Promise<WaiToolResult>;

export interface LifecycleDeps {
  executeWaiJudge?: JudgeRunner;
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
        recordFileEdit(ctx.cwd);
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
      const now = Date.now();
      if (state.lastSteerAt && now - state.lastSteerAt < STEER_COOLDOWN_MS) return;

      const config = loadYoowaiConfig(ctx.cwd);
      const { changedFiles } = getDiff(ctx.cwd, { maxDiffChars: config.reviewMaxDiffChars });
      const fileList = changedFiles.length > 0 ? ` in: ${changedFiles.slice(0, 5).join(", ")}` : "";

      state.lastSteerAt = now;
      pi.sendUserMessage(
        `WORKFLOW REMINDER: you have made ${editState.editsSinceLastReview} file edit(s) since the last review. ` +
          `Call \`wai({ review: '...' })\` to review the changes${fileList} before continuing.`,
        { deliverAs: "steer" },
      );
      updateWaiStatus(ctx);
    } catch {
      // best-effort steer
    }
  });

  pi.on("agent_settled", async (_event: AgentSettledEvent, ctx) => {
    try {
      await triggerAutoJudge(ctx, undefined, deps.executeWaiJudge);
      updateWaiStatus(ctx);
    } catch {
      // best-effort auto-judge
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
      flushSessionState(ctx.cwd);
      unregisterWaiProvider(pi, ctx.cwd);
    } catch {
      // best-effort flush
    }
  });

  pi.on("session_before_fork", async (_event: SessionBeforeForkEvent, ctx) => {
    try {
      flushSessionState(ctx.cwd);
      unregisterWaiProvider(pi, ctx.cwd);
    } catch {
      // best-effort flush
    }
  });

  pi.on("session_compact", async (_event: SessionCompactEvent, ctx) => {
    try {
      flushSessionState(ctx.cwd);
    } catch {
      // best-effort flush
    }
  });
}
