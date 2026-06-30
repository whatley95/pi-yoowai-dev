import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getProjectConfigPath } from "./pi-paths.js";
import { logEvent } from "./logger.js";
import type { ReviewIssue } from "./types.js";

interface MemoryStore {
  files: Record<string, FileMemory>;
  updatedAt: string;
}

interface FileMemory {
  file: string;
  issues: Array<{ severity: ReviewIssue["severity"]; issue: string; suggestion: string; timestamp: string }>;
}

function getMemoryPath(cwd: string): string {
  return getProjectConfigPath(cwd, "heyyoo", "memory.json");
}

function loadMemory(cwd: string): MemoryStore {
  const path = getMemoryPath(cwd);
  if (!existsSync(path)) {
    return { files: {}, updatedAt: new Date().toISOString() };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as MemoryStore;
    return { files: data.files || {}, updatedAt: data.updatedAt || new Date().toISOString() };
  } catch (err) {
    logEvent(cwd, "warn", "Failed to load yoo review memory", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { files: {}, updatedAt: new Date().toISOString() };
  }
}

function saveMemory(cwd: string, memory: MemoryStore): void {
  try {
    const dir = getProjectConfigPath(cwd, "heyyoo");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    memory.updatedAt = new Date().toISOString();
    writeFileSync(getMemoryPath(cwd), JSON.stringify(memory, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    logEvent(cwd, "error", "Failed to save yoo review memory", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function recordIssues(cwd: string, issues: ReviewIssue[]): void {
  if (issues.length === 0) return;
  const memory = loadMemory(cwd);
  const now = new Date().toISOString();

  for (const issue of issues) {
    if (!issue.file) continue;
    const file = normalizeFile(issue.file);
    if (!memory.files[file]) {
      memory.files[file] = { file, issues: [] };
    }
    memory.files[file].issues.push({
      severity: issue.severity,
      issue: issue.issue,
      suggestion: issue.suggestion,
      timestamp: now,
    });
    // keep only last 20 issues per file
    if (memory.files[file].issues.length > 20) {
      memory.files[file].issues = memory.files[file].issues.slice(-20);
    }
  }

  saveMemory(cwd, memory);
}

export function getPastIssuesForFiles(cwd: string, files: string[]): string {
  const memory = loadMemory(cwd);
  const found: string[] = [];
  for (const file of files) {
    const normalized = normalizeFile(file);
    const entry = memory.files[normalized];
    if (entry && entry.issues.length > 0) {
      const latest = entry.issues.slice(-3);
      found.push(`\n${file}:`);
      for (const i of latest) {
        found.push(`  - [${i.severity}] ${i.issue}`);
      }
    }
  }
  if (found.length === 0) return "";
  return "Past issues found in changed files:\n" + found.join("\n");
}

function normalizeFile(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

export function clearMemory(cwd: string): void {
  try {
    saveMemory(cwd, { files: {}, updatedAt: new Date().toISOString() });
  } catch (err) {
    logEvent(cwd, "warn", "Failed to clear yoo review memory", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
