import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonResponse,
  salvageReviewFromMarkdown,
  salvageJudgeFromMarkdown,
  salvagePlanFromMarkdown,
  salvageSuggestFromMarkdown,
  salvageRecommendFromMarkdown,
  salvageTestFromMarkdown,
  salvageSecurityFromMarkdown,
  validateReviewResult,
  validateJudgeResult,
  validateConventionsResult,
  validateTestResult,
  validateSecurityResult,
  buildPlanPrompt,
  buildAdaptiveReviewPrompt,
  buildSuggestPrompt,
  buildScanPrompt,
  buildRecommendPrompt,
  buildTestPrompt,
  buildSecurityPrompt,
  buildJudgePrompt,
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

  it("parses the explicit markdown result JSON block", () => {
    const result = parseJsonResponse(`# Analysis
This is the reasoning.

## Result
\`\`\`json
{"foo": "bar"}
\`\`\``);
    assert.deepEqual(result, { foo: "bar" });
  });

  it("prefers the explicit result block over earlier valid JSON examples", () => {
    const result = parseJsonResponse(`Example:
\`\`\`json
{"foo": "example"}
\`\`\`

## Result
\`\`\`json
{"foo": "actual"}
\`\`\``);
    assert.deepEqual(result, { foo: "actual" });
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

describe("salvagePlanFromMarkdown", () => {
  it("extracts todo list and summary from markdown", () => {
    const text = `# Plan

Investigate and restore the build script.

1. Check existing scripts
2. Verify angular.json config
3. Add or restore build:hw

Acceptance criteria:
- build:hw runs successfully
- hw config exists`;
    const result = salvagePlanFromMarkdown(text, "fallback");
    assert.equal(result?.summary, "Plan");
    assert.equal(result?.todo.length, 3);
    assert.equal(result?.acceptanceCriteria.length, 2);
  });

  it("falls back to task when no list found", () => {
    const result = salvagePlanFromMarkdown("Just do the thing.", "fallback task");
    assert.equal(result?.todo.length, 1);
    assert.equal(result?.todo[0], "fallback task");
  });
});

describe("salvageSuggestFromMarkdown", () => {
  it("extracts approaches from headings", () => {
    const text = `## Option A
Use Provider A for speed.
- Pro: fast
- Con: expensive

## Option B
Use Provider B for cost.
- Pro: cheap`;
    const result = salvageSuggestFromMarkdown(text);
    assert.equal(result?.approaches.length, 2);
    assert.equal(result?.approaches[0].title, "Option A");
    assert.ok(result?.approaches[0].cons.length > 0);
  });

  it("falls back to single approach when no headings", () => {
    const result = salvageSuggestFromMarkdown("Try this.\n- It is simple\n- It is fast");
    assert.equal(result?.approaches.length, 1);
    assert.equal(result?.approaches[0].title, "Suggested approach");
    assert.equal(result?.approaches[0].pros.length, 2);
  });
});

describe("additional markdown salvage", () => {
  it("extracts a recommendation from markdown", () => {
    const result = salvageRecommendFromMarkdown(`## Next Step
Ship the parser change.

## Reasoning
It keeps the existing contract.

## Alternatives
- Make markdown primary
- Disable thinking`);
    assert.equal(result?.nextStep, "Ship the parser change.");
    assert.match(result?.reasoning ?? "", /contract/);
    assert.equal(result?.alternatives.length, 2);
  });

  it("extracts test findings from markdown", () => {
    const result = salvageTestFromMarkdown(`Verdict: needs-work

- Missing regression test for empty input

Missing tests:
- Add parser empty-input coverage`);
    assert.equal(result?.verdict, "needs-work");
    assert.ok(result!.findings.length > 0);
    assert.equal(result?.missingTests.length, 1);
  });

  it("extracts security findings from markdown", () => {
    const result = salvageSecurityFromMarkdown(`Verdict: needs-review

- Possible auth bypass in route guard`);
    assert.equal(result?.verdict, "needs-review");
    assert.equal(result?.findings[0]?.category, "auth");
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

  it("asks structured tools for markdown ending with fenced JSON", () => {
    const prompt = buildPlanPrompt("task", "conventions");
    assert.ok(prompt.system.includes("You may write brief Markdown analysis first."));
    assert.ok(prompt.system.includes("## Result"));
    assert.ok(prompt.system.includes("```json"));
    assert.ok(prompt.system.includes("Do not include any text after the closing JSON fence."));
  });

  it("uses parseable JSON examples in structured prompt fences", () => {
    const prompts = [
      buildPlanPrompt("task", "conventions"),
      buildAdaptiveReviewPrompt("desc", "diff", [], {}),
      buildScanPrompt(),
      buildSuggestPrompt("question", "conventions"),
      buildRecommendPrompt("situation", [], "conventions"),
      buildTestPrompt("desc", "diff", [], "tests ok", "conventions"),
      buildSecurityPrompt("desc", "diff", [], "conventions"),
      buildJudgePrompt("desc", [], [], "history", "conventions"),
    ];

    for (const prompt of prompts) {
      const fences = [...prompt.system.matchAll(/```json\s*([\s\S]*?)```/g)];
      assert.ok(fences.length > 0);
      for (const fence of fences) {
        assert.doesNotThrow(() => JSON.parse(fence[1].trim()));
      }
    }
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
