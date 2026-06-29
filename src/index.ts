import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadHeyyoConfig } from "./config.js";
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
import type { YooToolParams, YooToolResult, HeyyoSessionState, PlanResult } from "./types.js";

const sessionStates = new Map<string, HeyyoSessionState>();

function getState(cwd: string): HeyyoSessionState {
  let state = sessionStates.get(cwd);
  if (!state) {
    state = { completedSteps: 0, totalSteps: 0 };
    sessionStates.set(cwd, state);
  }
  return state;
}

function setPlan(cwd: string, plan: PlanResult): void {
  const state = getState(cwd);
  state.plan = plan;
  state.totalSteps = plan.todo.length;
  state.completedSteps = 0;
}

function markStepComplete(cwd: string): void {
  const state = getState(cwd);
  if (state.totalSteps > 0 && state.completedSteps < state.totalSteps) {
    state.completedSteps++;
  }
}

async function executeYooPlan(
  cwd: string,
  task: string,
  signal?: AbortSignal,
): Promise<YooToolResult> {
  const config = loadHeyyoConfig(cwd);
  if (!config.secondary.id) {
    return { action: "plan", error: "No secondary model configured. Set pi-heyyo.secondary in settings.json." };
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
  signal?: AbortSignal,
): Promise<YooToolResult> {
  const config = loadHeyyoConfig(cwd);
  if (!config.secondary.id) {
    return { action: "review", error: "No secondary model configured. Set pi-heyyo.secondary in settings.json." };
  }

  const state = getState(cwd);
  const { diff, truncated } = getGitDiff(cwd);
  const { system, user } = buildReviewPrompt(description, diff, truncated, state.plan?.acceptanceCriteria);
  const raw = await callSecondaryModel(config.secondary.provider, config.secondary.id, system, user, signal);
  const parsed = parseJsonResponse(raw);
  const review = validateReviewResult(parsed);

  if (!review) {
    return { action: "review", error: "Failed to parse review from secondary model response.", review: { verdict: "needs-work", issues: [], suggestions: [], consensus: false } };
  }

  if (review.consensus) {
    markStepComplete(cwd);
  }

  return { action: "review", review };
}

async function executeYooSuggest(
  cwd: string,
  question: string,
  signal?: AbortSignal,
): Promise<YooToolResult> {
  const config = loadHeyyoConfig(cwd);
  if (!config.secondary.id) {
    return { action: "suggest", error: "No secondary model configured. Set pi-heyyo.secondary in settings.json." };
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
  const config = loadHeyyoConfig(cwd);
  if (!config.secondary.id) {
    return { action: "recommend", error: "No secondary model configured. Set pi-heyyo.secondary in settings.json." };
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
  const config = loadHeyyoConfig(cwd);
  if (!config.secondary.id) {
    return { action: "judge", error: "No secondary model configured. Set pi-heyyo.secondary in settings.json." };
  }

  const state = getState(cwd);
  const { system, user } = buildJudgePrompt(description, state.plan?.todo, state.plan?.acceptanceCriteria);
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
    sessionStates.delete(cwd);
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
      "The secondary model should be a DIFFERENT model family than the main model to catch blind spots. Configure in settings.json under pi-heyyo.secondary.",
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
          result = await executeYooReview(ctx.cwd, p.review, signal);
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
      const config = loadHeyyoConfig(ctx.cwd);
      const state = getState(ctx.cwd);

      const lines = [
        "── yoo pair-programmer ──",
        "",
        "Secondary model:",
        config.secondary.provider && config.secondary.id
          ? `  ${config.secondary.provider}:${config.secondary.id}` + (config.secondary.thinking ? ` • ${config.secondary.thinking}` : "")
          : "  not configured — set pi-heyyo.secondary in settings.json",
        "",
        "Session plan:",
        state.plan
          ? `  ${state.completedSteps}/${state.totalSteps} steps completed`
          : "  no active plan",
        state.plan
          ? `  ${state.plan.todo.map((t, i) => `${state.completedSteps > i ? " ✓" : " ·"} ${t}`).join("\n  ")}`
          : "",
        "",
        "Configure: /yoo config <provider.model>",
      ];

      await ctx.ui.select("yoo status", lines.filter(Boolean));
    },
  });

  pi.registerCommand("yoo-config", {
    description: "Configure secondary model for yoo pair-programmer",
    handler: async (args, ctx) => {
      ctx.ui.notify("Edit ~/.pi/agent/settings.json and set pi-heyyo.secondary.provider and pi-heyyo.secondary.id", "info");
      if (args.trim()) {
        ctx.ui.notify(`Suggested: ${args.trim()}`, "info");
      }
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
    } else if (result.review.verdict === "needs-work") {
      lines.push("**Action:** Fix the issues above and call `yoo.review` again.");
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