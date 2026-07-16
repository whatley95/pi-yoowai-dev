import type { ReviewIssue, ReviewResult } from "../types.js";
import { parseJsonResponse } from "./validation.js";

function markdownBullets(text: string): string[] {
  const bullets: string[] = [];
  const bulletRegex = /^[-*•]\s+(.+)$/gim;
  let match: RegExpExecArray | null;
  while ((match = bulletRegex.exec(text)) !== null) {
    const line = match[1].trim();
    if (line) bullets.push(line);
  }
  return bullets;
}

function firstMarkdownParagraph(text: string): string {
  return (
    text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/^#+\s+/gm, "").trim())
      .find((p) => p.length > 0) ?? ""
  );
}

/** Extract the body of a markdown section headed by `## Heading` / `### Heading` (case-insensitive). */
function extractSection(text: string, headingPattern: string): string {
  const re = new RegExp(`^#{2,4}\\s+(?:${headingPattern})\\s*$`, "im");
  const match = re.exec(text);
  if (!match) return "";
  const start = match.index! + match[0].length;
  const nextHeading = text.slice(start).match(/\n#{2,4}\s+/);
  const end = nextHeading ? start + nextHeading.index! : text.length;
  return text.slice(start, end).trim();
}

interface ParsedMarkdownTable {
  headers: string[];
  rows: string[][];
}

/** Parse GitHub-flavoured markdown tables (`| col | col |` rows). Returns all tables concatenated. */
function parseMarkdownTables(text: string): ParsedMarkdownTable[] {
  const tables: ParsedMarkdownTable[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\|/.test(lines[i]) && lines[i].includes("|", lines[i].indexOf("|") + 1)) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        const splitRow = (row: string): string[] =>
          row
            .replace(/^\s*\|/, "")
            .replace(/\|\s*$/, "")
            .split("|")
            .map((c) => c.trim());
        const headers = splitRow(tableLines[0]);
        // Skip the separator row (| --- | --- |).
        const dataStart = /^\s*\|?\s*[-:]+/.test(tableLines[1]) ? 2 : 1;
        const rows = tableLines.slice(dataStart).map(splitRow);
        if (headers.length > 1 && rows.length > 0) tables.push({ headers, rows });
      }
    } else {
      i++;
    }
  }
  return tables;
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Find the column index whose header best matches one of the candidates. */
function findColumn(headers: string[], candidates: string[]): number {
  const norm = headers.map(normalizeHeader);
  for (const candidate of candidates) {
    const c = normalizeHeader(candidate);
    const idx = norm.findIndex((h) => h === c || (h.length > 2 && h.includes(c)));
    if (idx >= 0) return idx;
  }
  return -1;
}

function severityFromString(value: string | undefined): "high" | "medium" | "low" {
  if (!value) return "low";
  const s = value.toLowerCase();
  if (/\bcritical\b|\bhigh\b|\berror\b|\bblock/.test(s)) return "high";
  if (/\bmedium\b|\bmoderate\b|\bwarn/.test(s)) return "medium";
  return "low";
}

function securitySeverityFromString(value: string | undefined): "critical" | "high" | "medium" | "low" {
  if (!value) return "low";
  const s = value.toLowerCase();
  if (/\bcritical\b/.test(s)) return "critical";
  if (/\bhigh\b|\berror\b/.test(s)) return "high";
  if (/\bmedium\b|\bmoderate\b|\bwarn/.test(s)) return "medium";
  return "low";
}

/** Parse a `file:line` or `file` location string into { file, line }. */
function parseFileLocation(value: string | undefined): { file?: string; line?: number } {
  if (!value) return {};
  const trimmed = value.trim().replace(/[`*]/g, "");
  const match = trimmed.match(/^(.+?)(?::(\d+))?(?::\d+)*$/);
  if (!match) return { file: trimmed };
  return { file: match[1], line: match[2] ? Number(match[2]) : undefined };
}

/**
 * Detect an explicit verdict line (`Verdict: pass`, `## Verdict: ✅ pass`,
 * `**Verdict:** needs-work`) before falling back to keyword heuristics.
 */
function detectVerdictExplicit(text: string): "pass" | "needs-work" | "blocked" | "needs-review" | null {
  const lower = text.toLowerCase();
  const verdictLine = lower.match(
    /\bverdict\b\s*[:-]?\s*[*_`]?\s*(pass|needs-work|needs review|needsreview|blocked|fail|fails|failing)/,
  );
  if (verdictLine) {
    const v = verdictLine[1];
    if (v === "pass") return "pass";
    if (v === "blocked" || v === "fail" || v === "fails" || v === "failing") return "blocked";
    if (v === "needs review" || v === "needsreview") return "needs-review";
    return "needs-work";
  }
  // Heading form: `## Verdict: ✅ pass` / `## Judgment: pass`.
  const heading = lower.match(
    /^#{1,4}\s+(?:verdict|judgment|review|result)\b[^\n]*?(pass|needs-work|needs review|needsreview|blocked)/m,
  );
  if (heading) {
    const v = heading[1];
    if (v === "pass") return "pass";
    if (v === "blocked") return "blocked";
    if (v === "needs review" || v === "needsreview") return "needs-review";
    return "needs-work";
  }
  return null;
}

/** Keyword heuristic for review/judge verdicts, guarded against false positives like "pass-through".
 *  Does NOT infer "blocked" from keywords in prose — that verdict must come from
 *  detectVerdictExplicit (an explicit `Verdict: blocked` line). Words like "broken", "blocked",
 *  or "cannot work" in descriptive prose are too easily false positives (e.g. "keeps developers
 *  from thinking their build config is broken" is a positive statement). The heuristic only
 *  infers "pass" or "needs-work".
 */
function heuristicReviewVerdict(lower: string): "pass" | "needs-work" {
  if (/\bneeds-work\b|\bneeds work\b/.test(lower)) return "needs-work";
  if (/(?:^|[^-\w])pass(?![\w-])|\bapproved\b|\blooks good\b|\blgtm\b/.test(lower)) return "pass";
  return "needs-work";
}

export function salvageReviewFromMarkdown(raw: string): ReviewResult | null {
  const text = raw.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const explicit = detectVerdictExplicit(text);
  const verdict: ReviewResult["verdict"] =
    explicit === "pass" || explicit === "needs-work" || explicit === "blocked"
      ? explicit
      : heuristicReviewVerdict(lower);

  const issues: ReviewIssue[] = [];

  // Structured issues from markdown tables (| File | Severity | Issue | ... |).
  for (const table of parseMarkdownTables(text)) {
    const fileCol = findColumn(table.headers, ["file", "path", "location", "loc"]);
    const sevCol = findColumn(table.headers, ["severity", "risk", "priority"]);
    const issueCol = findColumn(table.headers, ["issue", "problem", "finding", "description", "concern", "what"]);
    const sugCol = findColumn(table.headers, ["suggestion", "fix", "recommendation", "action", "resolution"]);
    if (issueCol < 0) continue; // not an issues table
    for (const row of table.rows) {
      const issueText = row[issueCol]?.trim();
      if (!issueText) continue;
      const loc = fileCol >= 0 ? parseFileLocation(row[fileCol]) : {};
      issues.push({
        severity: severityFromString(sevCol >= 0 ? row[sevCol] : undefined),
        file: loc.file,
        line: loc.line,
        issue: issueText,
        suggestion: sugCol >= 0 ? (row[sugCol]?.trim() ?? "") : "",
      });
    }
  }

  // Bullets under an `### Issues` / `### Findings` section → structured issues.
  const issuesSection = extractSection(text, "issues|findings");
  if (issuesSection) {
    for (const bullet of markdownBullets(issuesSection)) {
      const locMatch = bullet.match(/^[`*]?(.+?)[`*]?(?:\s*[:\-—]\s*(.+))?$/);
      issues.push({
        severity: /high|critical/i.test(bullet) ? "high" : /medium|moderate/i.test(bullet) ? "medium" : "low",
        file: locMatch?.[1]?.trim(),
        issue: locMatch?.[2]?.trim() ?? bullet,
        suggestion: "",
      });
    }
  }

  // Suggestions: bullets under a `### Suggestions` section, else any loose bullets.
  let suggestions: string[];
  const suggestionsSection = extractSection(text, "suggestions");
  if (suggestionsSection) {
    suggestions = markdownBullets(suggestionsSection);
  } else if (issues.length === 0) {
    // No structured issues and no suggestions section: fall back to loose bullets, but filter
    // out lines that describe the diff rather than recommend an action.
    // First, strip file-listing sections so their bullets are never extracted.
    const strippedText = text.replace(
      /^#{1,4}\s+(?:files(?:\s+(?:affected|changed|modified))?|affected\s+files|changed\s+files|modified\s+files)\b[^\n]*(?:\n(?!#{1,4}\s).*)*/gim,
      "",
    );
    suggestions = markdownBullets(strippedText).filter((line) => {
      // Strip leading markdown bold/italic markers before checking.
      const l = line.toLowerCase().trim().replace(/[*_`]/g, "");
      if (l.startsWith("verdict")) return false;
      // Diff descriptions: "Old:", "New:", "Before:", "After:", "Was:", "Now:", etc.
      if (/^(old|new|before|after|was|now|current|previous|changed|change|from|to)\b[:\-—]/.test(l)) return false;
      // Bare URLs or code-only lines are descriptions, not suggestions.
      if (/^`?https?:\/\//.test(l)) return false;
      // Bare file names (optionally with a parenthetical note) are file listings, not suggestions.
      if (/^[\w/.-]+\.[a-z]{2,}(?:\s*\([^)]*\))?$/.test(l)) return false;
      return true;
    });
  } else {
    suggestions = [];
  }

  return {
    verdict,
    issues: issues.slice(0, 20),
    suggestions: suggestions.slice(0, 10),
    consensus: verdict === "pass" && issues.length === 0 && suggestions.length === 0,
  };
}

export function salvageJudgeFromMarkdown(raw: string): import("../types.js").JudgeResult | null {
  const text = raw.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const explicit = detectVerdictExplicit(text);
  const verdict: import("../types.js").JudgeResult["verdict"] =
    explicit === "pass" || explicit === "needs-work" || explicit === "blocked"
      ? explicit
      : heuristicReviewVerdict(lower);

  // Reuse the review salvage for issues/suggestions structure.
  const reviewParts = salvageReviewFromMarkdown(raw);
  const issues = reviewParts?.issues ?? [];
  const suggestions = reviewParts?.suggestions ?? [];

  const summaryMatch = text.match(/(?:summary|assessment|overall)[\s:]*(.+?)(?=\n\n|$)/is);
  const summary = summaryMatch?.[1].trim() || firstMarkdownParagraph(text).slice(0, 1000) || text.slice(0, 300).trim();

  return {
    verdict,
    issues,
    suggestions: suggestions.slice(0, 10),
    consensus: verdict === "pass" && issues.length === 0 && suggestions.length === 0,
    summary,
  };
}

export function salvageSuggestFromMarkdown(raw: string): import("../types.js").SuggestResult | null {
  const text = raw.trim();
  if (!text) return null;

  const approaches: import("../types.js").Approach[] = [];
  const headingRegex = /^#{2,3}\s+(.+)$/gm;
  const headings: Array<{ title: string; index: number; len: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(text)) !== null) {
    headings.push({ title: match[1].trim(), index: match.index, len: match[0].length });
  }

  if (headings.length > 0) {
    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].index + headings[i].len;
      const end = i < headings.length - 1 ? headings[i + 1].index : text.length;
      const section = text.slice(start, end).trim();
      const paragraphs = section.split(/\n\s*\n/).map((p) => p.trim());
      const description = paragraphs[0] ?? "";

      const pros: string[] = [];
      const cons: string[] = [];
      const bulletRegex = /^[-*]\s+(.+)$/gm;
      let bullet: RegExpExecArray | null;
      while ((bullet = bulletRegex.exec(section)) !== null) {
        const line = bullet[1].trim();
        if (isCon(line)) {
          cons.push(line);
        } else {
          pros.push(line);
        }
      }

      approaches.push({
        title: headings[i].title,
        description,
        pros: pros.slice(0, 5),
        cons: cons.slice(0, 5),
      });
    }
  } else {
    const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim());
    const description = paragraphs[0] ?? text.slice(0, 300);
    const bullets: string[] = [];
    const bulletRegex = /^[-*]\s+(.+)$/gm;
    let bullet: RegExpExecArray | null;
    while ((bullet = bulletRegex.exec(text)) !== null) {
      bullets.push(bullet[1].trim());
    }
    approaches.push({
      title: "Suggested approach",
      description,
      pros: bullets.slice(0, 5),
      cons: [],
    });
  }

  if (approaches.length === 0) return null;
  return { approaches };
}

function isCon(line: string): boolean {
  const lower = line.toLowerCase().trim();
  if (lower.startsWith("downside") || lower.startsWith("disadvantage") || lower.startsWith("contra")) {
    return true;
  }
  // Match the bare word "con"/"cons" or a "con:"/"cons:" label, but require a
  // word boundary so prefixes like "configurable"/"consistent"/"convenient"
  // (which are pros, not cons) are not misclassified.
  return /^(con|cons)\b/i.test(lower);
}

export function salvageRecommendFromMarkdown(raw: string): import("../types.js").RecommendResult | null {
  const text = raw.trim();
  if (!text) return null;

  const bullets = markdownBullets(text);
  const nextStepMatch = text.match(/(?:next\s*step|recommend(?:ation)?)[\s:]*\n?(.+?)(?=\n\n|$)/is);
  const reasoningMatch = text.match(/(?:reasoning|why)[\s:]*\n?(.+?)(?=\n\n|$)/is);
  const alternativesMatch = text.match(/(?:alternatives?|other options?)[\s:]*\n+([\s\S]*?)(?=\n#+\s|\n\n##|$)/i);
  const nextStep = nextStepMatch?.[1].replace(/^[-*•]\s+/, "").trim() || bullets[0] || firstMarkdownParagraph(text);
  const reasoning = reasoningMatch?.[1].trim() || firstMarkdownParagraph(text) || nextStep;
  const alternatives = alternativesMatch ? markdownBullets(alternativesMatch[1]) : bullets.slice(1, 3);

  if (!nextStep) return null;
  return {
    nextStep: nextStep.slice(0, 500),
    reasoning: reasoning.slice(0, 1000),
    alternatives: alternatives.slice(0, 3),
  };
}

export function salvageTestFromMarkdown(raw: string): import("../types.js").TestResult | null {
  const text = raw.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const explicit = detectVerdictExplicit(text);
  let verdict: import("../types.js").TestResult["verdict"] = "needs-work";
  if (explicit === "blocked" || explicit === "needs-work" || explicit === "pass") {
    verdict = explicit;
  } else if (/\bblocked\b|\bfailing\b|\bfails\b|\bcannot merge\b/.test(lower)) {
    verdict = "blocked";
  } else if (
    /(?:^|[^-\w])pass\b|\badequate\b|\bcovered\b/.test(lower) &&
    !/\bneeds-work\b|\bmissing\b|\bfailing\b/.test(lower)
  ) {
    verdict = "pass";
  }

  const findings: import("../types.js").TestFinding[] = [];

  // Findings from markdown tables.
  for (const table of parseMarkdownTables(text)) {
    const fileCol = findColumn(table.headers, ["file", "path", "location"]);
    const sevCol = findColumn(table.headers, ["severity", "priority"]);
    const issueCol = findColumn(table.headers, ["finding", "issue", "problem", "description"]);
    const catCol = findColumn(table.headers, ["category", "type"]);
    const sugCol = findColumn(table.headers, ["suggestion", "fix", "action"]);
    if (issueCol < 0) continue;
    for (const row of table.rows) {
      const issueText = row[issueCol]?.trim();
      if (!issueText) continue;
      const loc = fileCol >= 0 ? parseFileLocation(row[fileCol]) : {};
      findings.push({
        severity: severityFromString(sevCol >= 0 ? row[sevCol] : undefined),
        file: loc.file,
        line: loc.line,
        issue: issueText,
        suggestion: sugCol >= 0 ? (row[sugCol]?.trim() ?? "") : "Address this test finding.",
        category: catCol >= 0 ? (row[catCol]?.trim() ?? undefined) : undefined,
      });
    }
  }

  const missingSection = text.match(/(?:missing\s*tests?)[\s:]*\n+([\s\S]*?)(?=\n#+\s|\n\n##|$)/i);
  const missingTests = (missingSection ? markdownBullets(missingSection[1]) : []).map((reason) => ({ reason }));

  // Bullets under a `### Findings` section (not already in a table).
  if (findings.length === 0) {
    const findingsSection = extractSection(text, "findings|issues");
    const bullets = markdownBullets(findingsSection || text).filter((b) => !missingTests.some((m) => m.reason === b));
    for (const issue of bullets.slice(0, 10)) {
      findings.push({
        severity: verdict === "blocked" ? "high" : "medium",
        issue,
        suggestion: "Address this test finding.",
        category: lower.includes("failing") || lower.includes("fails") ? "failing-test" : "test-quality",
      });
    }
  }

  return {
    verdict,
    findings: findings.slice(0, 20),
    missingTests: missingTests.slice(0, 10),
    summary: firstMarkdownParagraph(text).slice(0, 1000) || text.slice(0, 300),
  };
}

export function salvageSecurityFromMarkdown(raw: string): import("../types.js").SecurityResult | null {
  const text = raw.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const explicit = detectVerdictExplicit(text);
  const hasSeriousFinding = /\bcritical\b|\bhigh\b|\bvulnerab|\binjection\b|\bsecret\b|\bauth\b/.test(lower);
  let verdict: import("../types.js").SecurityResult["verdict"];
  if (explicit === "pass") {
    verdict = hasSeriousFinding ? "needs-review" : "pass";
  } else if (explicit === "needs-review" || explicit === "needs-work") {
    verdict = "needs-review";
  } else {
    verdict =
      /(?:^|[^-\w])pass\b|\bno findings\b|\bno security issues\b/.test(lower) && !hasSeriousFinding
        ? "pass"
        : "needs-review";
  }

  const findings: import("../types.js").SecurityFinding[] = [];

  // Findings from markdown tables.
  for (const table of parseMarkdownTables(text)) {
    const fileCol = findColumn(table.headers, ["file", "path", "location"]);
    const sevCol = findColumn(table.headers, ["severity", "risk", "priority"]);
    const issueCol = findColumn(table.headers, ["finding", "issue", "problem", "description", "concern"]);
    const catCol = findColumn(table.headers, ["category", "type"]);
    const sugCol = findColumn(table.headers, ["suggestion", "fix", "remediation", "action"]);
    if (issueCol < 0) continue;
    for (const row of table.rows) {
      const issueText = row[issueCol]?.trim();
      if (!issueText) continue;
      const loc = fileCol >= 0 ? parseFileLocation(row[fileCol]) : {};
      const category = catCol >= 0 ? row[catCol]?.trim() || "other" : "other";
      findings.push({
        severity: securitySeverityFromString(sevCol >= 0 ? row[sevCol] : undefined),
        file: loc.file,
        line: loc.line,
        issue: issueText,
        suggestion:
          sugCol >= 0
            ? (row[sugCol]?.trim() ?? "Review and remediate this security finding.")
            : "Review and remediate this security finding.",
        category,
      });
    }
  }

  // Fall back to bullets when no tables were found.
  if (findings.length === 0) {
    for (const issue of markdownBullets(text).slice(0, 10)) {
      findings.push({
        severity: /critical/i.test(issue) ? "critical" : hasSeriousFinding ? "medium" : "low",
        issue,
        suggestion: "Review and remediate this security finding.",
        category: lower.includes("secret")
          ? "secrets"
          : lower.includes("injection")
            ? "injection"
            : lower.includes("auth")
              ? "auth"
              : "other",
      });
    }
  }

  return {
    verdict,
    findings: findings.slice(0, 20),
    summary: firstMarkdownParagraph(text).slice(0, 1000) || text.slice(0, 300),
  };
}

export function salvagePlanFromMarkdown(raw: string, fallbackTask: string): import("../types.js").PlanResult | null {
  const text = raw.trim();
  if (!text) return null;

  // Summary: first H1/H2 heading or first non-empty paragraph.
  const headingMatch = text.match(/^#+\s+(.+)$/m);
  const firstPara = text.split(/\n\s*\n/)[0]?.trim() ?? "";
  const summary = headingMatch?.[1].trim() || firstPara.slice(0, 200);

  // Todo: numbered lists (1. ...) or bullets (- / *).
  const todos: Array<string | { description: string }> = [];
  const numberedRegex = /^\d+\.\s+(.+)$/gm;
  const bulletRegex = /^[-*]\s+(?:\[.\]\s+)?(.+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = numberedRegex.exec(text)) !== null) {
    const line = match[1].trim();
    if (line && !line.toLowerCase().startsWith("option ")) {
      todos.push(line);
    }
  }
  if (todos.length === 0) {
    while ((match = bulletRegex.exec(text)) !== null) {
      const line = match[1].trim();
      if (line && line.length > 5 && !line.toLowerCase().startsWith("option ")) {
        todos.push(line);
      }
    }
  }

  // Acceptance criteria: section after "Acceptance" heading.
  const criteria: string[] = [];
  const acSectionMatch = text.match(/(?:acceptance\s*(?:criteria)?)[\s:]*\n+([\s\S]*?)(?=\n#+\s|\n\n##|$)/i);
  if (acSectionMatch) {
    const acText = acSectionMatch[1];
    const acBulletRegex = /^[-*]\s+(.+)$/gm;
    while ((match = acBulletRegex.exec(acText)) !== null) {
      const line = match[1].trim();
      if (line) criteria.push(line);
    }
  }

  if (todos.length === 0 && summary.length < 10) {
    return null;
  }

  if (todos.length === 0) {
    todos.push(fallbackTask);
  }

  return {
    summary,
    todo: todos.slice(0, 10),
    acceptanceCriteria: criteria.slice(0, 5),
  };
}

export function parseStepVerificationResponse(raw: string): { satisfied: boolean; reason: string } | null {
  const cleaned = raw.replace(/^\uFEFF/, "").trim();
  const parsed = parseJsonResponse<{ satisfied?: unknown; reason?: unknown }>(cleaned);
  if (!parsed) return null;
  const satisfied = typeof parsed.satisfied === "boolean" ? parsed.satisfied : false;
  const reason = typeof parsed.reason === "string" ? parsed.reason : "";
  return { satisfied, reason };
}
