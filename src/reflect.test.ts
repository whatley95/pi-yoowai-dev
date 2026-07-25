import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeReviewMemory,
  formatReflectionReport,
  learnReflectionSuggestions,
  normalizeThemeKey,
  reflectOnMemory,
} from "./reflect.js";
import { recordIssues } from "./review-memory.js";
import { findLearnedFacts, clearLearnedFacts } from "./wai-learn.js";
import type { MemoryEntry } from "./types.js";

const NOW = Date.parse("2026-07-25T00:00:00Z");

function entry(file: string, issues: Array<{ issue: string; suggestion?: string; ageDays?: number }>): MemoryEntry {
  return {
    file,
    issues: issues.map((i) => ({
      severity: "medium" as const,
      issue: i.issue,
      suggestion: i.suggestion ?? "",
      timestamp: new Date(NOW - (i.ageDays ?? 0) * 24 * 60 * 60 * 1000).toISOString(),
    })),
  };
}

describe("reflect", () => {
  it("normalizes issue text into an order-independent grouping key", () => {
    assert.equal(normalizeThemeKey("Missing error handling!"), normalizeThemeKey("error handling missing"));
    assert.equal(normalizeThemeKey("Missing error handling!"), "error handling missing");
  });

  it("ignores files with fewer than two issues in the TTL window", () => {
    const findings = analyzeReviewMemory(
      [
        entry("src/a.ts", [{ issue: "one issue" }]),
        entry("src/b.ts", [
          { issue: "old 1", ageDays: 30 },
          { issue: "old 2", ageDays: 30 },
        ]),
      ],
      NOW,
    );
    assert.deepEqual(findings, []);
  });

  it("groups repeated issue text into recurring themes", () => {
    const findings = analyzeReviewMemory(
      [
        entry("src/app.ts", [
          { issue: "Missing error handling", suggestion: "wrap in try/catch", ageDays: 2 },
          { issue: "error handling missing!", suggestion: "add try/catch", ageDays: 1 },
          { issue: "Unused variable", ageDays: 1 },
        ]),
      ],
      NOW,
    );
    assert.equal(findings.length, 1);
    const finding = findings[0];
    assert.equal(finding.file, "src/app.ts");
    assert.equal(finding.issueCount, 3);
    assert.equal(finding.themes.length, 2);
    const top = finding.themes[0];
    assert.equal(top.recurring, true);
    assert.equal(top.count, 2);
    // The most recent occurrence supplies the representative text/suggestion.
    assert.equal(top.suggestion, "add try/catch");
    assert.match(finding.conventionSuggestion, /^In src\/app\.ts: add try\/catch/);
  });

  it("drops issues outside the TTL window but keeps recent ones", () => {
    const findings = analyzeReviewMemory(
      [entry("src/a.ts", [{ issue: "stale issue", ageDays: 30 }, { issue: "fresh 1" }, { issue: "fresh 2" }])],
      NOW,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].issueCount, 2);
  });

  it("formats a markdown report with per-file themes and suggestions", () => {
    const findings = analyzeReviewMemory(
      [
        entry("src/app.ts", [
          { issue: "Missing error handling", ageDays: 1 },
          { issue: "missing error handling", suggestion: "add try/catch" },
        ]),
      ],
      NOW,
    );
    const report = formatReflectionReport(findings);
    assert.match(report, /^## wai reflect/);
    assert.match(report, /### src\/app\.ts — 2 issues/);
    assert.match(report, /🔁 \*\*medium\*\* "missing error handling" \(×2\)/);
    assert.match(report, /consider adding a project convention via \/wai-learn: In src\/app\.ts: add try\/catch/);
  });

  it("formats an empty report when nothing recurs", () => {
    assert.match(formatReflectionReport([]), /No recurring issue patterns found/);
  });

  it("reads recorded issues from the memory store and learns suggestions", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wai-reflect-test-"));
    try {
      recordIssues(cwd, [
        {
          severity: "high",
          file: "src/db.ts",
          issue: "SQL built by string concat",
          suggestion: "use parameterized queries",
        },
        {
          severity: "medium",
          file: "src/db.ts",
          issue: "sql built by string concat!",
          suggestion: "use parameterized queries",
        },
      ]);
      const findings = reflectOnMemory(cwd);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].themes[0].count, 2);
      assert.equal(findings[0].themes[0].severity, "high");

      clearLearnedFacts(cwd);
      const count = learnReflectionSuggestions(cwd, findings);
      assert.equal(count, 1);
      const facts = findLearnedFacts(cwd);
      assert.equal(facts.length, 1);
      assert.equal(facts[0].category, "conventions");
      assert.equal(facts[0].source, "src/db.ts");
      assert.match(facts[0].fact, /use parameterized queries/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
