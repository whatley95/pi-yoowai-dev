import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WaiToolResult, WaiModelTask, ReviewLevel } from "./types.js";
import { Type } from "@sinclair/typebox";
import { loadYoowaiConfig, resolveTaskModel } from "./config.js";
import { resolveReviewLevel } from "./review-level.js";
import { setPiSessionId, clearPiSessionId } from "./secondary-model.js";

import {
  renderCall,
  renderResult,
  renderReviewToolCall,
  renderIndexCall,
  renderExplainCall,
  renderVisionCall,
  renderLearnCall,
  renderDesignRefCall,
  renderAuxResult,
} from "./render.js";
import { resetCost } from "./cost-tracker.js";
import { logEvent } from "./logger.js";
import {
  createLoopDetectionState,
  recordToolCall,
  checkLoop,
  shouldSendSteer,
  type LoopDetectionState,
} from "./loop-detector.js";
import { createProgressReporter, clearWaiStatus } from "./progress.js";
import { setSessionId, clearSessionId, pruneSessionDirs } from "./session-scope.js";
import { validateWaiToolParams } from "./wai-tool-params.js";
import {
  recordLearnedFact,
  findLearnedFacts,
  verifyLearnedFacts,
  verifyLearnedFactsDeep,
  formatVerificationReport,
} from "./wai-learn.js";
import { listDesignRefDocs, readDesignRefDoc, DESIGN_REF_TOPIC_DESCRIPTIONS } from "./design-ref.js";
import { dropSessionState, resetEditsSinceDone, resetEditsSinceReview } from "./session-state.js";
import { secondaryModelLabel } from "./actions/shared.js";
import { executeWaiPlan } from "./actions/plan.js";
import { executeWaiReview } from "./actions/review.js";
import { executeWaiTest } from "./actions/test.js";
import { executeWaiSecurity } from "./actions/security.js";
import { executeWaiSuggest } from "./actions/suggest.js";
import { executeWaiRecommend } from "./actions/recommend.js";
import { executeWaiJudge } from "./actions/judge.js";
import { executeWaiScan } from "./actions/scan.js";
import { executeWaiDone } from "./actions/done.js";
import { executeWaiPlanUpdate } from "./actions/plan-update.js";
import { executeWaiIndex, formatIndexResult, validateWaiIndexParams } from "./wai-index.js";
import { executeWaiExplain, validateWaiExplainParams } from "./wai-explain.js";
import { executeWaiVision, validateWaiVisionParams } from "./wai-vision.js";
import { registerWaiCommands } from "./commands/register.js";
import { formatResultText } from "./format.js";
import { registerContextInjector, setWaiToolExecuting } from "./integration/context-injector.js";
import { registerLifecycleHandlers, flushSessionStateWithAudit } from "./integration/lifecycle.js";
import { updateWaiStatus, clearWaiStatusLines } from "./integration/status.js";
import { setAuditExtensionAPI } from "./integration/audit.js";
import { publishWaiResult } from "./integration/publish.js";
import { registerWaiEntryRenderer } from "./integration/entry-renderer.js";
import { registerWaiShortcuts } from "./integration/shortcuts.js";
import { updateWaiPlanWidget, hideWaiPlanWidget } from "./integration/widget.js";
import { registerWaiProvider, unregisterWaiProvider } from "./integration/provider.js";

const loopStates = new Map<string, LoopDetectionState>();
function getLoopState(cwd: string): LoopDetectionState {
  let state = loopStates.get(cwd);
  if (!state) {
    state = createLoopDetectionState();
    loopStates.set(cwd, state);
  }
  return state;
}

export default async function (pi: ExtensionAPI) {
  setAuditExtensionAPI(pi);

  pi.on("session_start", async (_event, ctx) => {
    // Probe sessionManager once; it may be unavailable in some Pi versions.
    let sessionId: string | undefined;
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch {
      /* ignore if sessionManager is unavailable */
    }

    if (sessionId) {
      // Scope volatile wai state to this Pi session so plans/memory/cost do not
      // leak across unrelated sessions on the same project.
      try {
        setSessionId(ctx.cwd, sessionId);
        // Clean up stale per-session directories from previous sessions.
        pruneSessionDirs(ctx.cwd, sessionId);
      } catch {
        /* best-effort session scoping */
      }
      // Make OpenCode session-aware so it can use sticky provider routing.
      try {
        setPiSessionId(ctx.cwd, sessionId);
      } catch {
        /* best-effort session scoping */
      }
    }

    // cost.json tracks estimated spend for the current Pi session.
    resetCost(ctx.cwd);
    updateWaiStatus(ctx);
    updateWaiPlanWidget(ctx);

    // Phase 6: optionally register the configured secondary model as a Pi provider.
    await registerWaiProvider(pi, ctx.cwd);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    flushSessionStateWithAudit(ctx);
    dropSessionState(ctx.cwd);
    loopStates.delete(ctx.cwd);
    clearPiSessionId(ctx.cwd);
    clearSessionId(ctx.cwd);
    hideWaiPlanWidget(ctx);
    clearWaiStatusLines(ctx);
    unregisterWaiProvider(pi, ctx.cwd);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    try {
      const state = getLoopState(ctx.cwd);
      recordToolCall(state, event);
      const loop = checkLoop(state);
      if (loop && shouldSendSteer(state, loop)) {
        pi.sendUserMessage(loop.message, { deliverAs: "steer" });
      }
    } catch {
      // best-effort loop detection
    }
  });

  async function runWaiTool(
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<import("@earendil-works/pi-coding-agent").AgentToolResult<WaiToolResult> & { isError: boolean }> {
    const validation = validateWaiToolParams(params);
    if (!validation.ok) {
      return {
        content: [{ type: "text", text: `wai: ${validation.error}` }],
        details: { action: "scan", error: validation.error },
        isError: true,
      };
    }
    const p = validation.params;
    const action = validation.action;
    const config = loadYoowaiConfig(ctx.cwd);

    setWaiToolExecuting(ctx.cwd, true);

    const start = Date.now();
    const progressAction = (action === "planUpdate" ? "plan" : action) as WaiModelTask;
    const progress = createProgressReporter(
      progressAction,
      ctx,
      onUpdate,
      // The generic wai tool has no level param; resolve the effective level
      // from config so progress lines and the footer status show it.
      p.review ? resolveReviewLevel(config) : undefined,
    );
    let result: WaiToolResult;

    try {
      if (p.plan) {
        result = await executeWaiPlan(ctx.cwd, p.plan, signal, progress, ctx.sessionManager);
      } else if (p.review) {
        result = await executeWaiReview(
          ctx.cwd,
          p.review,
          ctx,
          {
            files: p.files,
            exclude: p.exclude,
            revision: p.revision,
            since: p.since,
            vcs: p.vcs,
            untracked: p.untracked,
          },
          signal,
          progress,
        );
      } else if (p.suggest) {
        result = await executeWaiSuggest(ctx.cwd, p.suggest, signal, progress, ctx.sessionManager, {
          docs: p.docs,
        });
      } else if (p.recommend) {
        result = await executeWaiRecommend(ctx.cwd, p.recommend, signal, progress, ctx.sessionManager, {
          docs: p.docs,
        });
      } else if (p.judge) {
        result = await executeWaiJudge(ctx.cwd, p.judge, signal, progress, ctx.sessionManager);
      } else if (p.test) {
        result = await executeWaiTest(
          ctx.cwd,
          p.test,
          ctx,
          {
            files: p.files,
            exclude: p.exclude,
            revision: p.revision,
            since: p.since,
            vcs: p.vcs,
            untracked: p.untracked,
          },
          signal,
          progress,
        );
      } else if (p.security) {
        result = await executeWaiSecurity(
          ctx.cwd,
          p.security,
          ctx,
          {
            files: p.files,
            exclude: p.exclude,
            revision: p.revision,
            since: p.since,
            vcs: p.vcs,
            untracked: p.untracked,
          },
          signal,
          progress,
        );
      } else if (p.done !== undefined) {
        result = { action: "done", done: await executeWaiDone(ctx.cwd, p.done as string | number, signal, p.force) };
      } else if (p.planUpdate !== undefined) {
        result = {
          action: "planUpdate",
          done: await executeWaiPlanUpdate(ctx.cwd, p.planUpdate as string, signal, progress, ctx.sessionManager),
        };
      } else {
        result = await executeWaiScan(ctx.cwd, signal, progress, ctx.sessionManager, p.scanDeep);
      }

      // Only clear the review-edit counter when the review actually ran. An
      // errored review (e.g. model unavailable) saw nothing, so resetting here
      // would suppress the unreviewed-edits steer for work no one looked at.
      if (p.review && !result.error) resetEditsSinceReview(ctx.cwd);
      // Only clear the done-edit counter when the step actually advanced. A
      // failed verification or a review-gate block returns early without
      // advancing, so clearing here would let the next retry bypass the gate.
      if (p.done !== undefined && !(result.done && (result.done.verified === false || result.done.blocked === true))) {
        resetEditsSinceDone(ctx.cwd);
      }
    } catch (err) {
      logEvent(ctx.cwd, "error", `wai tool ${action} failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
      result = { action, error: err instanceof Error ? err.message : String(err) };
    } finally {
      setWaiToolExecuting(ctx.cwd, false);
      clearWaiStatus(ctx);
    }

    publishWaiResult(ctx, result);

    result.elapsedMs = Date.now() - start;

    const shouldVerify = p.verify ?? config.verifyByDefault ?? false;
    if (shouldVerify && !result.error) {
      result.verificationRequested = true;
    }

    const text = formatResultText(result);

    return {
      content: [{ type: "text", text }],
      details: result,
      isError: Boolean(result.error),
    };
  }

  interface WaiReviewToolParams {
    description: string;
    files?: string[];
    exclude?: string[];
    revision?: string;
    since?: string;
    vcs?: "git" | "svn";
    untracked?: boolean;
    verify?: boolean;
    docs?: string[];
  }

  function validateWaiReviewToolParams(
    params: unknown,
  ): { ok: true; params: WaiReviewToolParams } | { ok: false; error: string } {
    if (!params || typeof params !== "object") {
      return { ok: false, error: "Invalid parameters: expected an object." };
    }
    const p = params as Record<string, unknown>;
    if (typeof p.description !== "string" || p.description.length === 0) {
      return { ok: false, error: "Missing or empty 'description' parameter." };
    }
    const stringArray = (value: unknown): string[] | undefined => {
      if (!Array.isArray(value)) return undefined;
      const filtered = value.filter((v): v is string => typeof v === "string" && v.length > 0);
      return filtered.length > 0 ? filtered : undefined;
    };
    return {
      ok: true,
      params: {
        description: p.description,
        files: stringArray(p.files),
        exclude: stringArray(p.exclude),
        revision: typeof p.revision === "string" ? p.revision : undefined,
        since: typeof p.since === "string" ? p.since : undefined,
        vcs: p.vcs === "git" || p.vcs === "svn" ? p.vcs : undefined,
        untracked: p.untracked === true ? true : undefined,
        verify: p.verify === true ? true : undefined,
        docs: stringArray(p.docs),
      },
    };
  }

  async function runWaiReviewTool(
    level: ReviewLevel,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<import("@earendil-works/pi-coding-agent").AgentToolResult<WaiToolResult> & { isError: boolean }> {
    const validation = validateWaiReviewToolParams(params);
    if (!validation.ok) {
      return {
        content: [{ type: "text", text: `wai_review_${level}: ${validation.error}` }],
        details: { action: "review", error: validation.error },
        isError: true,
      };
    }
    const p = validation.params;
    const config = loadYoowaiConfig(ctx.cwd);

    setWaiToolExecuting(ctx.cwd, true);
    const start = Date.now();
    const progress = createProgressReporter("review", ctx, onUpdate, level);
    let result: WaiToolResult;

    try {
      result = await executeWaiReview(
        ctx.cwd,
        p.description,
        ctx,
        {
          files: p.files,
          exclude: p.exclude,
          revision: p.revision,
          since: p.since,
          vcs: p.vcs,
          untracked: p.untracked,
          level,
        },
        signal,
        progress,
      );
      if (!result.error) resetEditsSinceReview(ctx.cwd);
    } catch (err) {
      logEvent(ctx.cwd, "error", `wai_review_${level} failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
      result = { action: "review", error: err instanceof Error ? err.message : String(err) };
    } finally {
      setWaiToolExecuting(ctx.cwd, false);
      clearWaiStatus(ctx);
    }

    publishWaiResult(ctx, result);
    result.elapsedMs = Date.now() - start;

    const shouldVerify = p.verify ?? config.verifyByDefault ?? false;
    if (shouldVerify && !result.error) {
      result.verificationRequested = true;
    }

    const text = formatResultText(result);

    return {
      content: [{ type: "text", text }],
      details: result,
      isError: Boolean(result.error),
    };
  }

  function reviewToolSchema() {
    return Type.Object({
      description: Type.String({
        description:
          "Describe what you just implemented. Be specific and technical: name the files/functions changed, how the change works, and why — not just the intent.",
      }),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description: "Limit the review diff to these file paths.",
        }),
      ),
      exclude: Type.Optional(
        Type.Array(Type.String(), {
          description: "Exclude these file paths from the review diff.",
        }),
      ),
      revision: Type.Optional(
        Type.String({
          description: "Compare against this revision (e.g. 'HEAD~1', '1234', '1234:HEAD').",
        }),
      ),
      since: Type.Optional(
        Type.String({
          description: "Include changes since this revision or commit ID.",
        }),
      ),
      vcs: Type.Optional(
        Type.Union([Type.Literal("git"), Type.Literal("svn")], {
          description: "Version control system to use for diff. Auto-detected if omitted.",
        }),
      ),
      untracked: Type.Optional(
        Type.Boolean({
          description: "Include untracked (new) files in the diff.",
        }),
      ),
      verify: Type.Optional(
        Type.Boolean({
          description:
            "If true, the result asks the main agent to confirm or refute the finding with evidence before acting.",
        }),
      ),
      docs: Type.Optional(
        Type.Array(Type.String(), {
          description: "Named documentation sources to include in the prompt (configured in pi-yoowai.docs.sources).",
        }),
      ),
    });
  }

  pi.registerTool({
    name: "wai",
    label: "Wai — Pair Programmer",
    description:
      "Mandatory second-opinion workflow powered by a secondary model. Always use wai.plan before implementing, wai.review after every change, wai.scan when opening a new project, wai.suggest for non-trivial architectural or design questions, wai.recommend when deciding next steps, and wai.judge before declaring work complete. Optionally use wai.test to check test coverage and failures, and wai.security to audit for vulnerabilities.",
    promptSnippet:
      "wai: always get a second opinion from the secondary model before acting on code or making architectural decisions",
    promptGuidelines: [
      "Always use wai with plan:true before starting any non-trivial implementation. The secondary model creates a structured todo list with acceptance criteria; do not write code without a plan.",
      "Always use wai with review:true after every code change. Treat review feedback as blocking; fix issues and re-run review until it returns 'pass'. You may disagree with a finding: if the code is actually correct, refute the finding with concrete evidence (file/line, test output, docs) instead of changing correct code — re-run review explaining why, use verify:true for high-stakes disagreements, and ask the user when unsure.",
      "Use wai with review:true and files:[...] to limit the review to specific files, or exclude:[...] to skip files like generated output.",
      "Pick the review depth by the change's risk and complexity: wai_review_min for docs, comments, config, tests-only, or tiny mechanical changes (renames, version bumps); wai_review_med as the default for normal features and bugfixes when unsure; wai_review_high for changes touching auth, secrets, payments, migrations, public APIs, or concurrency, and for complex logic such as algorithm changes, state machines, intricate control flow, or cross-module refactors. These tools override the configured default review level.",
      "Use wai with scan:true immediately when opening a project for the first time. Stored conventions improve all future reviews and plans. Add scanDeep:true on that first scan to also sample source files and build the project symbol index.",
      "Use wai with suggest:true whenever you are uncertain about the best approach for a specific technical question. If you are stuck, looping, or about to ask the user for help, call wai.suggest first.",
      "When the user asks a non-trivial architectural or design question where multiple valid approaches exist, call wai.suggest before answering. For simple factual questions you can verify yourself (reading files, running commands), answer directly without wai.",
      "Use wai with recommend:true whenever you need to decide what step to take next. If you have spent more than one turn without clear progress, call wai.recommend.",
      "Use wai with test:true when you want a dedicated check for missing tests, failing tests, or low test quality. This is optional; wai.review already catches many quality issues.",
      "Use wai with security:true when the change involves auth, input handling, secrets, dependencies, or any security-sensitive area. Pass a description of the function or API to audit and scope it with files:[...] if needed.",
      "Use wai with judge:true after completing all work for a final holistic review against the original plan.",
      "Use wai with done:true to mark the current plan step complete. Use it after finishing a step so the tracker stays in sync.",
      "If the plan tracker drifts from reality (e.g. progress % looks wrong for the work actually completed), correct it with wai done:<step number> — a lower number regresses the tracker, 0 resets it — or done:'all'. wai.judge also re-syncs the tracker from its completedStepIds/incompleteStepIds whenever it runs.",
      "Use wai with planUpdate:'<new task description>' when the original plan no longer matches the implementation. The plan is regenerated and already-completed progress is preserved.",
      "Enable autoJudge in settings.json to automatically run judge when the last plan step is completed (passes review or is marked done via /wai-done).",

      "Configure preReviewCommands in settings.json to run lint/test/typecheck before each review and include output in the prompt.",
      "Use `verify: true` when a wai finding is surprising, high-stakes, or unclear. The main agent must then confirm or refute the finding with evidence before acting.",
      "The secondary model should be a DIFFERENT model family than the main model to catch blind spots. Configure in settings.json under pi-yoowai.secondary.",
      "Only one action (plan/review/suggest/recommend/judge/scan/test/security/done/planUpdate) per call. Do not combine them.",
      "When stuck, confused, or looping, stop and use a wai tool. Do not spin in place or guess.",
    ],
    parameters: Type.Object({
      plan: Type.Optional(
        Type.String({
          description: "Provide a task description to get a structured todo plan with acceptance criteria.",
        }),
      ),
      review: Type.Optional(
        Type.String({
          description:
            "Provide a description of what you just implemented. Be specific and technical: name the files/functions changed, how the change works (null handling, fallbacks, edge cases), and why — not just the intent. Vague descriptions get vaguer reviews. The secondary model examines the diff and returns a verdict with issues. Uses the configured default review level (set via /wai-model or pi-yoowai.reviewLevel).",
        }),
      ),
      suggest: Type.Optional(
        Type.String({
          description:
            "Ask a specific technical or architectural question to get alternative approaches and evidence from the secondary model.",
        }),
      ),
      recommend: Type.Optional(
        Type.String({
          description: "Describe your current situation to get a recommended next step from the secondary model.",
        }),
      ),
      judge: Type.Optional(
        Type.String({
          description:
            "Provide a description of all completed work for a final holistic review against the original plan. Summarize what was actually built per step — files, behavior, edge cases handled — not just the goal.",
        }),
      ),
      scan: Type.Optional(
        Type.Boolean({
          description:
            "If true, scan project conventions and architecture patterns. Stores results for future reviews.",
        }),
      ),
      scanDeep: Type.Optional(
        Type.Boolean({
          description:
            "For scan: also sample representative source files and build the project symbol index. Recommended on the first scan of a project.",
        }),
      ),
      test: Type.Optional(
        Type.String({
          description: "Provide a description of the change to analyze test coverage, failing tests, and test quality.",
        }),
      ),
      security: Type.Optional(
        Type.String({
          description:
            "Provide a description of the change to audit it for security issues such as secrets, injection, and auth flaws.",
        }),
      ),
      done: Type.Optional(
        Type.Union([Type.Boolean(), Type.String(), Type.Number()], {
          description:
            "Mark wai plan step(s) complete. Pass true/empty string for the current step, a positive number to mark up to that step, a lower number to regress the tracker to that step (0 resets progress), 'all' for all steps, or a description to record what was completed.",
        }),
      ),
      planUpdate: Type.Optional(
        Type.Union([Type.Boolean(), Type.String()], {
          description:
            "Regenerate the active wai plan from a new task description when the original plan no longer matches the implementation. Already-completed progress is preserved.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "For done: override the requireReviewBeforeDone gate and mark the step complete without a passing review. The step is recorded as manually marked (not reviewed).",
        }),
      ),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description: "For review: limit diff to these file paths.",
        }),
      ),
      exclude: Type.Optional(
        Type.Array(Type.String(), {
          description: "For review: exclude these file paths from diff.",
        }),
      ),
      revision: Type.Optional(
        Type.String({
          description: "For review: compare against this revision (e.g. 'HEAD~1', '1234', '1234:HEAD').",
        }),
      ),
      since: Type.Optional(
        Type.String({
          description: "For review: include changes since this revision or commit ID.",
        }),
      ),
      vcs: Type.Optional(
        Type.Union([Type.Literal("git"), Type.Literal("svn")], {
          description: "Version control system to use for diff. Auto-detected if omitted.",
        }),
      ),
      untracked: Type.Optional(
        Type.Boolean({
          description: "For review: include untracked (new) files in the diff.",
        }),
      ),
      docs: Type.Optional(
        Type.Array(Type.String(), {
          description: "Named documentation sources to include in the prompt (configured in pi-yoowai.docs.sources).",
        }),
      ),
      verify: Type.Optional(
        Type.Boolean({
          description:
            "If true, the result asks the main agent to confirm or refute the finding with evidence before acting.",
        }),
      ),
    }),
    renderCall,
    renderResult,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return runWaiTool(params, signal, onUpdate as ((update: unknown) => void) | undefined, ctx);
    },
  });

  pi.registerTool({
    name: "wai_review_min",
    label: "Wai Review — Minimal",
    description:
      "Lightweight diff review for small or low-risk changes. Flags obvious bugs, syntax errors, clear regressions, and surface-level style issues. Skips architecture, speculative edge cases, and deep cross-file analysis.",
    promptSnippet: "wai_review_min: quick lightweight review for small or low-risk changes",
    promptGuidelines: [
      "Use wai_review_min for small, low-risk changes where a quick sanity check is enough.",
      "The tool uses the MINIMAL review level: it skips architecture, deep edge cases, and cross-file analysis.",
      "Pass files:[...] to scope the review, or verify:true when a finding is surprising.",
    ],
    parameters: reviewToolSchema(),
    renderCall: (args, theme, context) => renderReviewToolCall("min", args as { description?: string }, theme, context),
    renderResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return runWaiReviewTool("min", params, signal, onUpdate as ((update: unknown) => void) | undefined, ctx);
    },
  });

  pi.registerTool({
    name: "wai_review_med",
    label: "Wai Review — Standard",
    description:
      "Balanced code review for normal changes. Checks logic, correctness, tests, conventions, and cross-file impact. Flags real problems without nit-picking or speculative issues without evidence.",
    promptSnippet: "wai_review_med: standard balanced review for most changes",
    promptGuidelines: [
      "Use wai_review_med as the default review for most code changes.",
      "The tool uses the STANDARD review level: it checks logic, correctness, tests, conventions, and cross-file impact.",
      "Pass files:[...] to scope the review, or verify:true for high-stakes disagreements.",
    ],
    parameters: reviewToolSchema(),
    renderCall: (args, theme, context) => renderReviewToolCall("med", args as { description?: string }, theme, context),
    renderResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return runWaiReviewTool("med", params, signal, onUpdate as ((update: unknown) => void) | undefined, ctx);
    },
  });

  pi.registerTool({
    name: "wai_review_high",
    label: "Wai Review — Deep",
    description:
      "Thorough critical review for complex, risky, or security-sensitive changes. Examines architecture, security, edge cases, error handling, concurrency, API contracts, and cross-file implications. Strict: only passes when the change is genuinely robust.",
    promptSnippet: "wai_review_high: deep thorough review for complex or risky changes",
    promptGuidelines: [
      "Use wai_review_high for complex, risky, or security-sensitive changes.",
      "The tool uses the DEEP review level: it examines architecture, security, edge cases, error handling, concurrency, and API contracts.",
      "Pass files:[...] to scope the review, or verify:true for high-stakes findings.",
    ],
    parameters: reviewToolSchema(),
    renderCall: (args, theme, context) =>
      renderReviewToolCall("high", args as { description?: string }, theme, context),
    renderResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return runWaiReviewTool("high", params, signal, onUpdate as ((update: unknown) => void) | undefined, ctx);
    },
  });

  async function runWaiIndexTool(
    params: unknown,
    ctx: ExtensionContext,
  ): Promise<
    import("@earendil-works/pi-coding-agent").AgentToolResult<Record<string, unknown>> & { isError: boolean }
  > {
    try {
      const indexParams = validateWaiIndexParams(params);
      const result = executeWaiIndex(ctx.cwd, indexParams);
      const text = formatIndexResult(result);
      return {
        content: [{ type: "text", text }],
        details: result as unknown as Record<string, unknown>,
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent(ctx.cwd, "error", "wai_index failed", { error: message });
      return {
        content: [{ type: "text", text: `wai_index failed: ${message}` }],
        details: { error: message },
        isError: true,
      };
    }
  }

  pi.registerTool({
    name: "wai_index",
    label: "Wai Index — Project Context",
    description:
      "Read stored wai project context: conventions, active plan, review memory, session cost, and recent logs. No model call — fast and deterministic. Use this before making changes to understand the project's rules, current task, and past issues.",
    promptSnippet: "wai_index: retrieve stored project context before acting on code",
    promptGuidelines: [
      "Call wai_index when you need a quick overview of the project conventions, active plan, or recent review issues.",
      "Use topic 'conventions' to learn the project's stack, naming, structure, and patterns.",
      "Use topic 'plan' to see the current todo list and progress.",
      "Use topic 'memory' with files:[...] to see past review issues for specific files.",
      "Use topic 'cost' to check estimated spend in the current session.",
      "Use topic 'logs' to see recent wai errors or warnings.",
      "Use topic 'index' to see the project symbol index built by wai scan-deep or wai_index update.",
      "Use topic 'learned' to see facts recorded with wai_learn.",
      "Set update:true to rebuild the symbol index on demand.",
      "wai_index does not call a model; it only reads data wai already stored.",
    ],
    parameters: Type.Object({
      topic: Type.Optional(
        Type.Union(
          [
            Type.Literal("all"),
            Type.Literal("plan"),
            Type.Literal("memory"),
            Type.Literal("conventions"),
            Type.Literal("cost"),
            Type.Literal("logs"),
            Type.Literal("index"),
            Type.Literal("learned"),
          ],
          {
            description: "Which stored context to return. Defaults to 'all'.",
          },
        ),
      ),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description: "For memory topic: limit past issues to these file paths.",
        }),
      ),
      query: Type.Optional(
        Type.String({
          description: "Optional keyword filter applied to memory text and index symbols.",
        }),
      ),
      update: Type.Optional(
        Type.Boolean({
          description: "If true, rebuild the project symbol index before returning results.",
        }),
      ),
    }),
    renderCall: (args, theme, context) => renderIndexCall(args as { topic?: string; update?: boolean }, theme, context),
    renderResult: (result, opts, theme, context) => renderAuxResult("index", result, opts, theme, context),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runWaiIndexTool(params, ctx);
    },
  });

  async function runWaiExplainTool(
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<
    import("@earendil-works/pi-coding-agent").AgentToolResult<Record<string, unknown>> & { isError: boolean }
  > {
    const validation = validateWaiExplainParams(params);
    if (!validation.ok) {
      return {
        content: [{ type: "text", text: `wai_explain: ${validation.error}` }],
        details: { error: validation.error },
        isError: true,
      };
    }

    const progress = createProgressReporter("explain", ctx, onUpdate);
    const result = await executeWaiExplain(ctx.cwd, validation.params, signal, progress, ctx.sessionManager);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `wai_explain error: ${result.error}` }],
        details: { error: result.error },
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: result.result.details }],
      details: { action: "explain", explain: result.result, cost: result.cost, model: result.model },
      isError: false,
    };
  }

  pi.registerTool({
    name: "wai_explain",
    label: "Wai Explain — Code & Error Explanations",
    description:
      "Explain a code snippet, error message, diff, or file using the secondary model. Useful when the main agent encounters an unfamiliar API, a cryptic error, or wants a second pair of eyes on a piece of code.",
    promptSnippet: "wai_explain: explain this code or error before acting on it",
    promptGuidelines: [
      "Call wai_explain when you see an error you do not fully understand.",
      "Use wai_explain to get a concise explanation of a code snippet, function, or file.",
      "Pass files:[...] so the model can see full context around the target.",
      "Use context to add extra background (e.g. 'this is thrown during wai scan').",
    ],
    parameters: Type.Object({
      target: Type.String({
        description: "The code, error message, diff, or concept to explain. Required.",
      }),
      context: Type.Optional(
        Type.String({
          description: "Optional background context to help the explanation.",
        }),
      ),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional file paths to include as full context.",
        }),
      ),
      docs: Type.Optional(
        Type.Array(Type.String(), {
          description: "Named documentation sources to include in the prompt (configured in pi-yoowai.docs.sources).",
        }),
      ),
    }),
    renderCall: (args, theme, context) => renderExplainCall(args as { target?: string }, theme, context),
    renderResult: (result, opts, theme, context) => renderAuxResult("explain", result, opts, theme, context),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return runWaiExplainTool(params, signal, onUpdate as ((update: unknown) => void) | undefined, ctx);
    },
  });

  async function runWaiVisionTool(
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<
    import("@earendil-works/pi-coding-agent").AgentToolResult<Record<string, unknown>> & { isError: boolean }
  > {
    const validation = validateWaiVisionParams(params);
    if (!validation.ok) {
      return {
        content: [{ type: "text", text: `wai_vision: ${validation.error}` }],
        details: { error: validation.error },
        isError: true,
      };
    }

    const progress = createProgressReporter("vision", ctx, onUpdate);
    const result = await executeWaiVision(ctx.cwd, validation.params, signal, progress, ctx.sessionManager);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `wai_vision error: ${result.error}` }],
        details: { error: result.error },
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: result.result.details }],
      details: { action: "vision", vision: result.result, cost: result.cost, model: result.model },
      isError: false,
    };
  }

  pi.registerTool({
    name: "wai_vision",
    label: "Wai Vision — Image Analysis",
    description:
      "Analyze an image file (screenshot, diagram, error capture) with a vision-capable secondary model. " +
      "The image path must be project-relative. Requires the sdk backend and a model that accepts image input " +
      "(configure one via /wai-model for the vision task if the base model is text-only).",
    promptSnippet: "wai_vision: analyze this image before acting on it",
    promptGuidelines: [
      "Call wai_vision when the user references a screenshot, UI mockup, diagram, or error capture in the project.",
      "Pass a focused question (e.g. 'does this UI match the design rules?') to get actionable analysis instead of a generic caption.",
      "Use context to add background (e.g. 'this is the settings dialog after my change').",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Project-relative path to the image file (png, jpg, jpeg, webp, gif; max 5 MB). Required.",
      }),
      question: Type.Optional(
        Type.String({
          description: "What to analyze or answer about the image. Defaults to a full analysis.",
        }),
      ),
      context: Type.Optional(
        Type.String({
          description: "Optional background context to guide the analysis.",
        }),
      ),
    }),
    renderCall: (args, theme, context) =>
      renderVisionCall(args as { path?: string; question?: string }, theme, context),
    renderResult: (result, opts, theme, context) => renderAuxResult("vision", result, opts, theme, context),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return runWaiVisionTool(params, signal, onUpdate as ((update: unknown) => void) | undefined, ctx);
    },
  });

  async function runWaiLearnTool(
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<
    import("@earendil-works/pi-coding-agent").AgentToolResult<Record<string, unknown>> & { isError: boolean }
  > {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return {
        content: [{ type: "text", text: "wai_learn: Invalid parameters." }],
        details: { error: "Invalid parameters." },
        isError: true,
      };
    }
    const r = params as Record<string, unknown>;
    const query = typeof r.query === "string" ? r.query : undefined;

    if (r.verify === true && r.deep === true) {
      const progress = createProgressReporter("explain", ctx, onUpdate);
      const learnConfig = loadYoowaiConfig(ctx.cwd);
      const learnModelConfig = resolveTaskModel(learnConfig, "explain");
      const learnModelLabel = secondaryModelLabel(learnModelConfig);
      const { results, cost } = await verifyLearnedFactsDeep(
        ctx.cwd,
        query,
        signal,
        (current, total) => progress(current, total, `Verifying fact ${current}/${total} with ${learnModelLabel}…`),
        ctx.sessionManager,
      );
      const text = formatVerificationReport(results);
      return {
        content: [{ type: "text", text }],
        details: { action: "learn", verify: results, cost },
        isError: false,
      };
    }

    if (r.verify === true) {
      const results = verifyLearnedFacts(ctx.cwd, query);
      const text = formatVerificationReport(results);
      return {
        content: [{ type: "text", text }],
        details: { action: "learn", verify: results },
        isError: false,
      };
    }

    if (typeof r.fact !== "string" || r.fact.length === 0) {
      return {
        content: [{ type: "text", text: "wai_learn: Missing or empty 'fact' parameter." }],
        details: { error: "Missing or empty 'fact' parameter." },
        isError: true,
      };
    }
    const category = typeof r.category === "string" ? r.category : undefined;
    const source = typeof r.source === "string" ? r.source : undefined;
    recordLearnedFact(ctx.cwd, r.fact, { category, source });
    const related = findLearnedFacts(ctx.cwd, r.fact).slice(0, 10);
    return {
      content: [
        {
          type: "text",
          text: `Recorded fact.${
            related.length > 1
              ? ` Related facts (${related.length - 1}):\n${related
                  .slice(1)
                  .map((f) => `- ${f.fact}`)
                  .join("\n")}`
              : ""
          }`,
        },
      ],
      details: { action: "learn", learned: related },
      isError: false,
    };
  }

  pi.registerTool({
    name: "wai_learn",
    label: "Wai Learn — Project Facts",
    description:
      "Record a persistent project fact that wai will remember across sessions. Facts are surfaced by wai_index so the main agent can ground future work in project-specific knowledge.",
    promptSnippet: "wai_learn: remember this project fact for future sessions",
    promptGuidelines: [
      "Call wai_learn to record project-specific facts, decisions, or quirks the main agent should remember.",
      "Use a category to group related facts (e.g. 'auth', 'build', 'conventions').",
      "Keep facts concise and actionable.",
      "Recorded facts appear in wai_index topic 'learned'.",
      "Use verify:true to check stored facts against the current codebase instead of recording.",
      "Add deep:true to verify with the secondary model for higher accuracy (costs tokens per fact).",
    ],
    parameters: Type.Object({
      fact: Type.Optional(
        Type.String({
          description: "The project fact to record. Required unless verify is true.",
        }),
      ),
      category: Type.Optional(
        Type.String({
          description: "Optional category for grouping facts.",
        }),
      ),
      source: Type.Optional(
        Type.String({
          description: "Optional source file or URL where this fact originated.",
        }),
      ),
      verify: Type.Optional(
        Type.Boolean({
          description: "If true, verify stored facts against the current codebase instead of recording.",
        }),
      ),
      query: Type.Optional(
        Type.String({
          description: "When verifying, only check facts matching this keyword.",
        }),
      ),
      deep: Type.Optional(
        Type.Boolean({
          description: "When verifying, use the secondary model for deeper accuracy.",
        }),
      ),
    }),
    renderCall: (args, theme, context) =>
      renderLearnCall(args as { fact?: string; verify?: boolean; deep?: boolean; query?: string }, theme, context),
    renderResult: (result, opts, theme, context) => renderAuxResult("learn", result, opts, theme, context),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return runWaiLearnTool(params, signal, onUpdate as ((update: unknown) => void) | undefined, ctx);
    },
  });

  async function runWaiDesignRefTool(
    params: unknown,
  ): Promise<
    import("@earendil-works/pi-coding-agent").AgentToolResult<Record<string, unknown>> & { isError: boolean }
  > {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return {
        content: [{ type: "text", text: "wai_design_ref: Invalid parameters." }],
        details: { error: "Invalid parameters." },
        isError: true,
      };
    }
    const r = params as Record<string, unknown>;
    const topic = typeof r.topic === "string" && r.topic.trim() ? r.topic.trim() : undefined;
    const doc = typeof r.doc === "string" && r.doc.trim() ? r.doc.trim() : undefined;

    if (!topic) {
      const topics = listDesignRefDocs();
      if (topics.length === 0) {
        return {
          content: [{ type: "text", text: "No design reference docs are available (design-refs directory missing)." }],
          details: { error: "design-refs directory missing" },
          isError: true,
        };
      }
      const lines = topics.map((t) => {
        const desc = DESIGN_REF_TOPIC_DESCRIPTIONS[t.topic];
        const docList = t.docs.length > 1 ? ` [docs: ${t.docs.join(", ")}]` : "";
        return `- ${t.topic}${desc ? ` — ${desc}` : ""}${docList}`;
      });
      return {
        content: [
          {
            type: "text",
            text: `Design reference topics (call wai_design_ref with a topic to read its guidance):\n${lines.join("\n")}`,
          },
        ],
        details: { topic: "list", topics: topics.map((t) => t.topic) },
        isError: false,
      };
    }

    try {
      const content = readDesignRefDoc(topic, doc);
      return {
        content: [{ type: "text", text: content }],
        details: { topic, doc: doc ?? "SKILL.md" },
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `wai_design_ref: ${message}` }],
        details: { error: message },
        isError: true,
      };
    }
  }

  pi.registerTool({
    name: "wai_design_ref",
    label: "Wai Design Ref — UI Design Guidance",
    description:
      "Read curated UI/animation design guidance (vendored from Emil Kowalski's skills, MIT). Call this when building, reviewing, or improving UI/animation code to get detailed design guidance.",
    promptSnippet: "wai_design_ref: read detailed UI/animation design guidance for a topic",
    promptGuidelines: [
      "Call wai_design_ref when building, reviewing, or improving UI/animation code to get detailed design guidance.",
      "Call without a topic to list the available topics and their docs.",
      "Pass a topic (e.g. 'animate', 'review-animations', 'apple-design') to read its SKILL.md guidance.",
      "Pass doc to read a specific document of a topic (e.g. topic 'improve-animations', doc 'AUDIT.md').",
      "The distilled baseline rules are already injected automatically for UI files; use this tool for depth.",
    ],
    parameters: Type.Object({
      topic: Type.Optional(
        Type.String({
          description: "Design reference topic to read. Omit to list all topics.",
        }),
      ),
      doc: Type.Optional(
        Type.String({
          description: "Specific markdown doc within the topic (default: SKILL.md).",
        }),
      ),
    }),
    renderCall: (args, theme, context) => renderDesignRefCall(args as { topic?: string; doc?: string }, theme, context),
    renderResult: (result, opts, theme, context) => renderAuxResult("design-ref", result, opts, theme, context),
    async execute(_toolCallId, params) {
      return runWaiDesignRefTool(params);
    },
  });

  registerWaiCommands(pi, loopStates);
  registerContextInjector(pi);
  registerLifecycleHandlers(pi, loopStates);
  await registerWaiEntryRenderer(pi);
  registerWaiShortcuts(pi);
}
