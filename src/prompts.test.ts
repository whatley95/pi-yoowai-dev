import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonResponse,
  validateReviewResult,
  validateJudgeResult,
  validateConventionsResult,
  buildPlanPrompt,
  buildAdaptiveReviewPrompt,
  buildScanPrompt,
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
