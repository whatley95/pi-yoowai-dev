import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getSessionConfigDir, getSessionConfigPath } from "./session-scope.js";
import { logEvent } from "./logger.js";
import type { ReviewIssue } from "./types.js";

const MAX_ISSUES_PER_FILE = 20;
const ISSUE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_FILES = 100;
const SEMANTIC_TOP_K = 10;

interface MemoryStore {
  files: Record<string, FileMemory>;
  updatedAt: string;
}

interface FileMemory {
  file: string;
  issues: Array<{ severity: ReviewIssue["severity"]; issue: string; suggestion: string; timestamp: string }>;
}

function getMemoryPath(cwd: string): string {
  return getSessionConfigPath(cwd, "memory.json");
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
    logEvent(cwd, "warn", "Failed to load wai review memory", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { files: {}, updatedAt: new Date().toISOString() };
  }
}

function saveMemory(cwd: string, memory: MemoryStore): void {
  try {
    const dir = getSessionConfigDir(cwd, "memory.json");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    memory.updatedAt = new Date().toISOString();
    writeFileSync(getMemoryPath(cwd), JSON.stringify(memory, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    logEvent(cwd, "error", "Failed to save wai review memory", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function recordIssues(cwd: string, issues: ReviewIssue[]): void {
  if (issues.length === 0) return;
  const memory = loadMemory(cwd);
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - ISSUE_TTL_MS).toISOString();

  for (const issue of issues) {
    if (!issue.file) continue;
    const file = normalizeFile(issue.file);
    if (!memory.files[file]) {
      memory.files[file] = { file, issues: [] };
    }

    const normalizedIssue = normalizeIssue(issue.issue);
    const existingIndex = memory.files[file].issues.findIndex((i) => normalizeIssue(i.issue) === normalizedIssue);
    if (existingIndex >= 0) {
      memory.files[file].issues[existingIndex] = {
        severity: issue.severity,
        issue: issue.issue,
        suggestion: issue.suggestion,
        timestamp: now,
      };
    } else {
      memory.files[file].issues.push({
        severity: issue.severity,
        issue: issue.issue,
        suggestion: issue.suggestion,
        timestamp: now,
      });
    }

    // Drop expired issues and cap per-file history.
    memory.files[file].issues = memory.files[file].issues
      .filter((i) => i.timestamp >= cutoff)
      .slice(-MAX_ISSUES_PER_FILE);
  }

  // Drop files with no remaining issues and cap total files.
  for (const key of Object.keys(memory.files)) {
    if (memory.files[key].issues.length === 0) {
      delete memory.files[key];
    }
  }
  const fileEntries = Object.entries(memory.files);
  if (fileEntries.length > MAX_FILES) {
    fileEntries.sort((a, b) => {
      const latestA = a[1].issues[a[1].issues.length - 1]?.timestamp ?? "";
      const latestB = b[1].issues[b[1].issues.length - 1]?.timestamp ?? "";
      return latestA.localeCompare(latestB);
    });
    const keep = fileEntries.slice(-MAX_FILES).map(([k]) => k);
    memory.files = Object.fromEntries(keep.map((k) => [k, memory.files[k]]));
  }

  saveMemory(cwd, memory);
}

function normalizeIssue(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  for (const word of words) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

function cosineSimilarity(a: string, b: string): number {
  const vecA = tokenize(a);
  const vecB = tokenize(b);
  const keys = new Set([...vecA.keys(), ...vecB.keys()]);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const key of keys) {
    const va = vecA.get(key) ?? 0;
    const vb = vecB.get(key) ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function getPastIssuesForFiles(cwd: string, files: string[], query?: string): string {
  const memory = loadMemory(cwd);
  const candidates: Array<{ file: string; severity: string; issue: string; score: number }> = [];
  for (const file of files) {
    const normalized = normalizeFile(file);
    const entry = memory.files[normalized];
    if (entry && entry.issues.length > 0) {
      for (const i of entry.issues) {
        const score = query ? cosineSimilarity(query, `${i.issue} ${i.suggestion}`) : 0;
        candidates.push({ file, severity: i.severity, issue: i.issue, score });
      }
    }
  }

  if (candidates.length === 0) return "";

  let selected = candidates;
  if (query) {
    selected = candidates.sort((a, b) => b.score - a.score).slice(0, SEMANTIC_TOP_K);
  }

  const byFile = new Map<string, Array<{ severity: string; issue: string }>>();
  for (const c of selected) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file)!.push({ severity: c.severity, issue: c.issue });
  }

  const found: string[] = [];
  for (const [file, issues] of byFile) {
    found.push(`\n${file}:`);
    for (const i of issues) {
      found.push(`  - [${i.severity}] ${i.issue}`);
    }
  }
  return "Past issues found in changed files:\n" + found.join("\n");
}

export function getMemorySummary(cwd: string): string {
  const memory = loadMemory(cwd);
  const found: string[] = [];
  for (const entry of Object.values(memory.files)) {
    if (entry.issues.length === 0) continue;
    const latest = entry.issues.slice(-3);
    found.push(`\n${entry.file}:`);
    for (const i of latest) {
      found.push(`  - [${i.severity}] ${i.issue}`);
    }
  }
  if (found.length === 0) return "";
  return "Past issues found:\n" + found.join("\n");
}

function normalizeFile(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

export function clearMemory(cwd: string): void {
  try {
    saveMemory(cwd, { files: {}, updatedAt: new Date().toISOString() });
  } catch (err) {
    logEvent(cwd, "warn", "Failed to clear wai review memory", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
