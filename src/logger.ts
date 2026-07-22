import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { getProjectConfigPath } from "./pi-paths.js";

const MAX_LOG_SIZE_BYTES = 1024 * 1024; // 1 MiB
const MAX_LOG_LINES = 1000;

function getLogPath(cwd: string): string {
  return getProjectConfigPath(cwd, "yoowai", "wai.log");
}

function ensureLogDir(cwd: string): void {
  const dir = getProjectConfigPath(cwd, "yoowai");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function rotateIfNeeded(path: string): void {
  if (!existsSync(path)) return;
  try {
    const stats = statSync(path);
    if (stats.size > MAX_LOG_SIZE_BYTES) {
      const content = readFileSync(path, "utf-8");
      const lines = content.split("\n");
      const trimmed = lines.slice(-MAX_LOG_LINES).join("\n");
      writeFileSync(path, trimmed, { encoding: "utf-8", mode: 0o600 });
    }
  } catch {
    /* ignore rotation errors */
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export function logEvent(cwd: string, level: LogLevel, message: string, details?: Record<string, unknown>): void {
  try {
    ensureLogDir(cwd);
    const path = getLogPath(cwd);
    rotateIfNeeded(path);
    const timestamp = new Date().toISOString();
    const detailsText = details && Object.keys(details).length > 0 ? ` | ${JSON.stringify(details)}` : "";
    const entry = `[${timestamp}] [${level.toUpperCase()}] ${message}${detailsText}\n`;
    appendFileSync(path, entry, { encoding: "utf-8", mode: 0o600 });
  } catch {
    /* logging should never crash the tool */
  }
}

export function clearLogs(cwd: string): void {
  try {
    const path = getLogPath(cwd);
    if (existsSync(path)) {
      writeFileSync(path, "", "utf-8");
    }
  } catch {
    /* ignore */
  }
}

export function readRecentLogs(cwd: string, limit = 100): string[] {
  const path = getLogPath(cwd);
  if (!existsSync(path)) return [];
  try {
    const content = readFileSync(path, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}
