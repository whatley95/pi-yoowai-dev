import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";
import { getSessionConfigDir, getSessionConfigPath } from "./session-scope.js";
import { logEvent } from "./logger.js";
import type { YoowaiSessionState, PlanResult, ReviewVerdict } from "./types.js";
import { validatePlanResult } from "./prompts.js";
import { PlanResultSchema } from "./schemas.js";

/** Cap for the reviewedFiles record: oldest entries are evicted first. */
export const MAX_REVIEWED_FILES = 100;

export function isReviewVerdict(value: unknown): value is ReviewVerdict {
  return value === "pass" || value === "needs-work" || value === "blocked";
}

/** Normalize a reviewedFiles record: keep only entries with a valid verdict
 *  and a finite timestamp, cap at the most recent MAX_REVIEWED_FILES entries.
 *  Shared by loadState (disk) and session-state (in-memory) so both stay
 *  bounded and malformed legacy values cannot reach the prompt context. */
export function normalizeReviewedFiles(
  raw: unknown,
): Record<string, { verdict: ReviewVerdict; at: number }> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entries: Array<[string, { verdict: ReviewVerdict; at: number }]> = [];
  for (const [file, rec] of Object.entries(raw)) {
    if (!file || !rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    const verdict = (rec as { verdict?: unknown }).verdict;
    const at = (rec as { at?: unknown }).at;
    if (!isReviewVerdict(verdict)) continue;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    entries.push([file, { verdict, at }]);
  }
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, MAX_REVIEWED_FILES));
}

function getStateDir(cwd: string): string {
  return getSessionConfigDir(cwd, "plan.json");
}

function getPlanPath(cwd: string): string {
  return getSessionConfigPath(cwd, "plan.json");
}

export function loadState(cwd: string): YoowaiSessionState | null {
  const path = getPlanPath(cwd);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const rawPlan = data.plan && typeof data.plan === "object" && !Array.isArray(data.plan) ? data.plan : undefined;
    const plan = rawPlan ? (validatePlanResult(rawPlan) ?? salvagePlan(rawPlan)) : undefined;
    if (rawPlan && !plan) {
      const errors = [...Value.Errors(PlanResultSchema, rawPlan)].map((e) => ({
        path: e.path,
        message: e.message,
        value: e.value,
      }));
      logEvent(cwd, "warn", "Saved plan failed validation and was ignored", { plan: rawPlan, errors });
    }
    const reviewedSteps = Array.isArray(data.reviewedSteps) ? data.reviewedSteps.map((v) => v === true) : [];
    const rawReviewedFiles = data.reviewedFiles;
    const reviewedFiles = normalizeReviewedFiles(rawReviewedFiles);
    const state: YoowaiSessionState = {
      plan: plan || undefined,
      completedSteps: typeof data.completedSteps === "number" ? data.completedSteps : 0,
      totalSteps: typeof data.totalSteps === "number" ? data.totalSteps : 0,
      reviewRounds: Array.isArray(data.reviewRounds) ? data.reviewRounds : [],
      reviewedSteps,
      judgeCompleted: typeof data.judgeCompleted === "boolean" ? data.judgeCompleted : false,
      editsSinceLastReview: typeof data.editsSinceLastReview === "number" ? data.editsSinceLastReview : 0,
      editsSinceLastDone: typeof data.editsSinceLastDone === "number" ? data.editsSinceLastDone : 0,
      unreviewedTurns: typeof data.unreviewedTurns === "number" ? data.unreviewedTurns : 0,
      noPlanTurns: typeof data.noPlanTurns === "number" ? data.noPlanTurns : 0,
      unreviewedEditsTotal: typeof data.unreviewedEditsTotal === "number" ? data.unreviewedEditsTotal : 0,
      unreviewedEditsFlushed: typeof data.unreviewedEditsFlushed === "number" ? data.unreviewedEditsFlushed : 0,
      editedFiles: Array.isArray(data.editedFiles)
        ? data.editedFiles.filter((f): f is string => typeof f === "string" && f.length > 0)
        : [],
      planStaleSuggestedRound:
        typeof data.planStaleSuggestedRound === "number" ? data.planStaleSuggestedRound : undefined,
      pendingReviewCommit:
        typeof data.pendingReviewCommit === "string" && data.pendingReviewCommit.length > 0
          ? data.pendingReviewCommit
          : undefined,
      lastReviewedCommit:
        typeof data.lastReviewedCommit === "string" && data.lastReviewedCommit.length > 0
          ? data.lastReviewedCommit
          : undefined,
      reviewedFiles,
    };
    // Repair malformed legacy reviewedFiles on disk once, so repeated loads
    // stop reprocessing bad data: trigger when the raw value is present but
    // is not a plain object, or when normalization dropped entries.
    const rawIsObject =
      rawReviewedFiles !== null && typeof rawReviewedFiles === "object" && !Array.isArray(rawReviewedFiles);
    const rawCount = rawIsObject ? Object.keys(rawReviewedFiles as Record<string, unknown>).length : 0;
    if (rawReviewedFiles !== undefined && (!rawIsObject || rawCount !== Object.keys(reviewedFiles ?? {}).length)) {
      saveState(cwd, state);
    }
    return state;
  } catch (err) {
    logEvent(cwd, "warn", "Failed to load wai plan state", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function salvagePlan(raw: unknown): PlanResult | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const todo = Array.isArray(r.todo)
    ? r.todo.filter((v): v is string | { description: string } => {
        if (typeof v === "string") return true;
        if (!v || typeof v !== "object" || Array.isArray(v)) return false;
        return typeof (v as Record<string, unknown>).description === "string";
      })
    : [];
  const acceptanceCriteria = Array.isArray(r.acceptanceCriteria)
    ? r.acceptanceCriteria.filter((v): v is string => typeof v === "string")
    : [];
  const summary = typeof r.summary === "string" ? r.summary : "";
  if (todo.length > 0 || summary.length > 0) {
    return { todo, acceptanceCriteria, summary };
  }
  return undefined;
}

export function saveState(cwd: string, state: YoowaiSessionState): void {
  try {
    const dir = getStateDir(cwd);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      getPlanPath(cwd),
      JSON.stringify(
        {
          plan: state.plan,
          completedSteps: state.completedSteps,
          totalSteps: state.totalSteps,
          reviewRounds: state.reviewRounds,
          reviewedSteps: state.reviewedSteps,
          judgeCompleted: state.judgeCompleted === true,
          editsSinceLastReview: state.editsSinceLastReview ?? 0,
          editsSinceLastDone: state.editsSinceLastDone ?? 0,
          unreviewedTurns: state.unreviewedTurns ?? 0,
          noPlanTurns: state.noPlanTurns ?? 0,
          unreviewedEditsTotal: state.unreviewedEditsTotal ?? 0,
          unreviewedEditsFlushed: state.unreviewedEditsFlushed ?? 0,
          editedFiles: state.editedFiles ?? [],
          reviewedFiles: normalizeReviewedFiles(state.reviewedFiles),
          pendingReviewCommit: state.pendingReviewCommit,
          lastReviewedCommit: state.lastReviewedCommit,
          planStaleSuggestedRound: state.planStaleSuggestedRound,
        },
        null,
        2,
      ),
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch (err) {
    logEvent(cwd, "error", "Failed to save wai plan state", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function clearState(cwd: string): void {
  const path = getPlanPath(cwd);
  try {
    if (existsSync(path)) {
      writeFileSync(path, "{}", { encoding: "utf-8", mode: 0o600 });
    }
  } catch (err) {
    logEvent(cwd, "warn", "Failed to clear wai plan state", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
