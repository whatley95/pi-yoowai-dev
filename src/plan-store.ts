import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { getProjectConfigPath } from "./pi-paths.js";
import { logEvent } from "./logger.js";
import type { HeyyooSessionState, PlanResult } from "./types.js";
import { validatePlanResult } from "./prompts.js";
import { PlanResultSchema } from "./schemas.js";

function getStateDir(cwd: string): string {
  return getProjectConfigPath(cwd, "heyyoo");
}

function getPlanPath(cwd: string): string {
  return join(getStateDir(cwd), "plan.json");
}

export function loadState(cwd: string): HeyyooSessionState | null {
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
    return {
      plan: plan || undefined,
      completedSteps: typeof data.completedSteps === "number" ? data.completedSteps : 0,
      totalSteps: typeof data.totalSteps === "number" ? data.totalSteps : 0,
      reviewRounds: typeof data.reviewRounds === "number" ? data.reviewRounds : 0,
      reviewedSteps,
    };
  } catch (err) {
    logEvent(cwd, "warn", "Failed to load yoo plan state", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function salvagePlan(raw: unknown): PlanResult | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const todo = Array.isArray(r.todo) ? r.todo.filter((v): v is string => typeof v === "string") : [];
  const acceptanceCriteria = Array.isArray(r.acceptanceCriteria)
    ? r.acceptanceCriteria.filter((v): v is string => typeof v === "string")
    : [];
  const summary = typeof r.summary === "string" ? r.summary : "";
  if (todo.length > 0 || summary.length > 0) {
    return { todo, acceptanceCriteria, summary };
  }
  return undefined;
}

export function saveState(cwd: string, state: HeyyooSessionState): void {
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
        },
        null,
        2,
      ),
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch (err) {
    logEvent(cwd, "error", "Failed to save yoo plan state", {
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
    logEvent(cwd, "warn", "Failed to clear yoo plan state", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
