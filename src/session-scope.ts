import { createHash } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { getProjectConfigPath } from "./pi-paths.js";
import { logEvent } from "./logger.js";

const sessionIds = new Map<string, string>();

function sanitizeSessionId(sessionId: string): string {
  // Hash the session id so it is always filesystem-safe and reasonably short.
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

export function setSessionId(cwd: string, sessionId: string): void {
  sessionIds.set(cwd, sessionId);
}

export function getSessionId(cwd: string): string | undefined {
  return sessionIds.get(cwd);
}

export function clearSessionId(cwd: string): void {
  sessionIds.delete(cwd);
}

/**
 * One-time migration of pre-rebrand runtime state from `.pi/heyyoo/` to
 * `.pi/yoowai/`. Runs on session start before any state is read/written.
 * Best-effort: failures are logged and ignored so startup is not blocked.
 */
export function migrateLegacyState(cwd: string): void {
  const legacyPath = getProjectConfigPath(cwd, "heyyoo");
  const currentPath = getProjectConfigPath(cwd, "yoowai");
  if (!existsSync(legacyPath) || existsSync(currentPath)) return;

  try {
    renameSync(legacyPath, currentPath);
    logEvent(cwd, "info", "Migrated legacy state from .pi/heyyoo to .pi/yoowai", {});
  } catch (err) {
    logEvent(cwd, "warn", "Failed to migrate legacy .pi/heyyoo state", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Returns a project config path under `.pi/yoowai/`.
 * When a session id is active, the path is scoped to that session
 * (`sessions/<hash>/...`) so plan/memory/cost do not leak across Pi sessions.
 * Falls back to the legacy project-scoped path when no session is active.
 */
export function getSessionConfigPath(cwd: string, ...segments: string[]): string {
  const sessionId = sessionIds.get(cwd);
  if (sessionId) {
    return getProjectConfigPath(cwd, "yoowai", "sessions", sanitizeSessionId(sessionId), ...segments);
  }
  return getProjectConfigPath(cwd, "yoowai", ...segments);
}

export function getSessionConfigDir(cwd: string, ...segments: string[]): string {
  return dirname(getSessionConfigPath(cwd, ...segments));
}

function getSessionsRoot(cwd: string): string {
  return getProjectConfigPath(cwd, "yoowai", "sessions");
}

interface PruneOptions {
  maxAgeDays?: number;
  maxSessions?: number;
}

/**
 * Deletes old per-session state directories so `.pi/yoowai/sessions/`
 * does not grow forever. The current session is never removed.
 */
export function pruneSessionDirs(cwd: string, currentSessionId: string, options: PruneOptions = {}): void {
  const root = getSessionsRoot(cwd);
  if (!existsSync(root)) return;

  const { maxAgeDays = 7, maxSessions = 20 } = options;
  const currentHash = sanitizeSessionId(currentSessionId);
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  const entries = readdirSync(root, { withFileTypes: true });
  const dirs: { dir: string; mtime: number }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === currentHash) continue;
    // Build the actual directory path from the entry name to avoid depending on current session id.
    const sessionDir = getProjectConfigPath(cwd, "yoowai", "sessions", entry.name);
    try {
      const mtime = statSync(sessionDir).mtimeMs;
      dirs.push({ dir: sessionDir, mtime });
      if (now - mtime > maxAgeMs) {
        rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch {
      // ignore unreadable entries
    }
  }

  // If there are still too many sessions, delete the oldest ones.
  const remaining = dirs.filter(({ dir }) => existsSync(dir));
  if (remaining.length > maxSessions) {
    remaining.sort((a, b) => a.mtime - b.mtime);
    for (const { dir } of remaining.slice(0, remaining.length - maxSessions)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore deletion failures
      }
    }
  }
}
