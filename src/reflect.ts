import { getMemoryEntries } from "./review-memory.js";
import { recordLearnedFact } from "./wai-learn.js";
import { logEvent } from "./logger.js";
import type { MemoryEntry, ReviewIssue } from "./types.js";

// Mirrors ISSUE_TTL_MS in review-memory.ts — issues older than this are ignored.
const ISSUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_ISSUES_PER_FILE = 2;

export interface ReflectionTheme {
  /** Representative issue text (from the most recent occurrence). */
  issue: string;
  /** How many recorded issues map to this theme. */
  count: number;
  /** Highest severity seen for this theme. */
  severity: ReviewIssue["severity"];
  /** Suggestion from the most recent occurrence. */
  suggestion: string;
  /** True when more than one recorded issue maps to this theme. */
  recurring: boolean;
}

export interface FileReflection {
  file: string;
  /** Number of issues recorded for this file within the TTL window. */
  issueCount: number;
  themes: ReflectionTheme[];
  /** Suggested learned-fact text derived from the top recurring theme. */
  conventionSuggestion: string;
}

/** Normalize issue text into a grouping key: lowercase word stems, deduplicated
 *  and order-independent, so minor wording differences still group together. */
export function normalizeThemeKey(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return [...new Set(words)].sort().join(" ");
}

function severityRank(severity: ReviewIssue["severity"]): number {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}

function maxSeverity(a: ReviewIssue["severity"], b: ReviewIssue["severity"]): ReviewIssue["severity"] {
  return severityRank(a) >= severityRank(b) ? a : b;
}

/** Analyze recorded review issues and surface files with recurring patterns.
 *  Pure analysis of the memory store — no model calls. */
export function analyzeReviewMemory(entries: MemoryEntry[], now: number = Date.now()): FileReflection[] {
  const cutoff = new Date(now - ISSUE_TTL_MS).toISOString();
  const findings: FileReflection[] = [];

  for (const entry of entries) {
    const issues = entry.issues.filter((i) => i.timestamp >= cutoff);
    if (issues.length < MIN_ISSUES_PER_FILE) continue;

    const groups = new Map<string, { theme: ReflectionTheme; latestTimestamp: string }>();
    for (const issue of issues) {
      const key = normalizeThemeKey(issue.issue);
      const existing = groups.get(key);
      if (existing) {
        existing.theme.count++;
        existing.theme.severity = maxSeverity(existing.theme.severity, issue.severity);
        if (issue.timestamp >= existing.latestTimestamp) {
          existing.latestTimestamp = issue.timestamp;
          existing.theme.issue = issue.issue;
          existing.theme.suggestion = issue.suggestion;
        }
      } else {
        groups.set(key, {
          theme: {
            issue: issue.issue,
            count: 1,
            severity: issue.severity,
            suggestion: issue.suggestion,
            recurring: false,
          },
          latestTimestamp: issue.timestamp,
        });
      }
    }

    const themes = [...groups.values()]
      .map((g) => ({ ...g.theme, recurring: g.theme.count > 1 }))
      .sort((a, b) => b.count - a.count || severityRank(b.severity) - severityRank(a.severity));

    const top = themes[0];
    const advice = top.suggestion || top.issue;
    findings.push({
      file: entry.file,
      issueCount: issues.length,
      themes,
      conventionSuggestion: `In ${entry.file}: ${advice}`,
    });
  }

  return findings.sort((a, b) => b.issueCount - a.issueCount);
}

export function reflectOnMemory(cwd: string): FileReflection[] {
  return analyzeReviewMemory(getMemoryEntries(cwd));
}

export function formatReflectionReport(findings: FileReflection[]): string {
  if (findings.length === 0) {
    return "## wai reflect\n\nNo recurring issue patterns found in review memory (last 7 days).";
  }

  const lines: string[] = [
    "## wai reflect",
    "",
    `Recurring review issues in ${findings.length} file(s) (last 7 days).`,
    "",
  ];

  for (const finding of findings) {
    lines.push(`### ${finding.file} — ${finding.issueCount} issues`);
    for (const theme of finding.themes) {
      const marker = theme.recurring ? "🔁" : "💡";
      const count = theme.count > 1 ? ` (×${theme.count})` : "";
      lines.push(`- ${marker} **${theme.severity}** "${theme.issue}"${count}`);
      if (theme.suggestion) lines.push(`  → ${theme.suggestion}`);
    }
    lines.push(`**Suggestion:** consider adding a project convention via /wai-learn: ${finding.conventionSuggestion}`);
    lines.push("");
  }

  lines.push("Save all suggestions as learned facts with /wai-reflect --learn.");
  return lines.join("\n").trimEnd();
}

/** Persist each finding's suggestion as a learned fact (category "conventions").
 *  Returns the number of facts recorded. */
export function learnReflectionSuggestions(cwd: string, findings: FileReflection[]): number {
  for (const finding of findings) {
    recordLearnedFact(cwd, finding.conventionSuggestion, { category: "conventions", source: finding.file });
  }
  if (findings.length > 0) {
    logEvent(cwd, "info", "Recorded learned facts from wai reflect", { count: findings.length });
  }
  return findings.length;
}
