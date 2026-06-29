import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageCost } from "./types.js";

interface CostLog {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  updatedAt: string;
}

function getCostPath(cwd: string): string {
  return join(cwd, ".pi", "heyyoo", "cost.json");
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
  } catch {
    return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, updatedAt: new Date().toISOString() };
  }
}

function saveCost(cwd: string, log: CostLog): void {
  const dir = join(cwd, ".pi", "heyyoo");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getCostPath(cwd), JSON.stringify(log, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function recordCost(cwd: string, usage: UsageCost): UsageCost {
  const log = loadCost(cwd);
  log.calls++;
  log.inputTokens += usage.estimatedInputTokens;
  log.outputTokens += usage.estimatedOutputTokens;
  log.costUsd += usage.estimatedCostUsd;
  log.updatedAt = new Date().toISOString();
  saveCost(cwd, log);

  return {
    ...usage,
    sessionCostUsd: log.costUsd,
  };
}

export function getSessionCost(cwd: string): CostLog {
  return loadCost(cwd);
}

export function resetCost(cwd: string): void {
  saveCost(cwd, { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, updatedAt: new Date().toISOString() });
}

export function formatCost(costUsd: number): string {
  if (costUsd < 0.001) return `${(costUsd * 1000).toFixed(2)}¢`;
  return `$${costUsd.toFixed(4)}`;
}
