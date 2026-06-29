import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadHeyyooConfig } from "./config.js";
import { callSecondaryModel } from "./secondary-model.js";
import { getGitDiff } from "./diff-grabber.js";
import {
  buildPlanPrompt,
  buildReviewPrompt,
  buildSuggestPrompt,
  buildRecommendPrompt,
  buildJudgePrompt,
  parseJsonResponse,
  validatePlanResult,
  validateReviewResult,
  validateSuggestResult,
  validateRecommendResult,
  validateJudgeResult,
} from "./prompts.js";
import { renderCall, renderResult } from "./render.js";
import { loadState, saveState, clearState } from "./plan-store.js";
import type { YooToolParams, YooToolResult, HeyyooSessionState, PlanResult } from "./types.js";

const sessionStates = new Map<string, HeyyooSessionState>();

function getState(cwd: string): HeyyooSessionState {
  let state = sessionStates.get(cwd);
  if (!state) {
    state = loadState(cwd) ?? { completedSteps: 0, totalSteps: 0, reviewRounds: 0 };
    sessionStates.set(cwd, state);
  }
  return state;
}

function setPlan(cwd: string, plan: PlanResult): void {
  const state = getState(cwd);
  state.plan = plan;
  state.totalSteps = plan.todo.length;
  state.completedSteps = 0;
  state.reviewRounds = 0;
  saveState(cwd, state);
}

function markStepComplete(cwd: string): void {
  const state = getState(cwd);
  if (state.totalSteps > 0 && state.completedSteps < state.totalSteps) {
    state.completedSteps++;
    state.reviewRounds = 0;
    saveState(cwd, state);
  }
}

function incrementReviewRounds(cwd: string): void {
  const state = getState(cwd);
  state.reviewRounds++;
  saveState(cwd, state);
}

function getProgress(cwd: string): { current: number; total: number; nextStep?: string } {
  const state = getState(cwd);
  const current = state.completedSteps;
  const total = state.totalSteps;
  const nextStep = state.plan?.todo[current] ?? undefined;
  return { current, total, nextStep };
}

function buildReviewHistory(cwd: string): string {
  const state = getState(cwd);
  if (!state.plan || state.plan.todo.length === 0) return "";
  const lines: string[] = [];
  for (let i = 0; i < state.plan.todo.length; i++) {
    if (i < state.completedSteps) {
      lines.push(`✓ Step ${i + 1}: ${state.plan.todo[i]} — reviewed and passed`);
    } else if (i === state.completedSteps) {
      lines.push(`→ Step ${i + 1}: ${state.plan.todo[i]} — current (may or may not be done)`);
    } else {
      lines.push(`· Step ${i + 1}: ${state.plan.todo[i]} — not yet started`);
    }
  }
  return lines.join("\n");
}

const MAX_SESSION_CONTEXT_CHARS = 4000;

function getSessionContext(ctx: ExtensionContext): string {
  try {
    const entries = ctx.sessionManager?.getEntries();
    if (!Array.isArray(entries) || entries.length === 0) return "";

    const recent = entries.slice(-10);
    const lines: string[] = [];
    let total = 0;

    for (const entry of recent.reverse()) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const msg = (e.message ?? e) as Record<string, unknown> | undefined;
      if (!msg || typeof msg.role !== "string") continue;
      if (msg.role === "tool") continue;

      const content = extractTextContent(msg);
      if (!content) continue;

      const line = `[${msg.role}] ${content}`;
      if (total + line.length > MAX_SESSION_CONTEXT_CHARS) break;
      lines.push(line);
      total += line.length;
    }

    return lines.reverse().join("\n");
  } catch {
    return "";
  }
}

function extractTextContent(msg: Record<string, unknown>): string {
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c): c is Record<string, unknown> => c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string")
      .map((c) => (c as Record<string, unknown>).text as string)
      .join(" ");
  }
  if (typeof msg.content === "string") return msg.content;
  return "";
}

async function executeYooPlan(
  cwd: string,
  task: string,
  signal?: AbortSignal,
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  if (!config.secondary.id) {
    return { action: "plan", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }

  const { system, user } = buildPlanPrompt(task);
  const raw = await callSecondaryModel(config.secondary.provider, config.secondary.id, system, user, signal);
  const parsed = parseJsonResponse(raw);
  const plan = validatePlanResult(parsed);

  if (!plan) {
    return { action: "plan", error: "Failed to parse plan from secondary model response.", plan: { todo: [task], acceptanceCriteria: [], summary: raw.slice(0, 200) } };
  }

  setPlan(cwd, plan);
  return { action: "plan", plan };
}

async function executeYooReview(
  cwd: string,
  description: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  if (!config.secondary.id) {
    return { action: "review", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }

  const state = getState(cwd);
  const { diff, truncated } = getGitDiff(cwd);
  const sessionContext = getSessionContext(ctx);
  const { system, user } = buildReviewPrompt(description, diff, truncated, state.plan?.acceptanceCriteria, sessionContext);
  const raw = await callSecondaryModel(config.secondary.provider, config.secondary.id, system, user, signal);
  const parsed = parseJsonResponse(raw);
  const review = validateReviewResult(parsed);

  if (!review) {
    return { action: "review", error: "Failed to parse review from secondary model response.", review: { verdict: "needs-work", issues: [], suggestions: [], consensus: false } };
  }

  if (review.consensus) {
    markStepComplete(cwd);
    const progress = getProgress(cwd);
    review.planProgress = `${progress.current}/${progress.total} steps done`;
    if (progress.nextStep) {
      review.nextStep = progress.nextStep;
    }
  } else {
    incrementReviewRounds(cwd);
    const updatedState = getState(cwd);
    if (updatedState.reviewRounds >= 3) {
      review.escalated = true;
      review.suggestions.push("This step has failed review 3 times. Consider asking the user for guidance or trying a fundamentally different approach.");
    }
  }

  return { action: "review", review };
}

async function executeYooSuggest(
  cwd: string,
  question: string,
  signal?: AbortSignal,
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  if (!config.secondary.id) {
    return { action: "suggest", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }

  const { system, user } = buildSuggestPrompt(question);
  const raw = await callSecondaryModel(config.secondary.provider, config.secondary.id, system, user, signal);
  const parsed = parseJsonResponse(raw);
  const suggest = validateSuggestResult(parsed);

  if (!suggest) {
    return { action: "suggest", error: "Failed to parse suggestions from secondary model response." };
  }

  return { action: "suggest", suggest };
}

async function executeYooRecommend(
  cwd: string,
  situation: string,
  signal?: AbortSignal,
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  if (!config.secondary.id) {
    return { action: "recommend", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }

  const state = getState(cwd);
  const { system, user } = buildRecommendPrompt(situation, state.plan?.todo);
  const raw = await callSecondaryModel(config.secondary.provider, config.secondary.id, system, user, signal);
  const parsed = parseJsonResponse(raw);
  const recommend = validateRecommendResult(parsed);

  if (!recommend) {
    return { action: "recommend", error: "Failed to parse recommendation from secondary model response." };
  }

  return { action: "recommend", recommend };
}

async function executeYooJudge(
  cwd: string,
  description: string,
  signal?: AbortSignal,
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  if (!config.secondary.id) {
    return { action: "judge", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }

  const state = getState(cwd);
  const reviewHistory = buildReviewHistory(cwd);
  const { system, user } = buildJudgePrompt(description, state.plan?.todo, state.plan?.acceptanceCriteria, reviewHistory);
  const raw = await callSecondaryModel(config.secondary.provider, config.secondary.id, system, user, signal);
  const parsed = parseJsonResponse(raw);
  const judge = validateJudgeResult(parsed);

  if (!judge) {
    return { action: "judge", error: "Failed to parse judgment from secondary model response." };
  }

  return { action: "judge", judge };
}

export default function (pi: ExtensionAPI) {
  let cwd = process.cwd();

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    const diskState = loadState(cwd);
    if (diskState) {
      sessionStates.set(cwd, diskState);
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    sessionStates.delete(cwd);
  });

  pi.registerTool({
    name: "yoo",
    label: "Yoo — Pair Programmer",
    description:
      "Pair-programmer that reviews your work with a secondary model. Use yoo.plan to create a structured todo plan. Use yoo.review after each code change to get a second opinion. Use yoo.suggest when stuck on a question. Use yoo.recommend when unsure what to do next. Use yoo.judge for a final holistic review of all completed work.",
    promptSnippet: "yoo: secondary model reviews, plans, suggests, recommends, or judges your work",
    promptGuidelines: [
      "Use yoo with plan:true before starting a complex task. The secondary model creates a structured todo list with acceptance criteria.",
      "Use yoo with review:true after each significant code change. The secondary model examines the diff and catches bugs, missing error handling, and convention violations.",
      "Use yoo with suggest:true when you need alternative approaches for a specific technical question.",
      "Use yoo with recommend:true when you're unsure what step to take next.",
      "Use yoo with judge:true after completing all work for a final holistic review against the original plan.",
      "The secondary model should be a DIFFERENT model family than the main model to catch blind spots. Configure in settings.json under pi-heyyoo.secondary.",
      "After yoo.review returns 'needs-work', fix the issues and call yoo.review again until it returns 'pass'.",
      "Only one action (plan/review/suggest/recommend/judge) per call. Do not combine them.",
    ],
    parameters: Type.Object({
      plan: Type.Optional(Type.String({
        description: "Provide a task description to get a structured todo plan with acceptance criteria.",
      })),
      review: Type.Optional(Type.String({
        description: "Provide a description of what you just implemented. The secondary model examines git diff and returns a verdict with issues.",
      })),
      suggest: Type.Optional(Type.String({
        description: "Ask a specific question to get alternative approaches from the secondary model.",
      })),
      recommend: Type.Optional(Type.String({
        description: "Describe your current situation to get a recommended next step from the secondary model.",
      })),
      judge: Type.Optional(Type.String({
        description: "Provide a description of all completed work for a final holistic review against the original plan.",
      })),
    }),
    renderCall,
    renderResult,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const p = params as unknown as YooToolParams;

      if (!p.plan && !p.review && !p.suggest && !p.recommend && !p.judge) {
        return {
          content: [{ type: "text", text: "yoo: No action specified. Provide one of: plan, review, suggest, recommend, or judge." }],
          isError: true,
        };
      }

      let result: YooToolResult;

      try {
        if (p.plan) {
          result = await executeYooPlan(ctx.cwd, p.plan, signal);
        } else if (p.review) {
          result = await executeYooReview(ctx.cwd, p.review, ctx, signal);
        } else if (p.suggest) {
          result = await executeYooSuggest(ctx.cwd, p.suggest, signal);
        } else if (p.recommend) {
          result = await executeYooRecommend(ctx.cwd, p.recommend, signal);
        } else if (p.judge) {
          result = await executeYooJudge(ctx.cwd, p.judge, signal);
        } else {
          result = { action: "plan", error: "Unknown action" };
        }
      } catch (err) {
        result = { action: "plan", error: err instanceof Error ? err.message : String(err) };
      }

      const text = formatResultText(result);

      return {
        content: [{ type: "text", text }],
        details: result,
        isError: Boolean(result.error),
      };
    },
  });

  pi.registerCommand("yoo", {
    description: "Show yoo pair-programmer configuration and status",
    handler: async (_args, ctx) => {
      const config = loadHeyyooConfig(ctx.cwd);
      const state = getState(ctx.cwd);

      const lines = [
        "── yoo pair-programmer ──",
        "",
        "Secondary model:",
        config.secondary.provider && config.secondary.id
          ? `  ${config.secondary.provider}:${config.secondary.id}` + (config.secondary.thinking ? ` • ${config.secondary.thinking}` : "")
          : "  not configured — set pi-heyyoo.secondary in settings.json",
        "",
        "Session plan:",
        state.plan
          ? `  ${state.completedSteps}/${state.totalSteps} steps completed`
          : "  no active plan",
        state.plan
          ? `  ${state.plan.todo.map((t, i) => `${state.completedSteps > i ? " ✓" : " ·"} ${t}`).join("\n  ")}`
          : "",
        "",
        "Configure: /yoo-model to interactively pick a model",
        "          /yoo-config <provider.model> for quick setup",
      ];

      await ctx.ui.select("yoo status", lines.filter(Boolean));
    },
  });

  pi.registerCommand("yoo-config", {
    description: "Configure secondary model for yoo pair-programmer",
    handler: async (args, ctx) => {
      ctx.ui.notify("Edit ~/.pi/agent/settings.json and set pi-heyyoo.secondary.provider and pi-heyyoo.secondary.id", "info");
      if (args.trim()) {
        ctx.ui.notify(`Suggested: ${args.trim()}`, "info");
      }
    },
  });

  pi.registerCommand("yoo-model", {
    description: "Interactively pick the secondary model for yoo",
    handler: async (_args, ctx) => {
      const registry = ctx.modelRegistry as unknown as {
        getAvailable(): Array<{ id: string; provider: string }>;
        getAll?(): Array<{ id: string; provider: string }>;
        getProviderAuthStatus(provider: string): { configured: boolean };
        hasConfiguredAuth(model: { provider: string }): boolean;
      };

      const allModels = typeof registry.getAll === "function" ? registry.getAll() : registry.getAvailable();

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

      const providers = [...new Set(configuredModels.map((m) => m.provider))].sort();
      let provider: string;
      if (providers.length === 1) {
        provider = providers[0];
      } else {
        const picked = await ctx.ui.select(
          "Pick provider:",
          providers.map((p) => {
            const count = configuredModels.filter((m) => m.provider === p).length;
            return `${p} (${count} models)`;
          }),
        );
        if (!picked) return;
        provider = picked.split(" ")[0];
      }

      const providerModels = configuredModels.filter((m) => m.provider === provider).sort((a, b) => a.id.localeCompare(b.id));
      const modelItems = providerModels.map((m) => m.id);
      const currentConfig = loadHeyyooConfig(ctx.cwd);
      const isCurrent = currentConfig.secondary.provider === provider && currentConfig.secondary.id;
      if (isCurrent) {
        const idx = modelItems.indexOf(currentConfig.secondary.id);
        if (idx >= 0) {
          modelItems[idx] = `${modelItems[idx]} ✓ current`;
        }
      }

      const modelIdPicked = await ctx.ui.select(`Pick model for ${provider}:`, modelItems);
      if (!modelIdPicked) return;
      const modelId = modelIdPicked.replace(" ✓ current", "");

      const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
      const currentThinking = currentConfig.secondary.thinking ?? "xhigh";
      const thinkingItems = thinkingLevels.map((t) => `${t}${t === currentThinking && isCurrent && currentConfig.secondary.id === modelId ? " ✓ current" : ""}`);
      const thinkingPicked = await ctx.ui.select("Pick thinking level:", thinkingItems);
      if (!thinkingPicked) return;
      const thinking = thinkingPicked.replace(" ✓ current", "");

      const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const agentDir = (await import("@earendil-works/pi-coding-agent")).getAgentDir();
      const settingsPath = join(agentDir, "settings.json");
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      }
      if (!settings["pi-heyyoo"]) settings["pi-heyyoo"] = {};
      (settings["pi-heyyoo"] as Record<string, unknown>).secondary = {
        provider, id: modelId, thinking,
      };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

      ctx.ui.notify(`Secondary model set to ${provider}:${modelId} (${thinking}). /reload to apply.`, "info");
    },
  });

  pi.registerCommand("yoo-clear", {
    description: "Clear the active yoo plan and session state",
    handler: async (_args, ctx) => {
      sessionStates.delete(ctx.cwd);
      clearState(ctx.cwd);
      ctx.ui.notify("yoo plan and state cleared.", "info");
    },
  });
}

function formatResultText(result: YooToolResult): string {
  if (result.error) return `yoo error: ${result.error}`;

  const lines: string[] = [];

  if (result.plan) {
    lines.push("## yoo plan");
    lines.push("");
    lines.push(`**Summary:** ${result.plan.summary}`);
    lines.push("");
    lines.push("### Todo");
    for (let i = 0; i < result.plan.todo.length; i++) {
      lines.push(`${i + 1}. ${result.plan.todo[i]}`);
    }
    lines.push("");
    lines.push("### Acceptance Criteria");
    for (const c of result.plan.acceptanceCriteria) {
      lines.push(`- ${c}`);
    }
  }

  if (result.review) {
    const icon = result.review.verdict === "pass" ? "✓" : result.review.verdict === "blocked" ? "✗" : "⚠";
    lines.push(`## yoo review ${icon} ${result.review.verdict}`);
    lines.push("");

    if (result.review.issues.length > 0) {
      lines.push("### Issues");
      for (const issue of result.review.issues) {
        const loc = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "unknown";
        lines.push(`- **${issue.severity}** ${loc}: ${issue.issue}`);
        if (issue.suggestion) lines.push(`  → ${issue.suggestion}`);
      }
      lines.push("");
    }

    if (result.review.suggestions.length > 0) {
      lines.push("### Suggestions");
      for (const s of result.review.suggestions) {
        lines.push(`- ${s}`);
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
    } else if (result.review.verdict === "needs-work") {
      lines.push("**Action:** Fix the issues above and call `yoo.review` again.");
      if (result.review.escalated) {
        lines.push("⚠️ **Escalation:** This step has failed review 3+ times. Consider asking the user for guidance or a different approach.");
      }
    }
  }

  if (result.suggest) {
    lines.push("## yoo suggest");
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
    lines.push("## yoo recommend");
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

  if (result.judge) {
    const icon = result.judge.verdict === "pass" ? "✓" : result.judge.verdict === "blocked" ? "✗" : "⚠";
    lines.push(`## yoo judge ${icon} ${result.judge.verdict}`);
    lines.push("");
    lines.push(result.judge.summary);
    lines.push("");

    if (result.judge.issues.length > 0) {
      lines.push("### Remaining Issues");
      for (const issue of result.judge.issues) {
        const loc = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "unknown";
        lines.push(`- **${issue.severity}** ${loc}: ${issue.issue}`);
      }
      lines.push("");
    }

    if (result.judge.consensus) {
      lines.push("**Consensus:** Both agents agree — all work is complete and meets criteria.");
    }
  }

  return lines.join("\n");
}