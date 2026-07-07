import { recordCost } from "../cost-tracker.js";
import { loadHeyyooConfig } from "../config.js";
import { logEvent } from "../logger.js";
import { parseJsonResponse, getJsonParseError } from "../prompts.js";
import type { UsageCost, SecondaryModelConfig } from "../types.js";

export const STAGES = {
  plan: 3,
  review: 10,
  suggest: 3,
  recommend: 3,
  judge: 3,
  scan: 4,
  test: 7,
  security: 5,
} as const;

export function secondaryModelLabel(secondary: SecondaryModelConfig): string {
  const { provider, id, backend } = secondary;
  const label = provider && id ? `${provider}:${id}` : "secondary model";
  return backend ? `${label} (${backend})` : label;
}

export function recordCostWithBudget(cwd: string, usage: UsageCost): UsageCost {
  const config = loadHeyyooConfig(cwd);
  return recordCost(cwd, usage, config.costBudgetUsd);
}

export function mergeUsageCost(a: UsageCost, b: UsageCost): UsageCost {
  return {
    estimatedInputTokens: a.estimatedInputTokens + b.estimatedInputTokens,
    estimatedOutputTokens: a.estimatedOutputTokens + b.estimatedOutputTokens,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
    // Both sessionCostUsd values are cumulative totals; keep the latest.
    sessionCostUsd: Math.max(a.sessionCostUsd, b.sessionCostUsd),
  };
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function parseStructuredResult<T>(
  cwd: string,
  raw: string,
  options: {
    label: string;
    validate: (data: unknown) => T | null;
    validationErrors: (data: unknown) => Array<{ path: string; message: string; value: unknown }>;
    salvage?: (raw: string) => T | null;
    salvageDetails?: (value: T) => Record<string, unknown>;
  },
): T | null {
  const parsed = parseJsonResponse(raw);
  const result = options.validate(parsed);
  if (result) return result;

  const details = {
    raw: raw.slice(0, 2000),
    parsed: parsed === null ? null : typeof parsed,
    parseError: getJsonParseError(raw),
    validationErrors: parsed ? options.validationErrors(parsed) : [],
  };
  logEvent(cwd, "debug", `${options.label} response was not valid JSON; trying markdown salvage`, details);

  const salvaged = options.salvage?.(raw) ?? null;
  if (salvaged) {
    logEvent(cwd, "info", `Salvaged ${options.label.toLowerCase()} from markdown response`, {
      ...(options.salvageDetails?.(salvaged) ?? {}),
    });
    return salvaged;
  }

  logEvent(cwd, "warn", `Failed to parse ${options.label.toLowerCase()} from secondary model response`, details);
  return null;
}
