import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getSessionConfigDir, getSessionConfigPath } from "./session-scope.js";
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
  return getSessionConfigPath(cwd, "cost.json");
}

const costCache = new Map<string, CostLog>();
// Backend calls settle immediately. Preserve that accounting through usage
// aggregation so existing action executors cannot charge the same call twice.
const recordedUsage = new WeakMap<UsageCost, string>();

export function inheritCostAccounting(merged: UsageCost, a: UsageCost, b: UsageCost): UsageCost {
  const cwd = recordedUsage.get(a);
  if (cwd && recordedUsage.get(b) === cwd) recordedUsage.set(merged, cwd);
  return merged;
}

function loadCost(cwd: string): CostLog {
  const cached = costCache.get(cwd);
  if (cached) {
    return { ...cached };
  }

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
    logEvent(cwd, "warn", "Failed to load wai cost log", { error: err instanceof Error ? err.message : String(err) });
    return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, updatedAt: new Date().toISOString() };
  }
}

function saveCost(cwd: string, log: CostLog): void {
  costCache.set(cwd, { ...log });
  try {
    const dir = getSessionConfigDir(cwd, "cost.json");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(getCostPath(cwd), JSON.stringify(log, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    logEvent(cwd, "error", "Failed to save wai cost log", { error: err instanceof Error ? err.message : String(err) });
  }
}

export function recordCost(cwd: string, usage: UsageCost, budgetUsd?: number): UsageCost {
  const log = loadCost(cwd);
  if (recordedUsage.get(usage) !== cwd) {
    log.calls++;
    log.inputTokens += usage.estimatedInputTokens;
    log.outputTokens += usage.estimatedOutputTokens;
    log.costUsd += usage.estimatedCostUsd;
    log.updatedAt = new Date().toISOString();
    saveCost(cwd, log);
    recordedUsage.set(usage, cwd);
  }

  const result = {
    ...usage,
    sessionCostUsd: log.costUsd,
  };
  recordedUsage.set(result, cwd);

  if (budgetUsd !== undefined && budgetUsd >= 0 && log.costUsd > budgetUsd) {
    throw new Error(
      `wai cost budget exceeded: ${formatCost(log.costUsd)} / ${formatCost(budgetUsd)}. ` +
        `Increase pi-yoowai.costBudgetUsd in settings or reset with /wai-clear.`,
    );
  }

  return result;
}

export function getSessionCost(cwd: string): CostLog {
  return loadCost(cwd);
}

/** A local coverage refusal makes no provider call and must not increment calls. */
export function emptyRecordedUsage(cwd: string): UsageCost {
  const usage = {
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedCostUsd: 0,
    sessionCostUsd: loadCost(cwd).costUsd,
  };
  recordedUsage.set(usage, cwd);
  return usage;
}

export function resetCost(cwd: string): void {
  reservedUsd.delete(cwd);
  reservationEpochs.delete(cwd);
  saveCost(cwd, { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, updatedAt: new Date().toISOString() });
}

const reservedUsd = new Map<string, number>();
const reservationEpochs = new Map<string, object>();

export function reserveCost(cwd: string, amountUsd: number, budgetUsd?: number): () => void {
  const projected = getSessionCost(cwd).costUsd + getReservedCost(cwd) + amountUsd;
  if (budgetUsd !== undefined && budgetUsd >= 0 && projected > budgetUsd) {
    throw new Error(
      `wai call would exceed cost budget: projected ${formatCost(projected)} / ${formatCost(budgetUsd)}. ` +
        "Increase pi-yoowai.costBudgetUsd or wait for pending calls to settle.",
    );
  }
  reservedUsd.set(cwd, (reservedUsd.get(cwd) ?? 0) + amountUsd);
  const epoch = reservationEpochs.get(cwd) ?? {};
  reservationEpochs.set(cwd, epoch);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (reservationEpochs.get(cwd) === epoch) releaseCost(cwd, amountUsd);
  };
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
