import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getProjectConfigPath } from "./pi-paths.js";
import { logEvent } from "./logger.js";
import type { UsageCost } from "./types.js";

interface CostLog {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  updatedAt: string;
}

function getCostPath(cwd: string): string {
  return getProjectConfigPath(cwd, "heyyoo", "cost.json");
}

function loadCost(cwd: string): CostLog {
  const path = getCostPath(cwd);
  if (!existsSync(path)) {
    return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, updatedAt: new Date().toISOString() };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as CostLog;
    return {
      calls: data.calls || 0,
      inputTokens: data.inputTokens || 0,
      outputTokens: data.outputTokens || 0,
      costUsd: data.costUsd || 0,
      updatedAt: data.updatedAt || new Date().toISOString(),
    };
  } catch (err) {
    logEvent(cwd, "warn", "Failed to load yoo cost log", { error: err instanceof Error ? err.message : String(err) });
    return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, updatedAt: new Date().toISOString() };
  }
}

function saveCost(cwd: string, log: CostLog): void {
  try {
    const dir = getProjectConfigPath(cwd, "heyyoo");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(getCostPath(cwd), JSON.stringify(log, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    logEvent(cwd, "error", "Failed to save yoo cost log", { error: err instanceof Error ? err.message : String(err) });
  }
}

export function recordCost(cwd: string, usage: UsageCost, budgetUsd?: number): UsageCost {
  const log = loadCost(cwd);
  log.calls++;
  log.inputTokens += usage.estimatedInputTokens;
  log.outputTokens += usage.estimatedOutputTokens;
  log.costUsd += usage.estimatedCostUsd;
  log.updatedAt = new Date().toISOString();
  saveCost(cwd, log);

  const result = {
    ...usage,
    sessionCostUsd: log.costUsd,
  };

  if (budgetUsd !== undefined && budgetUsd >= 0 && log.costUsd > budgetUsd) {
    throw new Error(
      `yoo cost budget exceeded: ${formatCost(log.costUsd)} / ${formatCost(budgetUsd)}. ` +
        `Increase pi-heyyoo.costBudgetUsd in settings or reset with /yoo-clear.`,
    );
  }

  return result;
}

export function getSessionCost(cwd: string): CostLog {
  return loadCost(cwd);
}

export function resetCost(cwd: string): void {
  saveCost(cwd, { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, updatedAt: new Date().toISOString() });
}

const reservedUsd = new Map<string, number>();

export function reserveCost(cwd: string, amountUsd: number): void {
  reservedUsd.set(cwd, (reservedUsd.get(cwd) ?? 0) + amountUsd);
}

export function releaseCost(cwd: string, amountUsd: number): void {
  const current = reservedUsd.get(cwd) ?? 0;
  reservedUsd.set(cwd, Math.max(0, current - amountUsd));
}

export function getReservedCost(cwd: string): number {
  return reservedUsd.get(cwd) ?? 0;
}

export function formatCost(costUsd: number): string {
  if (costUsd < 0.001) return `${(costUsd * 100).toFixed(2)}¢`;
  return `$${costUsd.toFixed(4)}`;
}
