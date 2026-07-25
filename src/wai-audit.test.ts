import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatAuditReport, type AuditSection } from "./wai-audit.js";
import type { WaiToolResult } from "./types.js";

function reviewResult(): WaiToolResult {
  return {
    action: "review",
    review: {
      verdict: "needs-work",
      consensus: false,
      issues: [{ severity: "high", file: "src/app.ts", line: 3, issue: "missing null check", suggestion: "guard it" }],
      suggestions: [],
    },
  };
}

function securityResult(): WaiToolResult {
  return {
    action: "security",
    security: { verdict: "pass", findings: [], summary: "No issues." },
  };
}

describe("wai-audit", () => {
  it("renders each section's markdown in one combined report", () => {
    const sections: AuditSection[] = [
      { name: "review", result: reviewResult() },
      { name: "security", result: securityResult() },
      {
        name: "test",
        result: { action: "test", test: { verdict: "pass", findings: [], missingTests: [], summary: "ok" } },
      },
    ];
    const report = formatAuditReport(sections);
    assert.match(report, /^## wai audit — review \+ security \+ test/);
    assert.match(report, /## wai review ⚠ needs-work/);
    assert.match(report, /missing null check/);
    assert.match(report, /## wai security ✓ pass/);
    assert.match(report, /## wai test ✓ pass/);
  });

  it("renders a thrown executor as an error section and keeps the others", () => {
    const sections: AuditSection[] = [
      { name: "review", error: "diff exploded" },
      { name: "security", result: securityResult() },
      { name: "test", result: { action: "test", error: "no model configured" } },
    ];
    const report = formatAuditReport(sections);
    assert.match(report, /## wai review ✗ failed/);
    assert.match(report, /wai error: diff exploded/);
    assert.match(report, /## wai security ✓ pass/);
    assert.match(report, /## wai test ✗ failed/);
    assert.match(report, /wai error: no model configured/);
  });

  it("includes total cost and elapsed time in the meta line", () => {
    const withCost: WaiToolResult = {
      ...securityResult(),
      cost: { estimatedInputTokens: 100, estimatedOutputTokens: 50, estimatedCostUsd: 0.01, sessionCostUsd: 0.01 },
    };
    const report = formatAuditReport([{ name: "security", result: withCost }], 1500);
    assert.match(report, /_\$0\.0100 · took 1\.5s_/);
  });
});
