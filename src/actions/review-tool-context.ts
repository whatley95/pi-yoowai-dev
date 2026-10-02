import { statSync } from "node:fs";
import { resolveProjectPath, normalizeReviewPath } from "../path-security.js";
import { estimateTokens, type ReviewBudget } from "../token-budget.js";
import type { FileContentEntry } from "../file-loader.js";
import type { CallSecondaryModelOptions } from "../types.js";

const MAX_ADAPTIVE_REQUESTS = 20;
const MAX_READ_PAGE_CHARS = 16_000;
const TOOL_INSTRUCTION_TOKENS = 1200;

/** Reserve capacity for missing context only. Complete supplied files and
 * the captured diff cost no tool requests. An explicit numeric cap wins. */
export function resolveReviewToolContext(input: {
  cwd: string;
  paths: string[];
  files: FileContentEntry[];
  budget: ReviewBudget;
  system: string;
  user: string;
  evidenceTokens: number;
  maxRequests?: number;
  adaptive?: boolean;
}): Pick<CallSecondaryModelOptions, "maxToolIterations" | "readPageChars" | "maxToolContextChars" | "maxInputTokens"> {
  const maxInputTokens = Math.max(
    0,
    input.budget.contextWindow - input.budget.reservedOutputTokens - input.budget.safetyMarginTokens,
  );
  const windowHeadroom = maxInputTokens - estimateTokens(input.system + input.user) - TOOL_INSTRUCTION_TOKENS;
  const evidenceHeadroom =
    Math.min(input.budget.availableInputTokens, input.budget.hardInputCap ?? Infinity) -
    input.evidenceTokens -
    TOOL_INSTRUCTION_TOKENS;
  const maxToolContextChars = Math.max(0, Math.floor(Math.min(windowHeadroom, evidenceHeadroom) * 4));
  const readPageChars = Math.min(MAX_READ_PAGE_CHARS, Math.max(512, maxToolContextChars));
  const base = input.maxRequests ?? 5;
  let maxToolIterations = base;
  if (input.adaptive && base > 0 && maxToolContextChars > 0) {
    const supplied = new Set(input.files.filter((f) => f.mode === "full").map((f) => normalizeReviewPath(f.file)));
    let missingBytes = 0;
    for (const path of new Set(input.paths.map(normalizeReviewPath))) {
      if (supplied.has(path)) continue;
      const safePath = resolveProjectPath(input.cwd, path);
      if (!safePath) continue;
      try {
        const stat = statSync(safePath);
        if (stat.isFile()) missingBytes += Math.min(stat.size, maxToolContextChars);
      } catch {
        // Missing/deleted/blocked files are assessed from the captured diff;
        // the model must report a gap only when their context is necessary.
      }
    }
    if (missingBytes > 0)
      maxToolIterations = Math.min(
        MAX_ADAPTIVE_REQUESTS,
        Math.max(base, Math.ceil(Math.min(missingBytes, maxToolContextChars) / readPageChars) + 2),
      );
  }
  return { maxToolIterations, readPageChars, maxToolContextChars, maxInputTokens };
}
