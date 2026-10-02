import { loadConventions, formatConventions } from "./conventions.js";
import { isPlanStep, planStepDescription } from "./types.js";
import { getSessionCost } from "./cost-tracker.js";
import { logEvent, readRecentLogs } from "./logger.js";
import {
  loadFreshProjectIndex,
  buildProjectIndex,
  saveProjectIndex,
  formatIndexSummary,
  type ProjectIndex,
} from "./project-index.js";
import { loadState } from "./plan-store.js";
import { getMemorySummary, getPastIssuesForFiles, getMemoryEntries } from "./review-memory.js";
import { findLearnedFacts, formatLearnedFactsWithFreshness, type LearnedFact } from "./wai-learn.js";
import type { Conventions, YoowaiSessionState, PlanTodoItem, MemoryEntry } from "./types.js";
import { WAI_NAMESPACE } from "./tool-guidance.js";
import { formatSkillDiagnostics, getSkillDiagnostics } from "./integration/skills.js";

export type IndexTopic = "all" | "plan" | "memory" | "conventions" | "cost" | "logs" | "index" | "learned" | "guidance";

export interface WaiIndexParams {
  topic?: IndexTopic;
  files?: string[];
  query?: string;
  update?: boolean;
  /** Bound returned memory files, learned facts, and index files/symbols; never review coverage. */
  limit?: number;
}

const VALID_TOPICS: IndexTopic[] = [
  "all",
  "plan",
  "memory",
  "conventions",
  "cost",
  "logs",
  "index",
  "learned",
  "guidance",
];

export function validateWaiIndexParams(raw: unknown): WaiIndexParams {
  const params: WaiIndexParams = {};
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
    if (typeof r.limit === "number" && Number.isInteger(r.limit) && r.limit > 0) params.limit = Math.min(r.limit, 100);
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
  memoryEntries?: MemoryEntry[];
  guidance?: string;
  skills?: ReturnType<typeof getSkillDiagnostics>;
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
  selection?: {
    memory?: { matched: number; returned: number };
    learned?: { matched: number; returned: number };
    index?: {
      totalFiles: number;
      matchedFiles: number;
      returnedFiles: number;
      matchedSymbols: number;
      returnedSymbols: number;
      limited: boolean;
    };
  };
}

function normalizeTopic(topic: unknown): IndexTopic {
  if (typeof topic === "string" && (VALID_TOPICS as string[]).includes(topic)) {
    return topic as IndexTopic;
  }
  return "all";
}

function pickPlan(state: YoowaiSessionState | null) {
  if (!state?.plan) return undefined;
  return {
    summary: state.plan.summary,
    todo: state.plan.todo,
    completedSteps: state.completedSteps,
    totalSteps: state.totalSteps,
    acceptanceCriteria: state.plan.acceptanceCriteria,
  };
}

export function executeWaiIndex(cwd: string, params: WaiIndexParams): IndexResult {
  const topic = normalizeTopic(params.topic);
  const files = Array.isArray(params.files) ? params.files : [];
  const query = typeof params.query === "string" ? params.query.toLowerCase() : "";

  const wants = (t: IndexTopic) => topic === "all" || topic === t;

  const result: IndexResult = { topic };
  // Guidance stays on-demand; topic 'all' must not inject it into every context query.
  if (topic === "guidance")
    return {
      topic,
      guidance: WAI_NAMESPACE.instructions + "\n\n" + formatSkillDiagnostics(cwd),
      skills: getSkillDiagnostics(cwd),
    };
  const limit =
    typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit > 0
      ? Math.min(params.limit, 100)
      : undefined;
  const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const scopes = files.map(normalizePath);
  const matchesFile = (file: string) =>
    !scopes.length ||
    scopes.some((scope) => {
      const path = normalizePath(file);
      return path === scope || path.startsWith(`${scope.replace(/\/$/, "")}/`);
    });

  if (params.update) {
    try {
      const index = buildProjectIndex(cwd);
      saveProjectIndex(cwd, index);
      result.indexUpdated = true;
    } catch (err) {
      result.indexUpdated = false;
      logEvent(cwd, "warn", "wai_index update failed", {
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
    const entries = getMemoryEntries(cwd)
      .filter((entry) => matchesFile(entry.file))
      .map((entry) => ({
        ...entry,
        issues: entry.issues.filter(
          (issue) => !query || `${entry.file} ${issue.issue} ${issue.suggestion}`.toLowerCase().includes(query),
        ),
      }))
      .filter((entry) => entry.issues.length > 0);
    result.memoryEntries = limit ? entries.slice(0, limit) : entries;
    result.selection = {
      ...result.selection,
      memory: { matched: entries.length, returned: result.memoryEntries.length },
    };
    result.memory = query
      ? getMemorySummary(cwd, query, files)
      : files.length > 0
        ? getPastIssuesForFiles(cwd, files)
        : getMemorySummary(cwd);
    if (limit || scopes.some((scope) => !entries.some((entry) => normalizePath(entry.file) === scope))) {
      result.memory = result.memoryEntries
        .map(
          (entry) =>
            `${entry.file}:\n${entry.issues.map((issue) => `  - [${issue.severity}] ${issue.issue}`).join("\n")}`,
        )
        .join("\n\n");
    }
  }

  if (wants("learned")) {
    const learnedFacts = findLearnedFacts(cwd, query || undefined).filter(
      (fact) => !scopes.length || (fact.source && matchesFile(fact.source)),
    );
    result.learned = limit ? learnedFacts.slice(0, limit) : learnedFacts;
    result.selection = {
      ...result.selection,
      learned: { matched: learnedFacts.length, returned: result.learned.length },
    };
    result.learnedSummary = formatLearnedFactsWithFreshness(result.learned);
  }

  if (wants("cost")) {
    result.cost = getSessionCost(cwd);
  }

  if (wants("logs")) {
    const limit = topic === "all" ? 10 : 50;
    result.logs = readRecentLogs(cwd, limit);
  }

  if (wants("index")) {
    const index = loadFreshProjectIndex(cwd);
    if (index) {
      const matchingFiles = index.files
        .filter((file) => matchesFile(file.file))
        .map((file) => ({
          ...file,
          symbols:
            !query || file.file.toLowerCase().includes(query)
              ? file.symbols
              : file.symbols.filter((symbol) =>
                  `${symbol.name} ${symbol.signature ?? ""}`.toLowerCase().includes(query),
                ),
        }))
        .filter((file) => !query || file.symbols.length > 0 || file.file.toLowerCase().includes(query));
      let remaining = limit ?? Number.POSITIVE_INFINITY;
      const selectedFiles = (limit ? matchingFiles.slice(0, limit) : matchingFiles).map((file) => {
        const symbols = file.symbols.slice(0, remaining);
        remaining -= symbols.length;
        return { ...file, symbols };
      });
      result.index = { ...index, files: selectedFiles };
      const matchedSymbols = matchingFiles.reduce((sum, file) => sum + file.symbols.length, 0);
      const returnedSymbols = selectedFiles.reduce((sum, file) => sum + file.symbols.length, 0);
      result.selection = {
        ...result.selection,
        index: {
          totalFiles: index.files.length,
          matchedFiles: matchingFiles.length,
          returnedFiles: selectedFiles.length,
          matchedSymbols,
          returnedSymbols,
          limited: selectedFiles.length < matchingFiles.length || returnedSymbols < matchedSymbols,
        },
      };
      result.indexSummary = formatIndexSummary(result.index, query || undefined);
    }
  }

  return result;
}

export function formatIndexResult(result: IndexResult): string {
  const parts: string[] = [];
  parts.push(`# wai index (${result.topic})`);
  if (result.guidance) return `${parts[0]}\n\n${result.guidance}`;
  if (result.selection) {
    const selected = result.selection;
    const counts = [
      selected.memory ? `memory files ${selected.memory.returned}/${selected.memory.matched}` : "",
      selected.learned ? `learned facts ${selected.learned.returned}/${selected.learned.matched}` : "",
      selected.index
        ? `index files ${selected.index.returnedFiles}/${selected.index.matchedFiles}, symbols ${selected.index.returnedSymbols}/${selected.index.matchedSymbols}`
        : "",
    ].filter(Boolean);
    if (counts.length) parts.push(`Selection: ${counts.join("; ")}. Knowledge selection is not review coverage.`);
  }

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
    parts.push("\nNo stored wai context found. Run `wai scan` to build project conventions.");
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
