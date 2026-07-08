import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./pi-paths.js";
import { loadHeyyooConfig, resolveTaskModel } from "./config.js";
import { callSecondaryModel, setPiSessionId, clearPiSessionId } from "./secondary-model.js";
import { getVcsInfo } from "./diff-grabber.js";

const { version: VERSION, homepage: HOMEPAGE = "https://whatley.xyz" } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string; homepage?: string };
import { clearPromptCache } from "./prompts.js";
import { renderCall, renderResult } from "./render.js";
import { clearState } from "./plan-store.js";
import type { YooToolResult, YooAction, YooModelTask, SecondaryModelConfig, StageProfile } from "./types.js";
import { isPlanStep, planStepDescription } from "./types.js";
import {
  createLoopDetectionState,
  recordToolCall,
  checkLoop,
  shouldSendSteer,
  type LoopDetectionState,
} from "./loop-detector.js";
import { getSessionCost, formatCost, resetCost } from "./cost-tracker.js";
import { clearMemory } from "./review-memory.js";
import { loadConventions, formatConventions, clearConventions } from "./conventions.js";
import { logEvent, readRecentLogs, clearLogs } from "./logger.js";
import { createProgressReporter, clearYooStatus, type ProgressReporter } from "./progress.js";
import { setSessionId, clearSessionId, pruneSessionDirs } from "./session-scope.js";
import { executeYooIndex, formatIndexResult, validateYooIndexParams } from "./yoo-index.js";
import { executeYooExplain, validateYooExplainParams } from "./yoo-explain.js";
import { handleYooSearchCommand } from "./yoo-search.js";
import { handleYooSearchConfigCommand } from "./yoo-search-config.js";
import { validateYooToolParams, YOO_MODEL_TASKS } from "./yoo-tool-params.js";
import {
  recordLearnedFact,
  findLearnedFacts,
  clearLearnedFacts,
  verifyLearnedFacts,
  verifyLearnedFactsDeep,
  formatVerificationReport,
} from "./yoo-learn.js";
import { getState, markStepComplete, getProgress, dropSessionState } from "./session-state.js";
import { secondaryModelLabel, formatTokenCount } from "./actions/shared.js";
import { executeYooPlan } from "./actions/plan.js";
import { executeYooReview } from "./actions/review.js";
import { executeYooTest } from "./actions/test.js";
import { executeYooSecurity } from "./actions/security.js";
import { executeYooSuggest } from "./actions/suggest.js";
import { executeYooRecommend } from "./actions/recommend.js";
import { executeYooJudge } from "./actions/judge.js";
import { executeYooScan } from "./actions/scan.js";

function parseReviewCommandArgs(input: string): {
  description: string;
  options: {
    revision?: string;
    since?: string;
    files?: string[];
    exclude?: string[];
    vcs?: "git" | "svn";
    untracked?: boolean;
  };
} {
  const options: {
    revision?: string;
    since?: string;
    files?: string[];
    exclude?: string[];
    vcs?: "git" | "svn";
    untracked?: boolean;
  } = {};
  const tokens = input.match(/(?:[^\s"']+|["'][^"']*["'])+/g) ?? [];
  const args = tokens.map((t) => t.replace(/^["']|["']$/g, ""));
  const descriptionParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--revision":
      case "-r":
        if (next) {
          options.revision = next;
          i++;
        }
        break;
      case "--since":
      case "-s":
        if (next) {
          options.since = next;
          i++;
        }
        break;
      case "--files":
      case "-f":
        if (next) {
          options.files = next
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean);
          i++;
        }
        break;
      case "--exclude":
      case "-x":
        if (next) {
          options.exclude = next
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean);
          i++;
        }
        break;
      case "--vcs":
        if (next === "git" || next === "svn") {
          options.vcs = next;
          i++;
        }
        break;
      case "--untracked":
        options.untracked = true;
        break;
      default:
        descriptionParts.push(arg);
    }
  }

  return { description: descriptionParts.join(" ") || "review changes", options };
}

function parseTestCommandArgs(input: string): {
  description: string;
  command?: string;
  options: {
    files?: string[];
    exclude?: string[];
    revision?: string;
    since?: string;
    vcs?: "git" | "svn";
    untracked?: boolean;
  };
} {
  const base = parseReviewCommandArgs(input);
  const tokens = input.match(/(?:[^\s"']+|["'][^"']*["'])+/g) ?? [];
  const args = tokens.map((t) => t.replace(/^["']|["']$/g, ""));
  let command: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--command" || args[i] === "-c") && args[i + 1]) {
      command = args[i + 1];
      i++;
    }
  }
  return { description: base.description, command, options: base.options };
}

function parseSecurityCommandArgs(input: string): {
  description: string;
  options: {
    files?: string[];
    exclude?: string[];
    revision?: string;
    since?: string;
    vcs?: "git" | "svn";
    untracked?: boolean;
    fullProject?: boolean;
  };
} {
  const base = parseReviewCommandArgs(input);
  const tokens = input.match(/(?:[^\s"']+|["'][^"']*["'])+/g) ?? [];
  const fullProject = tokens.some((t) => t === "--full-project" || t === "-fp");
  return { description: base.description, options: { ...base.options, fullProject } };
}

export default function (pi: ExtensionAPI) {
  const loopStates = new Map<string, LoopDetectionState>();
  function getLoopState(cwd: string): LoopDetectionState {
    let state = loopStates.get(cwd);
    if (!state) {
      state = createLoopDetectionState();
      loopStates.set(cwd, state);
    }
    return state;
  }

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
    } catch {
      // best-effort loop detection
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
      "Enable autoJudge in settings.json to automatically run judge when the last plan step passes review.",
      "Configure preReviewCommands in settings.json to run lint/test/typecheck before each review and include output in the prompt.",
      "Use `verify: true` when a yoo finding is surprising, high-stakes, or unclear. The main agent must then confirm or refute the finding with evidence before acting.",
      "The secondary model should be a DIFFERENT model family than the main model to catch blind spots. Configure in settings.json under pi-heyyoo.secondary.",
      "Only one action (plan/review/suggest/recommend/judge/scan/test/security) per call. Do not combine them.",
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
        } else {
          result = await executeYooScan(ctx.cwd, signal, progress, ctx.sessionManager);
        }
      } catch (err) {
        logEvent(ctx.cwd, "error", `yoo tool ${action} failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
        result = { action, error: err instanceof Error ? err.message : String(err) };
      } finally {
        clearYooStatus(ctx);
      }

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

  pi.registerCommand("yoo", {
    description:
      "Run a yoo action or show status. Usage: /yoo [plan|review|suggest|recommend|judge|scan|test|security|status] [args]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        await showYooStatus(ctx);
        return;
      }

      const [subcommand, ...rest] = trimmed.split(/\s+/);
      const restText = rest.join(" ").trim();
      const signal = undefined;

      const actionMap: Record<string, YooAction | "status"> = {
        plan: "plan",
        review: "review",
        suggest: "suggest",
        recommend: "recommend",
        judge: "judge",
        scan: "scan",
        test: "test",
        security: "security",
        status: "status",
      };
      const known = actionMap[subcommand.toLowerCase()];
      if (!known) {
        ctx.ui.notify(`Unknown /yoo subcommand: ${subcommand}. Try /yoo status`, "warn");
        return;
      }

      const action: YooAction = known === "status" ? "scan" : known;

      const progress = createProgressReporter(action, ctx);
      const notifyProgress: ProgressReporter = (stage, total, message) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };

      let result: YooToolResult;
      try {
        switch (known) {
          case "status":
            await showYooStatus(ctx);
            return;
          case "plan":
            if (!restText) {
              ctx.ui.notify("Usage: /yoo plan <task description>", "warn");
              return;
            }
            result = await executeYooPlan(ctx.cwd, restText, signal, notifyProgress, ctx.sessionManager);
            break;
          case "review": {
            const { description, options: reviewOptions } = parseReviewCommandArgs(restText);
            result = await executeYooReview(ctx.cwd, description, ctx, reviewOptions, signal, notifyProgress);
            break;
          }
          case "suggest":
            if (!restText) {
              ctx.ui.notify("Usage: /yoo suggest <question>", "warn");
              return;
            }
            result = await executeYooSuggest(ctx.cwd, restText, signal, notifyProgress, ctx.sessionManager);
            break;
          case "recommend":
            result = await executeYooRecommend(
              ctx.cwd,
              restText || "what next",
              signal,
              notifyProgress,
              ctx.sessionManager,
            );
            break;
          case "judge":
            result = await executeYooJudge(ctx.cwd, restText || "all done", signal, notifyProgress, ctx.sessionManager);
            break;
          case "scan":
            result = await executeYooScan(ctx.cwd, signal, notifyProgress, ctx.sessionManager);
            break;
          case "test": {
            const { description, command, options: testOptions } = parseTestCommandArgs(restText);
            result = await executeYooTest(
              ctx.cwd,
              description || "review test coverage",
              ctx,
              { ...testOptions, command },
              signal,
              notifyProgress,
            );
            break;
          }
          case "security": {
            const { description, options: securityOptions } = parseSecurityCommandArgs(restText);
            result = await executeYooSecurity(
              ctx.cwd,
              description || "security audit",
              ctx,
              securityOptions,
              signal,
              notifyProgress,
            );
            break;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent(ctx.cwd, "error", `yoo ${subcommand} command failed`, { error: message });
        ctx.ui.notify(`yoo error: ${message}`, "error");
        return;
      } finally {
        clearYooStatus(ctx);
      }

      const text = formatResultText(result);
      ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
    },
  });

  pi.registerCommand("yoo-config", {
    description:
      "View or edit pi-heyyoo settings. Usage: /yoo-config [get|set|list] [key] [value], or /yoo-config <provider.model>",
    handler: async (args, ctx) => {
      const agentDir = getAgentDir();
      const settingsPath = join(agentDir, "settings.json");
      const trimmed = args.trim();

      function readSettings(): Record<string, unknown> {
        if (!existsSync(settingsPath)) return {};
        try {
          return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
        } catch (err) {
          logEvent(ctx.cwd, "error", "Failed to read settings for /yoo-config", {
            error: err instanceof Error ? err.message : String(err),
            path: settingsPath,
          });
          throw new Error("Failed to read settings.json.", { cause: err });
        }
      }

      function writeSettings(settings: Record<string, unknown>): void {
        if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      }

      function getYooSettings(settings: Record<string, unknown>): Record<string, unknown> {
        const yoo = settings["pi-heyyoo"];
        return yoo && typeof yoo === "object" && !Array.isArray(yoo) ? (yoo as Record<string, unknown>) : {};
      }

      function setValueByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
        const parts = path.split(".");
        let current: Record<string, unknown> = obj;
        for (let i = 0; i < parts.length - 1; i++) {
          const key = parts[i];
          const next = current[key];
          if (!next || typeof next !== "object" || Array.isArray(next)) {
            current[key] = {};
          }
          current = current[key] as Record<string, unknown>;
        }
        current[parts[parts.length - 1]] = value;
      }

      function getValueByPath(obj: Record<string, unknown>, path: string): unknown {
        const parts = path.split(".");
        let current: unknown = obj;
        for (const part of parts) {
          if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
          current = (current as Record<string, unknown>)[part];
        }
        return current;
      }

      function parseConfigValue(raw: string): unknown {
        const stripped = raw.trim();
        if (/^".*"$/.test(stripped)) return stripped.slice(1, -1);
        if (/^'.*'$/.test(stripped)) return stripped.slice(1, -1);
        if (stripped.toLowerCase() === "true" || stripped.toLowerCase() === "yes") return true;
        if (stripped.toLowerCase() === "false" || stripped.toLowerCase() === "no") return false;
        if (stripped === "null") return null;
        if (stripped === "undefined") return undefined;
        const num = Number(stripped);
        if (stripped !== "" && !Number.isNaN(num) && Number.isFinite(num)) return num;
        try {
          return JSON.parse(stripped);
        } catch {
          return stripped;
        }
      }

      function tokenize(input: string): string[] {
        const tokens: string[] = [];
        const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(input)) !== null) {
          tokens.push(match[1] ?? match[2] ?? match[0]);
        }
        return tokens;
      }

      // Legacy shorthand: /yoo-config provider.model
      if (trimmed && !trimmed.includes(" ") && trimmed.includes(".")) {
        const [provider, ...modelParts] = trimmed.split(".");
        const modelId = modelParts.join(".");
        if (provider && modelId) {
          try {
            const settings = readSettings();
            settings["pi-heyyoo"] = settings["pi-heyyoo"] || {};
            const yoo = getYooSettings(settings);
            yoo.secondary = (yoo.secondary as Record<string, unknown>) || {};
            (yoo.secondary as Record<string, unknown>).provider = provider;
            (yoo.secondary as Record<string, unknown>).id = modelId;
            settings["pi-heyyoo"] = yoo;
            writeSettings(settings);
            ctx.ui.notify(`Set yoo secondary model to ${provider}.${modelId} in ${settingsPath}`, "info");
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Failed to update settings: ${message}`, "error");
          }
          return;
        }
      }

      const tokens = tokenize(trimmed);
      const subcommand = tokens[0]?.toLowerCase() ?? "";

      try {
        if (!trimmed || subcommand === "list") {
          const settings = readSettings();
          const yoo = getYooSettings(settings);
          const lines = [
            `Settings file: ${settingsPath}`,
            "",
            JSON.stringify(yoo, null, 2) || "(no pi-heyyoo settings configured)",
          ];
          await ctx.ui.select("pi-heyyoo settings", lines);
          return;
        }

        if (subcommand === "get") {
          const key = tokens[1];
          if (!key) {
            ctx.ui.notify("Usage: /yoo-config get <key> (e.g. /yoo-config get secondary.thinking)", "warn");
            return;
          }
          const settings = readSettings();
          const yoo = getYooSettings(settings);
          const value = getValueByPath(yoo, key);
          const display = value === undefined ? "(not set)" : JSON.stringify(value, null, 2);
          ctx.ui.notify(`${key} = ${display}`, "info");
          return;
        }

        if (subcommand === "set") {
          const key = tokens[1];
          const valueText = tokens.slice(2).join(" ");
          if (!key || valueText.length === 0) {
            ctx.ui.notify(
              "Usage: /yoo-config set <key> <value> (e.g. /yoo-config set secondary.thinking medium)",
              "warn",
            );
            return;
          }
          const value = parseConfigValue(valueText);
          const settings = readSettings();
          settings["pi-heyyoo"] = settings["pi-heyyoo"] || {};
          const yoo = getYooSettings(settings);
          setValueByPath(yoo, key, value);
          settings["pi-heyyoo"] = yoo;
          writeSettings(settings);
          ctx.ui.notify(`Set ${key} = ${JSON.stringify(value)} in ${settingsPath}`, "info");
          return;
        }

        ctx.ui.notify(
          "Unknown /yoo-config subcommand. Usage: /yoo-config [get|set|list] [key] [value], or /yoo-config <provider.model>",
          "warn",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to update settings: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("yoo-model", {
    description:
      "Interactively pick the secondary model for yoo, optionally per tool. Usage: /yoo-model [provider] [filter]",
    handler: async (_args, ctx) => {
      try {
        const registry = ctx.modelRegistry as unknown as {
          getAvailable(): Array<{ id: string; provider: string }>;
          getAll?(): Array<{ id: string; provider: string }>;
          getProviderAuthStatus(provider: string): { configured: boolean };
          hasConfiguredAuth(model: { provider: string }): boolean;
        };

        if (!registry || typeof registry.getAvailable !== "function") {
          ctx.ui.notify("Model registry is not available in this environment.", "error");
          return;
        }

        const allModels = typeof registry.getAll === "function" ? registry.getAll() : registry.getAvailable();
        if (!Array.isArray(allModels) || allModels.length === 0) {
          ctx.ui.notify("No models found. Run /login first.", "error");
          return;
        }

        const configuredModels = allModels.filter((m) => {
          try {
            return registry.getProviderAuthStatus(m.provider).configured;
          } catch {
            return registry.hasConfiguredAuth(m);
          }
        });

        if (configuredModels.length === 0) {
          ctx.ui.notify("No configured models found. Run /login first.", "error");
          return;
        }

        const trimmed = _args.trim();
        const tokens: string[] = [];
        const tokenRegex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
        let tokenMatch: RegExpExecArray | null;
        while ((tokenMatch = tokenRegex.exec(trimmed)) !== null) {
          tokens.push(tokenMatch[1] ?? tokenMatch[2] ?? tokenMatch[0]);
        }
        const requestedProvider = tokens[0]?.toLowerCase();
        const filterQuery = tokens[1]?.toLowerCase();

        const currentConfig = loadHeyyooConfig(ctx.cwd);

        // 1. Pick which yoo tool this model is for.
        const scopeOptions = ["Base secondary model", ...YOO_MODEL_TASKS.map((a) => `Use for ${a} only`)];
        const currentScope = (() => {
          if (currentConfig.secondary.provider && currentConfig.secondary.id) return "Base secondary model";
          const action = YOO_MODEL_TASKS.find((a) => {
            const override = currentConfig.taskModels?.[a];
            return override?.provider && override?.id;
          });
          return action ? `Use for ${action} only` : undefined;
        })();
        const scopeModelText = (scope: string): string => {
          const isBase = scope === "Base secondary model";
          const action = isBase ? undefined : (scope.replace(/^Use for /, "").replace(/ only$/, "") as YooModelTask);
          const model = isBase ? currentConfig.secondary : resolveTaskModel(currentConfig, action!);
          if (!model.provider || !model.id) return "not configured";
          return `${model.provider}:${model.id}${model.thinking ? ` · ${model.thinking}` : ""}`;
        };
        const scopeItems = scopeOptions.map(
          (s) => `${s} — ${scopeModelText(s)}${s === currentScope ? " ✓ current" : ""}`,
        );
        const scopePicked = await ctx.ui.select("Which yoo tool should use this model?", scopeItems);
        if (!scopePicked) return;
        const scope = scopePicked.replace(/ ✓ current$/, "").split(" — ")[0];
        const action =
          scope === "Base secondary model"
            ? undefined
            : (scope.replace(/^Use for /, "").replace(/ only$/, "") as YooModelTask);

        const target = action ? currentConfig.taskModels?.[action] : currentConfig.secondary;
        const effectiveProvider = target?.provider || currentConfig.secondary.provider;
        const effectiveId = target?.id || currentConfig.secondary.id;
        const effectiveThinking = target?.thinking ?? currentConfig.secondary.thinking ?? "xhigh";

        // 2. Pick provider.
        const providers = [...new Set(configuredModels.map((m) => m.provider))].sort();
        let provider: string;
        if (requestedProvider) {
          const matched = providers.find((p) => p.toLowerCase() === requestedProvider);
          if (!matched) {
            ctx.ui.notify(`No configured provider matching "${tokens[0]}".`, "warn");
            return;
          }
          provider = matched;
        } else if (providers.length === 1) {
          provider = providers[0];
        } else {
          const providerItems = providers.map((p) => {
            const count = configuredModels.filter((m) => m.provider === p).length;
            const marker = p.toLowerCase() === effectiveProvider.toLowerCase() ? " ✓ current" : "";
            return `${p} (${count} models)${marker}`;
          });
          const picked = await ctx.ui.select("Pick provider:", providerItems);
          if (!picked) return;
          provider = picked.replace(/ ✓ current$/, "").split(" ")[0];
        }

        // 3. Pick model.
        let providerModels = configuredModels
          .filter((m) => m.provider === provider)
          .sort((a, b) => a.id.localeCompare(b.id));
        if (filterQuery) {
          providerModels = providerModels.filter((m) => m.id.toLowerCase().includes(filterQuery));
          if (providerModels.length === 0) {
            ctx.ui.notify(`No ${provider} models match "${tokens[1]}".`, "warn");
            return;
          }
        }
        const modelItems = providerModels.map((m) => {
          const marker =
            provider.toLowerCase() === effectiveProvider.toLowerCase() && m.id === effectiveId ? " ✓ current" : "";
          return `${m.id}${marker}`;
        });

        const modelIdPicked = await ctx.ui.select(`Pick model for ${provider}:`, modelItems);
        if (!modelIdPicked) return;
        const modelId = modelIdPicked.replace(/ ✓ current$/, "");

        // 4. Pick thinking level.
        const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
        const thinkingItems = thinkingLevels.map((t) => `${t}${t === effectiveThinking ? " ✓ current" : ""}`);
        const thinkingPicked = await ctx.ui.select("Pick thinking level:", thinkingItems);
        if (!thinkingPicked) return;
        const thinking = thinkingPicked.replace(" ✓ current", "");

        // 5. Save.
        const agentDir = getAgentDir();
        const settingsPath = join(agentDir, "settings.json");
        if (!existsSync(agentDir)) {
          mkdirSync(agentDir, { recursive: true });
        }
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
        if (!settings["pi-heyyoo"]) settings["pi-heyyoo"] = {};
        const yooSettings = settings["pi-heyyoo"] as Record<string, unknown>;

        if (scope === "Base secondary model") {
          yooSettings.secondary = { provider, id: modelId, thinking };
          ctx.ui.notify(`Secondary model set to ${provider}:${modelId} (${thinking}).`, "info");
        } else {
          const taskModels = (yooSettings.taskModels as Record<string, unknown>) || {};
          const taskAction = action as YooModelTask;
          taskModels[taskAction] = { provider, id: modelId, thinking };
          yooSettings.taskModels = taskModels;
          ctx.ui.notify(`Task model for ${taskAction} set to ${provider}:${modelId} (${thinking}).`, "info");
        }

        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      } catch (err) {
        ctx.ui.notify(`yoo-model failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("yoo-status", {
    description: "Show detailed yoo status (config, plan, VCS, conventions, memory)",
    handler: async (_args, ctx) => {
      await showYooStatus(ctx);
    },
  });

  pi.registerCommand("yoo-info", {
    description: "Alias for /yoo-status",
    handler: async (_args, ctx) => {
      await showYooStatus(ctx);
    },
  });

  pi.registerCommand("yoo-index", {
    description:
      "Read stored yoo project context. Usage: /yoo-index [all|plan|memory|conventions|cost|logs|index|learned] [--update]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const update = trimmed.includes("--update");
      const topic = trimmed.replace("--update", "").trim() || "all";
      const result = executeYooIndex(ctx.cwd, {
        topic: topic as import("./yoo-index.js").IndexTopic,
        update,
      });
      const text = formatIndexResult(result);
      await ctx.ui.select("yoo index", text.split("\n").filter(Boolean));
    },
  });

  pi.registerCommand("yoo-explain", {
    description: "Explain code, an error, or a file. Usage: /yoo-explain <target> [--files file1,file2,...]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Provide a target to explain, e.g. /yoo-explain src/index.ts", "warn");
        return;
      }

      let target = trimmed;
      let files: string[] = [];
      const filesMatch = trimmed.match(/--files\s+(.+)$/);
      if (filesMatch) {
        target = trimmed.slice(0, trimmed.indexOf("--files")).trim();
        files = filesMatch[1]
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean);
      }

      const signal = undefined;
      const progress = createProgressReporter("explain", ctx);
      const result = await executeYooExplain(ctx.cwd, { target, files }, signal, progress, ctx.sessionManager);
      clearYooStatus(ctx);
      if ("error" in result) {
        ctx.ui.notify(`yoo-explain error: ${result.error}`, "error");
        return;
      }
      await ctx.ui.select("yoo explain", result.result.details.split("\n").filter(Boolean));
    },
  });

  pi.registerCommand("yoo-search", {
    description: "Search the web: /yoo-search <query>",
    handler: async (args, ctx) => {
      const result = await handleYooSearchCommand(args, ctx);
      const text = result.content[0]?.text ?? "";
      await ctx.ui.select("yoo search", text.split("\n").filter(Boolean));
    },
  });

  pi.registerCommand("yoo-search-config", {
    description:
      "Configure web search provider. Usage: /yoo-search-config (interactive) or /yoo-search-config brave <api-key>",
    handler: async (args, ctx) => {
      const result = await handleYooSearchConfigCommand(args, ctx);
      const text = result.content[0]?.text ?? "";
      await ctx.ui.select("yoo search config", text.split("\n").filter(Boolean));
    },
  });

  pi.registerCommand("yoo-learn", {
    description:
      "Record or verify project facts. Usage: /yoo-learn <fact> [--category <cat>] | /yoo-learn --verify [--query <keyword>] [--deep]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Provide a fact or use --verify, e.g. /yoo-learn Auth is handled by Clerk.", "warn");
        return;
      }

      if (trimmed === "--verify" || trimmed.startsWith("--verify ")) {
        const queryMatch = trimmed.match(/--query\s+(\S+)/);
        const query = queryMatch ? queryMatch[1] : undefined;
        const deep = trimmed.includes("--deep");

        if (deep) {
          const signal = undefined;
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
          clearYooStatus(ctx);
          const lines = formatVerificationReport(results).split("\n").filter(Boolean);
          lines.push(
            "",
            `${cost.estimatedInputTokens + cost.estimatedOutputTokens} tokens · $${cost.estimatedCostUsd.toFixed(6)}`,
          );
          await ctx.ui.select("yoo learn verify (deep)", lines);
          return;
        }

        const results = verifyLearnedFacts(ctx.cwd, query);
        const text = formatVerificationReport(results);
        await ctx.ui.select("yoo learn verify", text.split("\n").filter(Boolean));
        return;
      }

      let fact = trimmed;
      let category: string | undefined;
      const categoryMatch = trimmed.match(/--category\s+(\S+)/);
      if (categoryMatch) {
        category = categoryMatch[1];
        fact = trimmed.replace(categoryMatch[0], "").trim();
      }

      if (!fact) {
        ctx.ui.notify("Provide a fact to record.", "warn");
        return;
      }

      recordLearnedFact(ctx.cwd, fact, { category });
      ctx.ui.notify(`Recorded project fact${category ? ` [${category}]` : ""}.`, "info");
    },
  });

  pi.registerCommand("yoo-clear", {
    description:
      "Clear the active yoo plan, state, cost, memory, conventions, learned facts, loop history, and inherited session",
    handler: async (_args, ctx) => {
      dropSessionState(ctx.cwd);
      loopStates.delete(ctx.cwd);
      clearPiSessionId(ctx.cwd);
      clearState(ctx.cwd);
      resetCost(ctx.cwd);
      clearMemory(ctx.cwd);
      clearConventions(ctx.cwd);
      clearLearnedFacts(ctx.cwd);
      clearPromptCache();
      ctx.ui.notify(
        "yoo plan, state, cost, memory, conventions, learned facts, loop history, and inherited session cleared.",
        "info",
      );
    },
  });

  pi.registerCommand("yoo-next", {
    description: "Recommend the next step based on the active yoo plan",
    handler: async (_args, ctx) => {
      const signal = undefined;
      const planProgress = getProgress(ctx.cwd);
      const situation =
        planProgress.total > 0
          ? `Plan progress: ${planProgress.current}/${planProgress.total} steps completed. Current step: ${planProgress.nextStep ?? "none"}`
          : "No active plan. Recommend a next step for this project.";
      const progress = createProgressReporter("recommend", ctx);
      const notifyProgress: ProgressReporter = (stage, total, message) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };
      const result = await executeYooRecommend(ctx.cwd, situation, signal, notifyProgress, ctx.sessionManager);
      clearYooStatus(ctx);
      const text = formatResultText(result);
      ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
    },
  });

  pi.registerCommand("yoo-done", {
    description: "Mark the current yoo plan step complete and recommend the next step",
    handler: async (_args, ctx) => {
      const signal = undefined;
      const planProgress = getProgress(ctx.cwd);
      if (planProgress.total === 0) {
        ctx.ui.notify("No active yoo plan. Start one with /yoo plan <task>.", "warn");
        return;
      }
      if (planProgress.current >= planProgress.total) {
        ctx.ui.notify("All plan steps are already complete. Run /yoo judge for a final review.", "info");
        return;
      }
      markStepComplete(ctx.cwd);
      const newProgress = getProgress(ctx.cwd);
      ctx.ui.notify(`Step ${planProgress.current + 1} marked complete.`, "info");
      const situation = `Plan progress: ${newProgress.current}/${newProgress.total} steps completed. Current step: ${newProgress.nextStep ?? "none"}`;
      const progress = createProgressReporter("recommend", ctx);
      const notifyProgress: ProgressReporter = (stage, total, message) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };
      const result = await executeYooRecommend(ctx.cwd, situation, signal, notifyProgress, ctx.sessionManager);
      clearYooStatus(ctx);
      const text = formatResultText(result);
      ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
    },
  });

  pi.registerCommand("yoo-logs", {
    description: "Show recent yoo error/event log entries for this project",
    handler: async (_args, ctx) => {
      const entries = readRecentLogs(ctx.cwd, 50);
      if (entries.length === 0) {
        ctx.ui.notify("No yoo log entries yet.", "info");
        return;
      }
      await ctx.ui.select("Recent yoo logs", entries);
    },
  });

  pi.registerCommand("yoo-clear-logs", {
    description: "Clear the yoo error/event log for this project",
    handler: async (_args, ctx) => {
      clearLogs(ctx.cwd);
      ctx.ui.notify("yoo log cleared.", "info");
    },
  });

  pi.registerCommand("yoo-test", {
    description:
      "Test connectivity to configured secondary models. Optional: /yoo-test <plan|review|suggest|recommend|judge|scan|explain>",
    handler: async (args, ctx) => {
      const config = loadHeyyooConfig(ctx.cwd);
      const requestedTask = args.trim().toLowerCase();
      const task = YOO_MODEL_TASKS.find((action) => action === requestedTask);
      if (requestedTask && !task) {
        ctx.ui.notify(`Unknown yoo task "${requestedTask}". Use one of: ${YOO_MODEL_TASKS.join(", ")}.`, "warn");
        return;
      }

      const tests: { task?: YooModelTask; model: SecondaryModelConfig; label: string }[] = [];
      if (task) {
        const model = resolveTaskModel(config, task);
        tests.push({ task, model, label: secondaryModelLabel(model) });
      } else {
        if (config.secondary.provider && config.secondary.id) {
          tests.push({ model: config.secondary, label: secondaryModelLabel(config.secondary) });
        }
        const defaultKey = `${config.secondary.provider}:${config.secondary.id}:${config.secondary.backend ?? "sdk"}:${config.secondary.baseUrl ?? ""}`;
        for (const action of YOO_MODEL_TASKS) {
          const override = config.taskModels?.[action];
          if (!override?.provider && !override?.id) continue;
          const model = resolveTaskModel(config, action);
          const key = `${model.provider}:${model.id}:${model.backend ?? "sdk"}:${model.baseUrl ?? ""}`;
          if (key === defaultKey) continue;
          tests.push({ task: action, model, label: secondaryModelLabel(model) });
        }
      }

      if (tests.length === 0) {
        ctx.ui.notify("No secondary model configured. Run /yoo-config or /yoo-model first.", "warn");
        return;
      }

      const progress = createProgressReporter("scan", ctx);
      const notifyProgress: ProgressReporter = (stage, total, message) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };

      const runnableTests = tests.filter((t) => t.model.provider && t.model.id);
      if (runnableTests.length === 0) {
        ctx.ui.notify("No configured model has both a provider and model id.", "warn");
        return;
      }

      let failures = 0;
      const totalStages = runnableTests.length * 3;
      interface TestResult {
        label: string;
        task?: YooModelTask;
        provider: string;
        id: string;
        backend?: string;
        thinking?: string;
        baseUrl?: string;
        status: "ok" | "unexpected" | "error";
        elapsedMs: number;
        inputTokens?: number;
        outputTokens?: number;
        costUsd?: number;
        response?: string;
        error?: string;
      }

      const results: TestResult[] = [];

      const formatModelDetails = (model: TestResult) => {
        const parts: string[] = [];
        // Determine actual backend: explicit config wins, custom endpoint uses HTTP,
        // otherwise the SDK backend is the universal default.
        const actualBackend = model.backend ?? (model.baseUrl ? "http" : "sdk");
        parts.push(`backend: ${actualBackend}`);
        if (model.thinking) parts.push(`thinking: ${model.thinking}`);
        else parts.push("thinking: off");
        if (model.baseUrl) parts.push(`endpoint: ${model.baseUrl}`);
        return parts.length > 0 ? ` (${parts.join(", ")})` : "";
      };

      const overallStart = Date.now();

      for (let i = 0; i < runnableTests.length; i++) {
        const { task: testTask, model, label } = runnableTests[i];
        const taskSuffix = testTask ? ` (${testTask})` : "";
        const baseStage = i * 3;
        const testStart = Date.now();

        notifyProgress(baseStage + 1, totalStages, `Testing ${label}${taskSuffix}…`);
        const controller = new AbortController();
        // Thinking models via the pi backend can take 60+ seconds. Use 120s to avoid
        // false failures on slow providers while still catching hung processes.
        const testTimeoutMs = config.testTimeoutMs ?? 120_000;
        const timeout = setTimeout(() => controller.abort(), testTimeoutMs);

        try {
          const { content, usage } = await callSecondaryModel(
            model.provider,
            model.id,
            "You are a helpful assistant. Reply with exactly: yoo connection OK",
            "Test connection. Reply with exactly: yoo connection OK",
            {
              signal: controller.signal,
              thinking: model.thinking,
              cwd: ctx.cwd,
              sessionManager: ctx.sessionManager,
              task: testTask,
            },
          );
          clearTimeout(timeout);
          const elapsedMs = Date.now() - testStart;
          notifyProgress(baseStage + 2, totalStages, `Got response from ${label}${taskSuffix}`);
          const response = content.trim();
          const costText = usage
            ? ` (${formatTokenCount(usage.estimatedInputTokens)} in · ${formatTokenCount(usage.estimatedOutputTokens)} out · ${formatCost(usage.estimatedCostUsd)})`
            : "";
          if (
            response.toLowerCase().includes("yoo connection ok") ||
            response.toLowerCase().includes("connection ok")
          ) {
            notifyProgress(baseStage + 3, totalStages, `${label}${taskSuffix} OK`);
            ctx.ui.notify(`yoo-test OK: ${label}${taskSuffix} is reachable${costText}`, "info");
            results.push({
              label,
              task: testTask,
              provider: model.provider,
              id: model.id,
              backend: model.backend,
              thinking: model.thinking,
              baseUrl: model.baseUrl,
              status: "ok",
              elapsedMs,
              inputTokens: usage?.estimatedInputTokens,
              outputTokens: usage?.estimatedOutputTokens,
              costUsd: usage?.estimatedCostUsd,
              response: response.slice(0, 80),
            });
          } else {
            failures++;
            notifyProgress(baseStage + 3, totalStages, `${label}${taskSuffix} unexpected response`);
            ctx.ui.notify(
              `yoo-test warning: ${label}${taskSuffix} replied but content was unexpected: "${response.slice(0, 100)}"${costText}`,
              "warn",
            );
            results.push({
              label,
              task: testTask,
              provider: model.provider,
              id: model.id,
              backend: model.backend,
              thinking: model.thinking,
              baseUrl: model.baseUrl,
              status: "unexpected",
              elapsedMs,
              inputTokens: usage?.estimatedInputTokens,
              outputTokens: usage?.estimatedOutputTokens,
              costUsd: usage?.estimatedCostUsd,
              response: response.slice(0, 120),
            });
          }
        } catch (err) {
          failures++;
          clearTimeout(timeout);
          const elapsedMs = Date.now() - testStart;
          const message = err instanceof Error ? err.message : String(err);
          logEvent(ctx.cwd, "error", "yoo-test failed", {
            provider: model.provider,
            model: model.id,
            error: message,
          });
          notifyProgress(baseStage + 3, totalStages, `${label}${taskSuffix} connection failed`);
          ctx.ui.notify(`yoo-test failed for ${label}${taskSuffix}: ${message}`, "error");
          results.push({
            label,
            task: testTask,
            provider: model.provider,
            id: model.id,
            backend: model.backend,
            thinking: model.thinking,
            baseUrl: model.baseUrl,
            status: "error",
            elapsedMs,
            error: message,
          });
        }
      }

      const overallElapsedMs = Date.now() - overallStart;
      const totalInput = results.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0);
      const totalOutput = results.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0);
      const totalCost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      const passed = results.length - failures;

      const summaryLines: string[] = [
        failures === 0
          ? `yoo-test complete: ${passed}/${results.length} model(s) passed in ${(overallElapsedMs / 1000).toFixed(1)}s`
          : `yoo-test complete: ${passed}/${results.length} passed, ${failures} failed in ${(overallElapsedMs / 1000).toFixed(1)}s`,
        "",
        ...results.map((r) => {
          const taskTag = r.task ? ` [${r.task}]` : "";
          const details = formatModelDetails(r);
          const elapsed = `${(r.elapsedMs / 1000).toFixed(1)}s`;
          const usage =
            r.inputTokens !== undefined
              ? ` · ${formatTokenCount(r.inputTokens)} in · ${formatTokenCount(r.outputTokens ?? 0)} out · ${formatCost(r.costUsd ?? 0)}`
              : "";
          if (r.status === "ok") {
            return `- ✅ ${r.label}${taskTag}${details} — ${elapsed}${usage}`;
          }
          if (r.status === "unexpected") {
            return `- ⚠️ ${r.label}${taskTag}${details} — unexpected response (${elapsed})${usage}: "${r.response}"`;
          }
          return `- ❌ ${r.label}${taskTag}${details} — failed after ${elapsed}: ${r.error}`;
        }),
      ];

      if (totalCost > 0) {
        summaryLines.push(
          "",
          `Totals: ${formatTokenCount(totalInput)} in · ${formatTokenCount(totalOutput)} out · ${formatCost(totalCost)}`,
        );
      }

      notifyProgress(
        totalStages,
        totalStages,
        failures === 0 ? "All connections verified" : `${failures} connection(s) failed`,
      );
      ctx.ui.notify(summaryLines.join("\n"), failures === 0 ? "info" : "error");
      clearYooStatus(ctx);
    },
  });

  pi.registerCommand("yoo-scan", {
    description: "Alias for /yoo scan — scan project conventions",
    handler: async (_args, ctx) => {
      const signal = undefined;
      const progress = createProgressReporter("scan", ctx);
      const notifyProgress: ProgressReporter = (stage, total, message) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };

      let result: YooToolResult;
      try {
        result = await executeYooScan(ctx.cwd, signal, notifyProgress, ctx.sessionManager);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent(ctx.cwd, "error", "yoo-scan command failed", { error: message });
        ctx.ui.notify(`yoo-scan error: ${message}`, "error");
        return;
      } finally {
        clearYooStatus(ctx);
      }

      const text = formatResultText(result);
      ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
    },
  });

  pi.registerCommand("yoo-scan-deep", {
    description: "Run /yoo scan with deep source-file sampling enabled",
    handler: async (_args, ctx) => {
      const signal = undefined;
      const progress = createProgressReporter("scan", ctx);
      const notifyProgress: ProgressReporter = (stage, total, message) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };

      let result: YooToolResult;
      try {
        result = await executeYooScan(ctx.cwd, signal, notifyProgress, ctx.sessionManager, true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent(ctx.cwd, "error", "yoo-scan-deep command failed", { error: message });
        ctx.ui.notify(`yoo-scan-deep error: ${message}`, "error");
        return;
      } finally {
        clearYooStatus(ctx);
      }

      const text = formatResultText(result);
      ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
    },
  });

  pi.registerCommand("yoo-backend", {
    description: "Switch secondary model backend: sdk (default), pi, or http",
    handler: async (args, ctx) => {
      const config = loadHeyyooConfig(ctx.cwd);
      const VALID_BACKENDS = ["sdk", "pi", "http"] as const;
      type Backend = (typeof VALID_BACKENDS)[number];
      const current = config.secondary.backend ?? "sdk";
      const requested = args.trim().toLowerCase();
      let next: Backend;
      if (VALID_BACKENDS.includes(requested as Backend)) {
        next = requested as Backend;
      } else {
        const idx = VALID_BACKENDS.indexOf(current as Backend);
        next = VALID_BACKENDS[(idx + 1) % VALID_BACKENDS.length];
      }

      const settingsPath = join(getAgentDir(), "settings.json");
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
        } catch (err) {
          logEvent(ctx.cwd, "error", "Failed to read settings for yoo-backend", {
            error: err instanceof Error ? err.message : String(err),
          });
          ctx.ui.notify("Failed to read settings.json.", "error");
          return;
        }
      }

      if (!settings["pi-heyyoo"] || typeof settings["pi-heyyoo"] !== "object") {
        settings["pi-heyyoo"] = {};
      }
      const yooSettings = settings["pi-heyyoo"] as Record<string, unknown>;
      if (!yooSettings.secondary || typeof yooSettings.secondary !== "object") {
        yooSettings.secondary = {};
      }
      const secondary = yooSettings.secondary as Record<string, unknown>;
      secondary.backend = next;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

      ctx.ui.notify(`yoo secondary backend switched to ${next}. /reload to apply.`, "info");
    },
  });
}

async function showYooStatus(ctx: ExtensionContext): Promise<void> {
  const config = loadHeyyooConfig(ctx.cwd);
  const state = getState(ctx.cwd);
  const cost = getSessionCost(ctx.cwd);
  const conventions = loadConventions(ctx.cwd);
  const vcs = getVcsInfo(ctx.cwd);

  function modelStatusLine(model: SecondaryModelConfig): string {
    const backend = model.backend && model.backend !== "pi" ? ` (${model.backend})` : "";
    const thinking = model.thinking ? ` · ${model.thinking}` : "";
    return `${model.provider}:${model.id}${backend}${thinking}`;
  }

  const taskModelEntries = YOO_MODEL_TASKS.filter((a) => {
    const override = config.taskModels?.[a];
    return override?.provider || override?.id;
  });

  const lines = [
    `pi-heyyoo v${VERSION}`,
    HOMEPAGE,
    "",
    "Configuration:",
    config.secondary.provider && config.secondary.id
      ? `  Base model: ${modelStatusLine(config.secondary)}`
      : "  Base model: not configured",
    `  Backend: ${config.secondary.backend ?? "sdk"}`,
    `  Auto-judge: ${config.autoJudge ? "enabled" : "disabled"}`,
    config.preReviewCommands && config.preReviewCommands.length > 0
      ? `  Pre-review commands: ${config.preReviewCommands.join(", ")}`
      : "  Pre-review commands: none",
    "",
    "Session:",
    `  Cost: ${formatCost(cost.costUsd)} (${cost.calls} call${cost.calls === 1 ? "" : "s"})`,
    `  Review rounds this step: ${state.reviewRounds}`,
    "",
    "Plan:",
    state.plan ? `  Summary: ${state.plan.summary}` : "  No active plan",
  ];

  if (taskModelEntries.length > 0) {
    const sessionIndex = lines.indexOf("Session:");
    const insertAt = sessionIndex > 0 ? sessionIndex - 1 : lines.length;
    lines.splice(
      insertAt,
      0,
      "  Per-tool models:",
      ...taskModelEntries.map((action) => `    ${action}: ${modelStatusLine(resolveTaskModel(config, action))}`),
    );
  }

  if (state.plan) {
    lines.push(`  Progress: ${state.completedSteps}/${state.totalSteps} steps completed`);
    for (let i = 0; i < state.plan.todo.length; i++) {
      lines.push(`    ${state.completedSteps > i ? "✓" : "·"} ${planStepDescription(state.plan.todo[i])}`);
    }
    if (state.plan.acceptanceCriteria.length > 0) {
      lines.push("  Acceptance criteria:");
      for (const c of state.plan.acceptanceCriteria) {
        lines.push(`    · ${c}`);
      }
    }
  }

  lines.push("", "Version control:");
  if (vcs.type === "unknown") {
    lines.push("  No git or svn repository detected");
  } else {
    lines.push(`  Type: ${vcs.type}`);
    if (vcs.branch) lines.push(`  Branch/URL: ${vcs.branch}`);
    if (vcs.revision) lines.push(`  Revision: ${vcs.revision}`);
    if (vcs.dirty !== undefined) lines.push(`  Dirty: ${vcs.dirty ? "yes" : "no"}`);
    if (vcs.error) lines.push(`  Error: ${vcs.error}`);
  }

  lines.push("", "Project conventions:");
  if (conventions) {
    lines.push(`  Stack: ${conventions.stack}`);
    lines.push(`  Naming: ${conventions.naming}`);
    lines.push(`  Structure: ${conventions.structure}`);
    lines.push(`  Patterns: ${conventions.patterns.length > 0 ? conventions.patterns.join("; ") : "none"}`);
    lines.push(`  Scanned at: ${conventions.generatedAt}`);
  } else {
    lines.push("  Not scanned — run yoo({ scan: true })");
  }

  lines.push("", `${HOMEPAGE} · pi-heyyoo v${VERSION}`);

  await ctx.ui.select("yoo status", lines.filter(Boolean));
}

function issueEmoji(severity: "high" | "medium" | "low"): string {
  switch (severity) {
    case "high":
      return "🔴";
    case "medium":
      return "🟡";
    default:
      return "💡";
  }
}

function formatModelSuffix(model?: StageProfile): string {
  if (!model?.provider || !model.id) return "";
  const thinking = model.thinking && model.thinking.toLowerCase() !== "off" ? ` (${model.thinking})` : "";
  return ` · ${model.provider}:${model.id}${thinking}`;
}

function formatResultText(result: YooToolResult): string {
  if (result.error) return `yoo error: ${result.error}`;

  const lines: string[] = [];

  if (result.cost) {
    const inTokens = formatTokenCount(result.cost.estimatedInputTokens);
    const outTokens = formatTokenCount(result.cost.estimatedOutputTokens);
    const cost = formatCost(result.cost.estimatedCostUsd);
    const session = formatCost(result.cost.sessionCostUsd);
    lines.push(`_${inTokens} in · ${outTokens} out · ${cost} (session ${session})_`);
    lines.push("");
  }

  if (result.plan) {
    lines.push(`## yoo plan${formatModelSuffix(result.model)}`);
    lines.push("");
    lines.push(`**Summary:** ${result.plan.summary}`);
    lines.push("");
    lines.push("### Todo");
    for (let i = 0; i < result.plan.todo.length; i++) {
      const step = result.plan.todo[i];
      const desc = planStepDescription(step);
      const badges: string[] = [];
      if (isPlanStep(step)) {
        if (step.priority) {
          const icon = step.priority === "high" ? "🔴" : step.priority === "medium" ? "🟡" : "🟢";
          badges.push(`${icon} ${step.priority}`);
        }
        if (step.dependsOn && step.dependsOn.length > 0) {
          badges.push(`depends on ${step.dependsOn.map((n) => `#${n}`).join(", ")}`);
        }
      }
      lines.push(`${i + 1}. ${desc}${badges.length > 0 ? ` (${badges.join(" · ")})` : ""}`);
    }
    lines.push("");
    lines.push("### Acceptance Criteria");
    for (const c of result.plan.acceptanceCriteria) {
      lines.push(`- ${c}`);
    }
  }

  if (result.review) {
    const icon = result.review.verdict === "pass" ? "✓" : result.review.verdict === "blocked" ? "✗" : "⚠";
    lines.push(`## yoo review ${icon} ${result.review.verdict}${formatModelSuffix(result.model)}`);
    lines.push("");

    if (result.review.truncated || (result.review.droppedFiles && result.review.droppedFiles.length > 0)) {
      const warnings: string[] = [];
      if (result.review.truncated) warnings.push("diff truncated");
      if (result.review.droppedFiles && result.review.droppedFiles.length > 0)
        warnings.push(`${result.review.droppedFiles.length} file(s) omitted from context`);
      lines.push(`⚠️ **Large change:** ${warnings.join(" · ")}`);
      lines.push("");
    }

    if (result.review.issues.length > 0) {
      lines.push("### Issues");
      for (const issue of result.review.issues) {
        const loc = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "unknown";
        lines.push(`- ${issueEmoji(issue.severity)} **${issue.severity}** ${loc}: ${issue.issue}`);
        if (issue.suggestion) lines.push(`  → ${issue.suggestion}`);
      }
      lines.push("");

      if (result.review.verdict !== "pass") {
        lines.push("### Fix plan");
        for (let i = 0; i < result.review.issues.length; i++) {
          const issue = result.review.issues[i];
          const loc = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "unknown";
          lines.push(
            `${i + 1}. ${issueEmoji(issue.severity)} **${issue.severity}** ${loc}: ${issue.suggestion || issue.issue}`,
          );
        }
        lines.push("");
      }
    }

    if (result.review.suggestions.length > 0) {
      lines.push("### Suggestions");
      for (const s of result.review.suggestions) {
        lines.push(`- 💡 ${s}`);
      }
      lines.push("");
    }

    if (result.review.consensus) {
      lines.push("**Consensus:** Both agents agree — step is complete.");
      if (result.review.planProgress) {
        lines.push(`**Progress:** ${result.review.planProgress}`);
      }
      if (result.review.nextStep) {
        lines.push(`**Next step:** ${result.review.nextStep}`);
      }
      if (result.review.autoJudged) {
        lines.push("**Auto-judge:** Last step done — final review was run automatically.");
      }
    } else if (result.review.verdict === "needs-work" || result.review.verdict === "blocked") {
      lines.push("**Action:** Fix the issues above and call `yoo.review` again.");
      if (result.review.escalated) {
        lines.push(
          "⚠️ **Escalation:** This step has failed review 3+ times. Consider asking the user for guidance or a different approach.",
        );
      }
    }
  }

  if (result.suggest) {
    lines.push(`## yoo suggest${formatModelSuffix(result.model)}`);
    lines.push("");
    for (const a of result.suggest.approaches) {
      lines.push(`### ${a.title}`);
      lines.push(a.description);
      lines.push("");
      if (a.pros.length > 0) {
        lines.push("**Pros:**");
        for (const p of a.pros) lines.push(`- ${p}`);
        lines.push("");
      }
      if (a.cons.length > 0) {
        lines.push("**Cons:**");
        for (const c of a.cons) lines.push(`- ${c}`);
        lines.push("");
      }
    }
  }

  if (result.recommend) {
    lines.push(`## yoo recommend${formatModelSuffix(result.model)}`);
    lines.push("");
    lines.push(`**Next step:** ${result.recommend.nextStep}`);
    lines.push("");
    lines.push(`**Reasoning:** ${result.recommend.reasoning}`);
    if (result.recommend.alternatives.length > 0) {
      lines.push("");
      lines.push("**Alternatives considered:**");
      for (const a of result.recommend.alternatives) {
        lines.push(`- ${a}`);
      }
    }
  }

  if (result.test) {
    const icon = result.test.verdict === "pass" ? "✓" : result.test.verdict === "blocked" ? "✗" : "⚠";
    lines.push(`## yoo test ${icon} ${result.test.verdict}${formatModelSuffix(result.model)}`);
    lines.push("");
    lines.push(result.test.summary);
    lines.push("");

    if (result.test.missingTests.length > 0) {
      lines.push("### Missing tests");
      for (const item of result.test.missingTests) {
        const loc = item.file ? `\`${item.file}\`` : "general";
        lines.push(`- ${loc}: ${item.reason}`);
      }
      lines.push("");
    }

    if (result.test.findings.length > 0) {
      lines.push("### Findings");
      for (const finding of result.test.findings) {
        const loc = finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : "unknown";
        const category = finding.category ? ` · ${finding.category}` : "";
        lines.push(`- ${issueEmoji(finding.severity)} **${finding.severity}**${category} ${loc}: ${finding.issue}`);
        if (finding.suggestion) lines.push(`  → ${finding.suggestion}`);
      }
      lines.push("");
    }

    if (result.test.verdict === "pass" && result.test.findings.length === 0 && result.test.missingTests.length === 0) {
      lines.push("**Tests look good.**");
    }
  }

  if (result.security) {
    const icon = result.security.verdict === "pass" ? "✓" : "⚠";
    lines.push(`## yoo security ${icon} ${result.security.verdict}${formatModelSuffix(result.model)}`);
    lines.push("");
    lines.push(result.security.summary);
    lines.push("");

    if (result.security.findings.length > 0) {
      lines.push("### Findings");
      for (const finding of result.security.findings) {
        const loc = finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : "unknown";
        const emoji =
          finding.severity === "critical"
            ? "🔴"
            : finding.severity === "high"
              ? "🟠"
              : finding.severity === "medium"
                ? "🟡"
                : "💡";
        lines.push(`- ${emoji} **${finding.severity}** · ${finding.category} ${loc}: ${finding.issue}`);
        if (finding.suggestion) lines.push(`  → ${finding.suggestion}`);
      }
      lines.push("");
    }

    if (result.security.verdict === "pass") {
      lines.push("**No significant security issues found.**");
    }
  }

  if (result.judge) {
    const icon = result.judge.verdict === "pass" ? "✓" : result.judge.verdict === "blocked" ? "✗" : "⚠";
    lines.push(`## yoo judge ${icon} ${result.judge.verdict}${formatModelSuffix(result.model)}`);
    lines.push("");
    lines.push(result.judge.summary);
    lines.push("");

    if (result.judge.issues.length > 0) {
      lines.push("### Remaining Issues");
      for (const issue of result.judge.issues) {
        const loc = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "unknown";
        lines.push(`- ${issueEmoji(issue.severity)} **${issue.severity}** ${loc}: ${issue.issue}`);
      }
      lines.push("");
    }

    if (result.judge.consensus) {
      lines.push("**Consensus:** Both agents agree — all work is complete and meets criteria.");
    }
  }

  if (result.scan) {
    lines.push(`## yoo scan${formatModelSuffix(result.model)}`);
    lines.push("");
    lines.push(formatConventions(result.scan.conventions));
    lines.push("");
    lines.push(`Scanned ${result.scan.files.length} files.`);
  }

  if (result.verificationRequested) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("### Main agent verification required");
    lines.push("");
    lines.push("Before acting on this yoo finding, confirm whether it actually makes sense.");
    lines.push("");
    lines.push("Reply with:");
    lines.push("- **Agreement:** `AGREE` / `DISAGREE` / `UNSURE`");
    lines.push("- **Reasoning:** Why does or doesn't this finding make sense?");
    lines.push(
      "- **Evidence:** Cite specific files, lines, facts, or reasoning from the context that support your position.",
    );
    lines.push("");
    lines.push("Do not treat the finding as accepted until you provide this verification.");
  }

  return lines.join("\n");
}
