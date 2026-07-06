import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonResponse,
  salvageReviewFromMarkdown,
  salvageJudgeFromMarkdown,
  validateReviewResult,
  validateJudgeResult,
  validateConventionsResult,
  validateTestResult,
  validateSecurityResult,
  buildPlanPrompt,
  buildAdaptiveReviewPrompt,
  buildScanPrompt,
  buildRecommendPrompt,
  buildTestPrompt,
  buildSecurityPrompt,
  clearPromptCache,
} from "./prompts.js";

describe("parseJsonResponse", () => {
  it("parses plain JSON", () => {
    const result = parseJsonResponse('{"foo": "bar"}');
    assert.deepEqual(result, { foo: "bar" });
  });

  it("parses JSON inside markdown fence", () => {
    const result = parseJsonResponse('```json\n{"foo": "bar"}\n```');
    assert.deepEqual(result, { foo: "bar" });
  });

  it("parses JSON wrapped in prose", () => {
    const result = parseJsonResponse('Here is the result:\n{"foo": "bar"}\nHope that helps!');
    assert.deepEqual(result, { foo: "bar" });
  });

  it("parses largest balanced object when nested", () => {
    const result = parseJsonResponse('prefix {"outer": {"inner": 1}} suffix');
    assert.deepEqual(result, { outer: { inner: 1 } });
  });

  it("returns null for invalid input", () => {
    const result = parseJsonResponse("not json");
    assert.equal(result, null);
  });

  it("returns null for empty input", () => {
    const result = parseJsonResponse("");
    assert.equal(result, null);
  });

  it("unwraps common wrapper objects", () => {
    const result = parseJsonResponse('{ "response": "{ \\"foo\\": \\"bar\\" }" }');
    assert.deepEqual(result, { foo: "bar" });
  });

  it("unwraps wrapper containing markdown JSON", () => {
    const result = parseJsonResponse('{ "content": "```json\\n{ \\"foo\\": \\"bar\\" }\\n```" }');
    assert.deepEqual(result, { foo: "bar" });
  });
});

describe("salvageReviewFromMarkdown", () => {
  it("extracts pass verdict and suggestions from markdown", () => {
    const text = `# Review

Verdict: pass

- Add a comment
- Move to IDEs section`;
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.verdict, "pass");
    assert.equal(result?.suggestions.length, 2);
    assert.equal(result?.consensus, false);
  });

  it("extracts blocked verdict", () => {
    const text = "This is broken and cannot work.\n\n- Fix the crash";
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.verdict, "blocked");
    assert.equal(result?.suggestions.length, 1);
  });
});

describe("salvageJudgeFromMarkdown", () => {
  it("extracts pass verdict and summary", () => {
    const text = "Verdict: pass\n\nSummary: All criteria are met.";
    const result = salvageJudgeFromMarkdown(text);
    assert.equal(result?.verdict, "pass");
    assert.equal(result?.consensus, true);
    assert.match(result?.summary ?? "", /All criteria/);
  });

  it("extracts blocked verdict with suggestions", () => {
    const text = "Verdict: blocked\n\n- Missing tests\n- Step 2 not reviewed";
    const result = salvageJudgeFromMarkdown(text);
    assert.equal(result?.verdict, "blocked");
    assert.equal(result?.suggestions.length, 2);
    assert.equal(result?.consensus, false);
  });
});

describe("validateReviewResult", () => {
  it("derives consensus only from pass with no issues", () => {
    assert.equal(
      validateReviewResult({ verdict: "pass", issues: [], suggestions: [], consensus: false })?.consensus,
      true,
    );
    assert.equal(
      validateReviewResult({
        verdict: "pass",
        issues: [{ severity: "low", issue: "x", suggestion: "y" }],
        suggestions: [],
        consensus: true,
      })?.consensus,
      false,
    );
    assert.equal(
      validateReviewResult({ verdict: "needs-work", issues: [], suggestions: [], consensus: true })?.consensus,
      false,
    );
  });

  it("strips extra properties via cast", () => {
    const result = validateReviewResult({
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: false,
      extraField: "not allowed",
    });
    assert.ok(result);
    assert.equal("extraField" in result!, false);
  });

  it("normalizes null line values to undefined", () => {
    const result = validateReviewResult({
      verdict: "needs-work",
      issues: [{ severity: "high", line: null, issue: "x", suggestion: "y" }],
      suggestions: [],
      consensus: false,
    });
    assert.ok(result);
    assert.equal(result!.issues[0]!.line, undefined);
  });

  it("normalizes string line values to undefined", () => {
    const result = validateReviewResult({
      verdict: "needs-work",
      issues: [{ severity: "medium", line: "submit method", issue: "x", suggestion: "y" }],
      suggestions: [],
      consensus: false,
    });
    assert.ok(result);
    assert.equal(result!.issues[0]!.line, undefined);
  });

  it("preserves numeric line values", () => {
    const result = validateReviewResult({
      verdict: "needs-work",
      issues: [{ severity: "low", line: 97, issue: "x", suggestion: "y" }],
      suggestions: [],
      consensus: false,
    });
    assert.ok(result);
    assert.equal(result!.issues[0]!.line, 97);
  });

  it("normalizes null file values to undefined", () => {
    const result = validateReviewResult({
      verdict: "needs-work",
      issues: [{ severity: "high", file: null, issue: "x", suggestion: "y" }],
      suggestions: [],
      consensus: false,
    });
    assert.ok(result);
    assert.equal(result!.issues[0]!.file, undefined);
  });

  it("preserves string file values", () => {
    const result = validateReviewResult({
      verdict: "needs-work",
      issues: [{ severity: "high", file: "src/app.ts", issue: "x", suggestion: "y" }],
      suggestions: [],
      consensus: false,
    });
    assert.ok(result);
    assert.equal(result!.issues[0]!.file, "src/app.ts");
  });
});

describe("validateJudgeResult", () => {
  it("normalizes non-numeric line values to undefined", () => {
    const result = validateJudgeResult({
      verdict: "needs-work",
      issues: [
        { severity: "high", line: null, issue: "x", suggestion: "y" },
        { severity: "medium", line: "submit method", issue: "x", suggestion: "y" },
      ],
      suggestions: [],
      consensus: false,
      summary: "test",
    });
    assert.ok(result);
    assert.equal(result!.issues[0]!.line, undefined);
    assert.equal(result!.issues[1]!.line, undefined);
  });

  it("preserves numeric line values", () => {
    const result = validateJudgeResult({
      verdict: "needs-work",
      issues: [{ severity: "low", line: 99, issue: "x", suggestion: "y" }],
      suggestions: [],
      consensus: false,
      summary: "test",
    });
    assert.ok(result);
    assert.equal(result!.issues[0]!.line, 99);
  });

  it("handles empty issues array", () => {
    const result = validateJudgeResult({
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
      summary: "all good",
    });
    assert.ok(result);
    assert.equal(result!.issues.length, 0);
  });
});

describe("prompt caching", () => {
  it("returns equal prompts for identical args", () => {
    const a = buildPlanPrompt("task", "conventions");
    const b = buildPlanPrompt("task", "conventions");
    assert.equal(a.system, b.system);
    assert.equal(a.user, b.user);
  });

  it("returns distinct objects so mutations do not affect the cache", () => {
    const a = buildPlanPrompt("task", "conventions");
    a.system = "mutated";
    const b = buildPlanPrompt("task", "conventions");
    assert.notEqual(a.system, b.system);
    assert.ok(b.system.includes("pair programmer"));
  });

  it("returns different prompts for different args", () => {
    const a = buildPlanPrompt("task a", "conventions");
    const b = buildPlanPrompt("task b", "conventions");
    assert.notEqual(a.user, b.user);
  });

  it("caches review prompts with file contents", () => {
    const files = [{ file: "src/a.ts", content: "const x = 1;", mode: "full" as const }];
    const a = buildAdaptiveReviewPrompt("desc", "diff", files, {});
    const b = buildAdaptiveReviewPrompt("desc", "diff", files, {});
    assert.equal(a.user, b.user);
    assert.notStrictEqual(a, b);
  });

  it("caches static scan prompts", () => {
    const a = buildScanPrompt();
    const b = buildScanPrompt();
    assert.equal(a.system, b.system);
    assert.notStrictEqual(a, b);
  });

  it("does not cache prompts larger than the size cap", () => {
    const bigConventions = "x".repeat(60_000);
    const a = buildPlanPrompt("task", bigConventions);
    a.system = "mutated";
    const b = buildPlanPrompt("task", bigConventions);
    assert.notEqual(b.system, "mutated");
  });

  it("survives non-serializable arguments by bypassing the cache", () => {
    const circular: unknown[] = [];
    circular.push(circular);
    // buildRecommendPrompt expects string[]; cast the circular array to exercise the JSON.stringify guard.
    const a = buildRecommendPrompt("situation", circular as string[]);
    assert.ok(a.user.includes("situation"));
  });

  it("evicts oldest cached entries after maxEntries", () => {
    const first = buildPlanPrompt("task-0", "conventions");
    first.system = "mutated";
    for (let i = 1; i < 60; i++) {
      buildPlanPrompt(`task-${i}`, "conventions");
    }
    const recalled = buildPlanPrompt("task-0", "conventions");
    assert.notEqual(recalled.system, "mutated");
  });

  it("clears the cache via clearPromptCache", () => {
    const a = buildPlanPrompt("task", "conventions");
    a.system = "mutated";
    clearPromptCache();
    const b = buildPlanPrompt("task", "conventions");
    assert.notEqual(b.system, "mutated");
  });
});

describe("buildTestPrompt", () => {
  it("includes diff, test output, and conventions", () => {
    const prompt = buildTestPrompt(
      "added auth",
      "diff",
      [{ file: "src/auth.ts", content: "...", mode: "full" }],
      "1 passing",
      "naming: camelCase",
    );
    assert.ok(prompt.system.includes("test coverage"));
    assert.ok(prompt.user.includes("added auth"));
    assert.ok(prompt.user.includes("diff"));
    assert.ok(prompt.user.includes("1 passing"));
    assert.ok(prompt.user.includes("naming: camelCase"));
  });
});

describe("buildSecurityPrompt", () => {
  it("includes diff, file contents, and conventions", () => {
    const prompt = buildSecurityPrompt(
      "auth changes",
      "diff",
      [{ file: "src/auth.ts", content: "...", mode: "full" }],
      "naming: camelCase",
    );
    assert.ok(prompt.system.includes("security audit"));
    assert.ok(prompt.user.includes("auth changes"));
    assert.ok(prompt.user.includes("diff"));
    assert.ok(prompt.user.includes("src/auth.ts"));
    assert.ok(prompt.user.includes("naming: camelCase"));
  });
});

describe("validateTestResult", () => {
  it("accepts a valid test result", () => {
    const result = validateTestResult({
      verdict: "needs-work",
      findings: [
        { severity: "high", file: "src/a.ts", line: 5, issue: "x", suggestion: "y", category: "missing-test" },
      ],
      missingTests: [{ file: "src/a.ts", reason: "no coverage" }],
      summary: "needs tests",
    });
    assert.ok(result);
    assert.equal(result!.verdict, "needs-work");
    assert.equal(result!.findings[0]!.line, 5);
  });

  it("normalizes null file/line/category values", () => {
    const result = validateTestResult({
      verdict: "pass",
      findings: [{ severity: "low", file: null, line: null, issue: "x", suggestion: "y", category: null }],
      missingTests: [{ file: null, reason: "general" }],
      summary: "ok",
    });
    assert.ok(result);
    assert.equal(result!.findings[0]!.file, undefined);
    assert.equal(result!.findings[0]!.line, undefined);
    assert.equal(result!.findings[0]!.category, undefined);
    assert.equal(result!.missingTests[0]!.file, undefined);
  });

  it("rejects malformed data", () => {
    const result = validateTestResult("not an object");
    assert.equal(result, null);
  });
});

describe("validateSecurityResult", () => {
  it("accepts a valid security result", () => {
    const result = validateSecurityResult({
      verdict: "needs-review",
      findings: [
        { severity: "critical", file: "src/auth.ts", line: 10, issue: "x", suggestion: "y", category: "auth" },
      ],
      summary: "audit",
    });
    assert.ok(result);
    assert.equal(result!.verdict, "needs-review");
    assert.equal(result!.findings[0]!.severity, "critical");
  });

  it("normalizes null file/line values", () => {
    const result = validateSecurityResult({
      verdict: "pass",
      findings: [{ severity: "low", file: null, line: null, issue: "x", suggestion: "y", category: "other" }],
      summary: "ok",
    });
    assert.ok(result);
    assert.equal(result!.findings[0]!.file, undefined);
    assert.equal(result!.findings[0]!.line, undefined);
  });

  it("rejects malformed data", () => {
    const result = validateSecurityResult("not an object");
    assert.equal(result, null);
  });
});

describe("validateConventionsResult", () => {
  it("preserves incoming generatedAt", () => {
    const ts = "2024-01-01T00:00:00.000Z";
    const result = validateConventionsResult({
      naming: "camelCase",
      structure: "src/",
      patterns: [],
      stack: "ts",
      entryPoints: ["src/index.ts"],
      scripts: [],
      generatedAt: ts,
    });
    assert.equal(result?.generatedAt, ts);
  });

  it("sets generatedAt when missing", () => {
    const result = validateConventionsResult({
      naming: "camelCase",
      structure: "src/",
      patterns: [],
      stack: "ts",
      entryPoints: ["src/index.ts"],
      scripts: [],
    });
    assert.ok(result);
    assert.ok(typeof result!.generatedAt === "string");
  });
});
