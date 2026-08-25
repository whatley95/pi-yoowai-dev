import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getProjectConfigPath } from "./pi-paths.js";
import { logEvent } from "./logger.js";
import { estimateTokens } from "./token-budget.js";

/** Actions that support per-action instruction files (`.pi/yoowai/instructions/<action>.md`).
 *  Closed set — the action name is validated against this list before it touches a path,
 *  so no user input can escape the instructions directory. */
export const INSTRUCTION_ACTIONS = [
  "plan",
  "advisor",
  "review",
  "suggest",
  "recommend",
  "judge",
  "scan",
  "test",
  "security",
  "done",
  "planUpdate",
  "explain",
  "vision",
] as const;

export type InstructionAction = (typeof INSTRUCTION_ACTIONS)[number];

/** Instruction files larger than this are rejected with a warning (mirrors
 *  the max cached prompt size so injected content cannot blow up a prompt). */
export const MAX_INSTRUCTION_FILE_BYTES = 50 * 1024;

/** Fingerprint cache: (mtimeMs, size) per (cwd, action). Re-reads only when
 *  the file changes; a missing file evicts the entry. */
const fingerprintCache = new Map<string, { mtimeMs: number; size: number; content: string }>();

export function getInstructionsDir(cwd: string): string {
  return getProjectConfigPath(cwd, "yoowai", "instructions");
}

export function getInstructionFilePath(cwd: string, action: string): string {
  return join(getInstructionsDir(cwd), `${action}.md`);
}

/**
 * Load the per-action instruction file for `action`, or "" when absent,
 * empty, too large, or unreadable. Cached by (mtimeMs, size) fingerprint so
 * repeated calls do not re-read the disk, but content changes are picked up
 * on the next call. Never throws.
 */
export function loadActionInstructions(cwd: string, action: string): string {
  if (!(INSTRUCTION_ACTIONS as readonly string[]).includes(action)) return "";
  const path = getInstructionFilePath(cwd, action);
  const cacheKey = `${cwd}\0${action}`;
  try {
    if (!existsSync(path)) {
      fingerprintCache.delete(cacheKey);
      return "";
    }
    const stats = statSync(path);
    const cached = fingerprintCache.get(cacheKey);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.content;
    if (stats.size > MAX_INSTRUCTION_FILE_BYTES) {
      fingerprintCache.delete(cacheKey);
      logEvent(cwd, "warn", "Instruction file exceeds size limit; ignoring", {
        path,
        bytes: stats.size,
        maxBytes: MAX_INSTRUCTION_FILE_BYTES,
      });
      return "";
    }
    const content = readFileSync(path, "utf-8").trim();
    fingerprintCache.set(cacheKey, { mtimeMs: stats.mtimeMs, size: stats.size, content });
    return content;
  } catch (err) {
    fingerprintCache.delete(cacheKey);
    logEvent(cwd, "warn", "Failed to load instruction file", {
      error: err instanceof Error ? err.message : String(err),
      path,
    });
    return "";
  }
}

/** Load and token-cap an action's instruction file. `maxTokens <= 0` disables
 *  injection entirely. Truncation happens on whole-line boundaries so the
 *  markdown stays parseable. */
export function capActionInstructions(cwd: string, action: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  const text = loadActionInstructions(cwd, action);
  if (!text) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  const maxChars = maxTokens * 4;
  const sliced = text.slice(0, maxChars);
  const lastNewline = sliced.lastIndexOf("\n");
  return lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced;
}

/** Test hook: clear the fingerprint cache. */
export function resetInstructionsCache(): void {
  fingerprintCache.clear();
}
