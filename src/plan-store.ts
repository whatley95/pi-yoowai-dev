import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectConfigPath } from "./pi-paths.js";
import { logEvent } from "./logger.js";
import type { HeyyooSessionState } from "./types.js";
import { validatePlanResult } from "./prompts.js";

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
    const plan =
      data.plan && typeof data.plan === "object" && !Array.isArray(data.plan)
        ? validatePlanResult(data.plan)
        : undefined;
    return {
      plan: plan || undefined,
      completedSteps: typeof data.completedSteps === "number" ? data.completedSteps : 0,
      totalSteps: typeof data.totalSteps === "number" ? data.totalSteps : 0,
      reviewRounds: typeof data.reviewRounds === "number" ? data.reviewRounds : 0,
    };
  } catch (err) {
    logEvent(cwd, "warn", "Failed to load yoo plan state", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
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
