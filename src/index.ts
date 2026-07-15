import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { YooToolResult } from "./types.js";
import { Type } from "@sinclair/typebox";
import { loadHeyyooConfig, resolveTaskModel } from "./config.js";
import { setPiSessionId, clearPiSessionId } from "./secondary-model.js";

import { renderCall, renderResult } from "./render.js";
import { resetCost } from "./cost-tracker.js";
import { logEvent } from "./logger.js";
import {
  createLoopDetectionState,
  recordToolCall,
  checkLoop,
  shouldSendSteer,
  type LoopDetectionState,
} from "./loop-detector.js";
import { createProgressReporter, clearYooStatus } from "./progress.js";
import { setSessionId, clearSessionId, pruneSessionDirs } from "./session-scope.js";
import { validateYooToolParams } from "./yoo-tool-params.js";
import {
  recordLearnedFact,
  findLearnedFacts,
  verifyLearnedFacts,
  verifyLearnedFactsDeep,
  formatVerificationReport,
} from "./yoo-learn.js";
import {
  dropSessionState,
  getEditTracker,
  getState,
  recordFileEdit,
  resetEditsSinceDone,
  resetEditsSinceReview,
} from "./session-state.js";
import { secondaryModelLabel } from "./actions/shared.js";
import { executeYooPlan } from "./actions/plan.js";
import { executeYooReview } from "./actions/review.js";
import { executeYooTest } from "./actions/test.js";
import { executeYooSecurity } from "./actions/security.js";
import { executeYooSuggest } from "./actions/suggest.js";
import { executeYooRecommend } from "./actions/recommend.js";
import { executeYooJudge } from "./actions/judge.js";
import { executeYooScan } from "./actions/scan.js";
import { executeYooDone } from "./actions/done.js";
import { executeYooPlanUpdate } from "./actions/plan-update.js";
import { executeYooIndex, formatIndexResult, validateYooIndexParams } from "./yoo-index.js";
import { executeYooExplain, validateYooExplainParams } from "./yoo-explain.js";
import { registerYooCommands } from "./commands/register.js";
import { formatResultText } from "./format.js";

function isFileWriteTool(toolName: string): boolean {
  const writeLike =
    /^(write|edit|apply|create|patch|modify|append|prepend|rename|delete|remove|rm)|(?:File|Edit|Path)$/i;
  return writeLike.test(toolName);
}

const loopStates = new Map<string, LoopDetectionState>();
function getLoopState(cwd: string): LoopDetectionState {
  let state = loopStates.get(cwd);
  if (!state) {
    state = createLoopDetectionState();
    loopStates.set(cwd, state);
  }
  return state;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Scope volatile yoo state to this Pi session so plans/memory/cost do not
    // leak across unrelated sessions on the same project.
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      setSessionId(ctx.cwd, sessionId);
      // Clean up stale per-session directories from previous sessions.
      pruneSessionDirs(ctx.cwd, sessionId);
    } catch {
      /* ignore if sessionManager is unavailable */
    }

    // cost.json tracks estimated spend for the current Pi session.
    resetCost(ctx.cwd);
    // Make OpenCode session-aware so it can use sticky provider routing.
    try {
      setPiSessionId(ctx.cwd, ctx.sessionManager.getSessionId());
    } catch {
      /* ignore if sessionManager is unavailable */
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    dropSessionState(ctx.cwd);
    loopStates.delete(ctx.cwd);
    clearPiSessionId(ctx.cwd);
    clearSessionId(ctx.cwd);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    try {
      const state = getLoopState(ctx.cwd);
      recordToolCall(state, event);
      const loop = checkLoop(state);
      if (loop && shouldSendSteer(state, loop)) {
        pi.sendUserMessage(loop.message, { deliverAs: "steer" });
      }

      const e = event as Record<string, unknown> | undefined;
      const toolName = typeof e?.toolName === "string" ? e.toolName : "";
      if (isFileWriteTool(toolName)) {
        recordFileEdit(ctx.cwd);
        const editState = getEditTracker(ctx.cwd);
        const now = Date.now();
        const sessionState = getState(ctx.cwd);
        const lastSteer = sessionState.lastSteerAt ?? 0;
        if ((editState.editsSinceLastReview >= 3 || editState.editsSinceLastDone >= 3) && now - lastSteer > 30_000) {
          sessionState.lastSteerAt = now;
          const reminders: string[] = [];
          if (editState.editsSinceLastDone >= 3) {
            reminders.push("call `yoo({ done: true })` to mark completed plan steps done");
          }
          if (editState.editsSinceLastReview >= 3) {
            reminders.push("call `yoo({ review: '...' })` to review the changes");
          }
          pi.sendUserMessage(
            `WORKFLOW REMINDER: you have made ${editState.editsSinceLastDone} file edit(s) without updating the plan tracker. Please ${reminders.join(" and ")}.`,
            { deliverAs: "steer" },
          );
        }
      }
    } catch {
      // best-effort loop detection and workflow reminders
    }
  });

  pi.registerTool({
    name: "yoo",
    label: "Yoo — Pair Programmer",
    description:
      "Mandatory second-opinion workflow powered by a secondary model. Always use yoo.plan before implementing, yoo.review after every change, yoo.scan when opening a new project, yoo.suggest for non-trivial architectural or design questions, yoo.recommend when deciding next steps, and yoo.judge before declaring work complete. Optionally use yoo.test to check test coverage and failures, and yoo.security to audit for vulnerabilities.",
    promptSnippet:
      "yoo: always get a second opinion from the secondary model before acting on code or making architectural decisions",
    promptGuidelines: [
      "Always use yoo with plan:true before starting any non-trivial implementation. The secondary model creates a structured todo list with acceptance criteria; do not write code without a plan.",
      "Always use yoo with review:true after every code change. Treat review feedback as blocking; fix issues and re-run review until it returns 'pass'.",
      "Use yoo with review:true and files:[...] to limit the review to specific files, or exclude:[...] to skip files like generated output.",
      "Use yoo with scan:true immediately when opening a project for the first time. Stored conventions improve all future reviews and plans.",
      "Use yoo with suggest:true whenever you are uncertain about the best approach for a specific technical question. If you are stuck, looping, or about to ask the user for help, call yoo.suggest first.",
      "When the user asks a non-trivial architectural or design question where multiple valid approaches exist, call yoo.suggest before answering. For simple factual questions you can verify yourself (reading files, running commands), answer directly without yoo.",
      "Use yoo with recommend:true whenever you need to decide what step to take next. If you have spent more than one turn without clear progress, call yoo.recommend.",
      "Use yoo with test:true when you want a dedicated check for missing tests, failing tests, or low test quality. This is optional; yoo.review already catches many quality issues.",
      "Use yoo with security:true when the change involves auth, input handling, secrets, dependencies, or any security-sensitive area. Pass a description of the function or API to audit and scope it with files:[...] if needed.",
      "Use yoo with judge:true after completing all work for a final holistic review against the original plan.",
      "Use yoo with done:true to mark the current plan step complete. Use it after finishing a step so the tracker stays in sync.",
      "Use yoo with planUpdate:'<new task description>' when the original plan no longer matches the implementation. The plan is regenerated and already-completed progress is preserved.",
      "Enable autoJudge in settings.json to automatically run judge when the last plan step is completed (passes review or is marked done via /yoo-done).",

      "Configure preReviewCommands in settings.json to run lint/test/typecheck before each review and include output in the prompt.",
      "Use `verify: true` when a yoo finding is surprising, high-stakes, or unclear. The main agent must then confirm or refute the finding with evidence before acting.",
      "The secondary model should be a DIFFERENT model family than the main model to catch blind spots. Configure in settings.json under pi-heyyoo.secondary.",
      "Only one action (plan/review/suggest/recommend/judge/scan/test/security/done/planUpdate) per call. Do not combine them.",
      "When stuck, confused, or looping, stop and use a yoo tool. Do not spin in place or guess.",
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
            "Provide a description of what you just implemented. The secondary model examines the diff and returns a verdict with issues.",
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
            "Provide a description of all completed work for a final holistic review against the original plan.",
        }),
      ),
      scan: Type.Optional(
        Type.Boolean({
          description:
            "If true, scan project conventions and architecture patterns. Stores results for future reviews.",
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
            "Mark yoo plan step(s) complete. Pass true/empty string for the current step, a positive number to mark up to that step, 'all' for all steps, or a description to record what was completed.",
        }),
      ),
      planUpdate: Type.Optional(
        Type.Union([Type.Boolean(), Type.String()], {
          description:
            "Regenerate the active yoo plan from a new task description when the original plan no longer matches the implementation. Already-completed progress is preserved.",
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
          description: "Named documentation sources to include in the prompt (configured in pi-heyyoo.docs.sources).",
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
      const validation = validateYooToolParams(params);
      if (!validation.ok) {
        return {
          content: [{ type: "text", text: `yoo: ${validation.error}` }],
          isError: true,
        };
      }
      const p = validation.params;
      const action = validation.action;
      const config = loadHeyyooConfig(ctx.cwd);

      const start = Date.now();
      const progress = createProgressReporter(action, ctx, onUpdate);
      let result: YooToolResult;

      try {
        if (p.plan) {
          result = await executeYooPlan(ctx.cwd, p.plan, signal, progress, ctx.sessionManager);
        } else if (p.review) {
          result = await executeYooReview(
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
          result = await executeYooSuggest(ctx.cwd, p.suggest, signal, progress, ctx.sessionManager, {
            docs: p.docs,
          });
        } else if (p.recommend) {
          result = await executeYooRecommend(ctx.cwd, p.recommend, signal, progress, ctx.sessionManager, {
            docs: p.docs,
          });
        } else if (p.judge) {
          result = await executeYooJudge(ctx.cwd, p.judge, signal, progress, ctx.sessionManager);
        } else if (p.test) {
          result = await executeYooTest(
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
          result = await executeYooSecurity(
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
          result = { action: "done", done: executeYooDone(ctx.cwd, p.done) };
        } else if (p.planUpdate !== undefined) {
          result = {
            action: "planUpdate",
            done: await executeYooPlanUpdate(ctx.cwd, p.planUpdate, signal, progress, ctx.sessionManager),
          };
        } else {
          result = await executeYooScan(ctx.cwd, signal, progress, ctx.sessionManager);
        }

        if (p.review) resetEditsSinceReview(ctx.cwd);
        if (p.done !== undefined) resetEditsSinceDone(ctx.cwd);
      } catch (err) {
        logEvent(ctx.cwd, "error", `yoo tool ${action} failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
        result = { action, error: err instanceof Error ? err.message : String(err) };
      } finally {
        clearYooStatus(ctx);
      }

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
    },
  });

  pi.registerTool({
    name: "yoo_index",
    label: "Yoo Index — Project Context",
    description:
      "Read stored yoo project context: conventions, active plan, review memory, session cost, and recent logs. No model call — fast and deterministic. Use this before making changes to understand the project's rules, current task, and past issues.",
    promptSnippet: "yoo_index: retrieve stored project context before acting on code",
    promptGuidelines: [
      "Call yoo_index when you need a quick overview of the project conventions, active plan, or recent review issues.",
      "Use topic 'conventions' to learn the project's stack, naming, structure, and patterns.",
      "Use topic 'plan' to see the current todo list and progress.",
      "Use topic 'memory' with files:[...] to see past review issues for specific files.",
      "Use topic 'cost' to check estimated spend in the current session.",
      "Use topic 'logs' to see recent yoo errors or warnings.",
      "Use topic 'index' to see the project symbol index built by yoo scan-deep or yoo_index update.",
      "Use topic 'learned' to see facts recorded with yoo_learn.",
      "Set update:true to rebuild the symbol index on demand.",
      "yoo_index does not call a model; it only reads data yoo already stored.",
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const indexParams = validateYooIndexParams(params);
        const result = executeYooIndex(ctx.cwd, indexParams);
        const text = formatIndexResult(result);
        return {
          content: [{ type: "text", text }],
          details: result,
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent(ctx.cwd, "error", "yoo_index failed", { error: message });
        return {
          content: [{ type: "text", text: `yoo_index failed: ${message}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "yoo_explain",
    label: "Yoo Explain — Code & Error Explanations",
    description:
      "Explain a code snippet, error message, diff, or file using the secondary model. Useful when the main agent encounters an unfamiliar API, a cryptic error, or wants a second pair of eyes on a piece of code.",
    promptSnippet: "yoo_explain: explain this code or error before acting on it",
    promptGuidelines: [
      "Call yoo_explain when you see an error you do not fully understand.",
      "Use yoo_explain to get a concise explanation of a code snippet, function, or file.",
      "Pass files:[...] so the model can see full context around the target.",
      "Use context to add extra background (e.g. 'this is thrown during yoo scan').",
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
          description: "Named documentation sources to include in the prompt (configured in pi-heyyoo.docs.sources).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const validation = validateYooExplainParams(params);
      if (!validation.ok) {
        return {
          content: [{ type: "text", text: `yoo_explain: ${validation.error}` }],
          isError: true,
        };
      }

      const progress = createProgressReporter("explain", ctx);
      const result = await executeYooExplain(ctx.cwd, validation.params, signal, progress, ctx.sessionManager);
      if ("error" in result) {
        return {
          content: [{ type: "text", text: `yoo_explain error: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: result.result.details }],
        details: { action: "explain", explain: result.result, cost: result.cost },
        isError: false,
      };
    },
  });

  pi.registerTool({
    name: "yoo_learn",
    label: "Yoo Learn — Project Facts",
    description:
      "Record a persistent project fact that yoo will remember across sessions. Facts are surfaced by yoo_index so the main agent can ground future work in project-specific knowledge.",
    promptSnippet: "yoo_learn: remember this project fact for future sessions",
    promptGuidelines: [
      "Call yoo_learn to record project-specific facts, decisions, or quirks the main agent should remember.",
      "Use a category to group related facts (e.g. 'auth', 'build', 'conventions').",
      "Keep facts concise and actionable.",
      "Recorded facts appear in yoo_index topic 'learned'.",
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        return {
          content: [{ type: "text", text: "yoo_learn: Invalid parameters." }],
          isError: true,
        };
      }
      const r = params as Record<string, unknown>;
      const query = typeof r.query === "string" ? r.query : undefined;

      if (r.verify === true && r.deep === true) {
        const progress = createProgressReporter("explain", ctx);
        const learnConfig = loadHeyyooConfig(ctx.cwd);
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
          content: [{ type: "text", text: "yoo_learn: Missing or empty 'fact' parameter." }],
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
    },
  });

  registerYooCommands(pi, loopStates);
}
