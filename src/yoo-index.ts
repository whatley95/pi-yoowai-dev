import { loadConventions, formatConventions } from "./conventions.js";
import { isPlanStep, planStepDescription } from "./types.js";
import { getSessionCost } from "./cost-tracker.js";
import { logEvent, readRecentLogs } from "./logger.js";
import {
  loadProjectIndex,
  buildProjectIndex,
  saveProjectIndex,
  formatIndexSummary,
  type ProjectIndex,
} from "./project-index.js";
import { loadState } from "./plan-store.js";
import { getMemorySummary, getPastIssuesForFiles } from "./review-memory.js";
import { findLearnedFacts, formatLearnedFacts, type LearnedFact } from "./yoo-learn.js";
import type { Conventions, HeyyooSessionState, PlanTodoItem } from "./types.js";

export type IndexTopic = "all" | "plan" | "memory" | "conventions" | "cost" | "logs" | "index" | "learned";

export interface YooIndexParams {
  topic?: IndexTopic;
  files?: string[];
  query?: string;
  update?: boolean;
}

const VALID_TOPICS: IndexTopic[] = ["all", "plan", "memory", "conventions", "cost", "logs", "index", "learned"];

export function validateYooIndexParams(raw: unknown): YooIndexParams {
  const params: YooIndexParams = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (typeof r.topic === "string" && (VALID_TOPICS as string[]).includes(r.topic)) {
      params.topic = r.topic as IndexTopic;
    }
    if (Array.isArray(r.files)) {
      params.files = r.files.filter((f): f is string => typeof f === "string");
    }
    if (typeof r.query === "string") {
      params.query = r.query;
    }
    if (r.update === true) {
      params.update = true;
    }
  }
  return params;
}

export interface IndexResult {
  topic: IndexTopic;
  plan?: {
    summary?: string;
    todo?: PlanTodoItem[];
    completedSteps: number;
    totalSteps: number;
    acceptanceCriteria?: string[];
  };
  memory?: string;
  conventions?: Conventions;
  cost?: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    updatedAt: string;
  };
  logs?: string[];
  index?: ProjectIndex;
  indexSummary?: string;
  indexUpdated?: boolean;
  learned?: LearnedFact[];
  learnedSummary?: string;
}

function normalizeTopic(topic: unknown): IndexTopic {
  if (typeof topic === "string" && (VALID_TOPICS as string[]).includes(topic)) {
    return topic as IndexTopic;
  }
  return "all";
}

function pickPlan(state: HeyyooSessionState | null) {
  if (!state?.plan) return undefined;
  return {
    summary: state.plan.summary,
    todo: state.plan.todo,
    completedSteps: state.completedSteps,
    totalSteps: state.totalSteps,
    acceptanceCriteria: state.plan.acceptanceCriteria,
  };
}

export function executeYooIndex(cwd: string, params: YooIndexParams): IndexResult {
  const topic = normalizeTopic(params.topic);
  const files = Array.isArray(params.files) ? params.files : [];
  const query = typeof params.query === "string" ? params.query.toLowerCase() : "";

  const wants = (t: IndexTopic) => topic === "all" || topic === t;

  const result: IndexResult = { topic };

  if (params.update) {
    try {
      const index = buildProjectIndex(cwd);
      saveProjectIndex(cwd, index);
      result.indexUpdated = true;
    } catch (err) {
      result.indexUpdated = false;
      logEvent(cwd, "warn", "yoo_index update failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (wants("conventions")) {
    const conventions = loadConventions(cwd);
    if (conventions) {
      result.conventions = conventions;
    }
  }

  if (wants("plan")) {
    const state = loadState(cwd);
    if (state) {
      result.plan = pickPlan(state);
    }
  }

  if (wants("memory")) {
    const memoryText = files.length > 0 ? getPastIssuesForFiles(cwd, files) : getMemorySummary(cwd);
    result.memory = query ? filterText(memoryText, query) : memoryText;
  }

  if (wants("learned")) {
    const learnedFacts = findLearnedFacts(cwd, query || undefined);
    result.learned = learnedFacts;
    result.learnedSummary = formatLearnedFacts(learnedFacts);
  }

  if (wants("cost")) {
    result.cost = getSessionCost(cwd);
  }

  if (wants("logs")) {
    const limit = topic === "all" ? 10 : 50;
    result.logs = readRecentLogs(cwd, limit);
  }

  if (wants("index")) {
    const index = loadProjectIndex(cwd);
    if (index) {
      result.index = index;
      result.indexSummary = formatIndexSummary(index, query || undefined);
    }
  }

  return result;
}

function filterText(text: string, query: string): string {
  const lines = text.split("\n");
  const filtered = lines.filter((line) => line.toLowerCase().includes(query));
  if (filtered.length === 0) return "";
  return filtered.join("\n");
}

export function formatIndexResult(result: IndexResult): string {
  const parts: string[] = [];
  parts.push(`# yoo index (${result.topic})`);

  if (result.indexUpdated === true) {
    parts.push("\n_Index updated successfully._");
  } else if (result.indexUpdated === false) {
    parts.push("\n_Index update failed (see logs for details)._");
  }

  if (result.conventions) {
    parts.push("\n## Project conventions\n");
    if (result.topic === "conventions") {
      parts.push(formatConventions(result.conventions));
    } else {
      parts.push(formatConventionsSummary(result.conventions));
    }
  }

  if (result.plan) {
    parts.push("\n## Active plan\n");
    parts.push(`Summary: ${result.plan.summary || "(none)"}`);
    parts.push(`Progress: ${result.plan.completedSteps}/${result.plan.totalSteps} steps`);
    if (result.plan.todo && result.plan.todo.length > 0) {
      parts.push("\nTodo:");
      for (const step of result.plan.todo) {
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
        parts.push(`- ${desc}${badges.length > 0 ? ` (${badges.join(" · ")})` : ""}`);
      }
    }
    if (result.plan.acceptanceCriteria && result.plan.acceptanceCriteria.length > 0) {
      parts.push("\nAcceptance criteria:");
      for (const criterion of result.plan.acceptanceCriteria) {
        parts.push(`- ${criterion}`);
      }
    }
  }

  if (result.memory !== undefined) {
    parts.push("\n## Review memory\n");
    parts.push(result.memory || "No past issues recorded for the requested files.");
  }

  if (result.cost) {
    parts.push("\n## Session cost\n");
    parts.push(`Calls: ${result.cost.calls}`);
    parts.push(`Input tokens: ${result.cost.inputTokens}`);
    parts.push(`Output tokens: ${result.cost.outputTokens}`);
    parts.push(`Estimated cost: $${result.cost.costUsd.toFixed(6)}`);
  }

  if (result.indexSummary !== undefined) {
    parts.push("\n## Project index\n");
    parts.push(result.indexSummary);
  }

  if (result.learnedSummary !== undefined) {
    parts.push("\n## Learned facts\n");
    parts.push(result.learnedSummary);
  }

  if (result.logs) {
    parts.push("\n## Recent logs\n");
    if (result.logs.length === 0) {
      parts.push("No recent log entries.");
    } else {
      const limit = result.topic === "logs" ? result.logs.length : 10;
      for (const line of result.logs.slice(0, limit)) {
        parts.push(line);
      }
      if (result.logs.length > limit) {
        parts.push(`... and ${result.logs.length - limit} more entries (use topic: "logs" for all)`);
      }
    }
  }

  if (
    !result.conventions &&
    !result.plan &&
    result.memory === undefined &&
    !result.cost &&
    !result.logs &&
    !result.index &&
    !result.learned
  ) {
    parts.push("\nNo stored yoo context found. Run `yoo scan` to build project conventions.");
  }

  return parts.join("\n");
}

function formatConventionsSummary(conventions: Conventions): string {
  const lines: string[] = [];
  lines.push(`Stack: ${conventions.stack}`);
  lines.push(`Naming: ${conventions.naming}`);
  lines.push(`Structure: ${conventions.structure}`);
  if (conventions.patterns.length > 0) {
    lines.push(`Patterns: ${conventions.patterns.join("; ")}`);
  }
  if (conventions.entryPoints.length > 0) {
    lines.push(`Entry points: ${conventions.entryPoints.join(", ")}`);
  }
  if (conventions.scripts.length > 0) {
    lines.push(`Scripts: ${conventions.scripts.join("; ")}`);
  }
  if (conventions.testing) lines.push(`Testing: ${conventions.testing}`);
  if (conventions.orm) lines.push(`ORM: ${conventions.orm}`);
  if (conventions.ui) lines.push(`UI: ${conventions.ui}`);
  if (conventions.styling) lines.push(`Styling: ${conventions.styling}`);
  if (conventions.buildTool) lines.push(`Build tool: ${conventions.buildTool}`);
  if (conventions.ci) lines.push(`CI: ${conventions.ci}`);
  if (conventions.packageManager) lines.push(`Package manager: ${conventions.packageManager}`);
  return lines.join("\n");
}
