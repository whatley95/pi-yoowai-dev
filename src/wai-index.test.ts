import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConventions } from "./conventions.js";
import { recordCost } from "./cost-tracker.js";
import { logEvent } from "./logger.js";
import { saveState } from "./plan-store.js";
import { recordIssues } from "./review-memory.js";
import { executeWaiIndex, formatIndexResult, validateWaiIndexParams } from "./wai-index.js";
import { recordLearnedFact } from "./wai-learn.js";
import type { Conventions, YoowaiSessionState, ReviewIssue, UsageCost } from "./types.js";

describe("wai-index", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wai-index-test-"));

  beforeEach(() => {
    const sessionsRoot = join(cwd, ".pi", "yoowai", "sessions");
    if (existsSync(sessionsRoot)) {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("returns conventions, plan, memory, cost, and logs for topic all", () => {
    const conventions: Conventions = {
      naming: "camelCase",
      structure: "src/",
      patterns: ["*.test.ts"],
      stack: "TypeScript",
      entryPoints: ["src/index.ts"],
      scripts: ["test: npm test"],
      generatedAt: new Date().toISOString(),
    };
    saveConventions(cwd, conventions);

    const state: YoowaiSessionState = {
      completedSteps: 1,
      totalSteps: 3,
      reviewRounds: [],
      reviewedSteps: [true, false, false],
      editsSinceLastReview: 0,
      editsSinceLastDone: 0,
      plan: {
        summary: "Add yoo index",
        todo: ["Define types", "Implement function", "Add tests"],
        acceptanceCriteria: ["All tests pass"],
      },
    };
    saveState(cwd, state);

    const issues: ReviewIssue[] = [
      { severity: "medium", file: "src/index.ts", line: 10, issue: "bug", suggestion: "fix" },
    ];
    recordIssues(cwd, issues);

    const usage: UsageCost = {
      estimatedInputTokens: 100,
      estimatedOutputTokens: 50,
      estimatedCostUsd: 0.001,
      sessionCostUsd: 0.001,
    };
    recordCost(cwd, usage);

    logEvent(cwd, "info", "test event");

    const result = executeWaiIndex(cwd, { topic: "all" });

    assert.equal(result.topic, "all");
    assert.ok(result.conventions, "should include conventions");
    assert.equal(result.conventions?.stack, "TypeScript");
    assert.ok(result.plan, "should include plan");
    assert.equal(result.plan?.summary, "Add yoo index");
    assert.ok(result.memory, "should include memory");
    assert.match(result.memory!, /bug/);
    assert.ok(result.cost, "should include cost");
    assert.equal(result.cost?.calls, 1);
    assert.ok(result.logs && result.logs.length > 0, "should include logs");
  });

  it("filters by topic", () => {
    const conventions: Conventions = {
      naming: "camelCase",
      structure: "src/",
      patterns: [],
      stack: "TypeScript",
      entryPoints: [],
      scripts: [],
      generatedAt: new Date().toISOString(),
    };
    saveConventions(cwd, conventions);

    const result = executeWaiIndex(cwd, { topic: "conventions" });
    assert.equal(result.topic, "conventions");
    assert.ok(result.conventions);
    assert.equal(result.plan, undefined);
    assert.equal(result.memory, undefined);
  });

  it("filters memory by query", () => {
    const issues: ReviewIssue[] = [
      { severity: "medium", file: "src/a.ts", issue: "alpha bug", suggestion: "fix alpha" },
      { severity: "low", file: "src/b.ts", issue: "beta style", suggestion: "format beta" },
    ];
    recordIssues(cwd, issues);

    const result = executeWaiIndex(cwd, { topic: "memory", query: "alpha" });
    assert.ok(result.memory, "should include memory");
    assert.match(result.memory!, /alpha/);
    assert.ok(!result.memory!.includes("beta"), "should filter out non-matching issues");
  });

  it("validates raw params", () => {
    const params = validateWaiIndexParams({ topic: "plan", files: ["src/a.ts"], query: "foo" });
    assert.equal(params.topic, "plan");
    assert.deepEqual(params.files, ["src/a.ts"]);
    assert.equal(params.query, "foo");
  });

  it("ignores invalid topic in validator", () => {
    const params = validateWaiIndexParams({ topic: "nonsense" });
    assert.equal(params.topic, undefined);
  });

  it("formats index result as markdown", () => {
    const result = executeWaiIndex(cwd, { topic: "cost" });
    const text = formatIndexResult(result);
    assert.match(text, /# wai index/);
    assert.match(text, /## Session cost/);
  });

  it("updates and returns project index", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "demo.ts"), "export const demo = 1;", "utf-8");

    const result = executeWaiIndex(cwd, { topic: "index", update: true });
    assert.ok(result.index, "should return built index");
    assert.ok(result.indexSummary, "should include index summary");
    assert.match(result.indexSummary!, /demo/);
    assert.equal(result.indexUpdated, true);

    const text = formatIndexResult(result);
    assert.match(text, /Index updated successfully/);
  });

  it("returns learned facts", () => {
    recordLearnedFact(cwd, "Use camelCase for functions.", { category: "conventions" });

    const result = executeWaiIndex(cwd, { topic: "learned" });
    assert.ok(result.learned, "should include learned facts");
    assert.equal(result.learned?.length, 1);
    assert.match(result.learnedSummary!, /camelCase/);
  });

  it("cleans up temp dir", () => {
    rmSync(cwd, { recursive: true, force: true });
    assert.ok(true);
  });
});
