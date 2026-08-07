import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEW_NO_MODEL_ERROR, executeWaiReview, planAdvanceFromReview } from "./review.js";
import { mergeReviewResults, dedupeIssues } from "./review-helpers.js";
import { resolveReviewTaskModel } from "../config.js";
import { resolveReviewSettings } from "../review-level.js";
import { getAgentDir, setAgentDirForTests } from "../pi-paths.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewResult, ReviewIssue, YoowaiConfig } from "../types.js";

/** A valid ReviewResult with optional overrides (constructed directly, so
 *  consensus does NOT get re-derived like validateReviewResult would). */
function review(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    verdict: "pass",
    issues: [],
    suggestions: [],
    consensus: true,
    ...overrides,
  };
}

describe("executeWaiReview generic-path model resolution (cost-budget probe)", () => {
  const tmpDirs: string[] = [];
  const originalAgentDir = getAgentDir();
  let emptyAgentDir: string;

  before(() => {
    // Isolate from the real ~/.pi/agent/settings.json so the user's global
    // secondary/review task models cannot leak into this probe.
    emptyAgentDir = mkdtempSync(join(tmpdir(), "review-model-agent-"));
    setAgentDirForTests(() => emptyAgentDir);
  });

  after(() => {
    setAgentDirForTests(() => originalAgentDir);
    try {
      rmSync(emptyAgentDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("generic wai review resolves the per-level model from the effective level", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-model-cwd-"));
    tmpDirs.push(cwd);
    const piDir = join(cwd, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "settings.json"),
      JSON.stringify({
        "pi-yoowai": {
          reviewLevel: "med",
          // Hard stop before any backend call: the probe asserts the review got
          // PAST the model gate via the reviewMed override and stopped at the
          // cost budget instead of calling a model.
          costBudgetUsd: 0,
          taskModels: {
            reviewMed: {
              provider: "openai",
              id: "gpt-4o-mini",
              backend: "http",
              baseUrl: "http://127.0.0.1:9",
            },
          },
          // Deliberately NO secondary and NO review task: the old caller
          // (resolveReviewTaskModel(config, undefined)) would fall back to the
          // empty review task and return the gate error before any work.
        },
      }),
      "utf-8",
    );

    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiReview(cwd, "contract probe", ctx, {}, undefined, () => {});

    assert.ok(result.error, "expected an error result");
    assert.notEqual(
      result.error,
      REVIEW_NO_MODEL_ERROR,
      "the review resolved no model at all — per-level resolution regressed",
    );
    assert.ok(
      result.error.toLowerCase().includes("budget"),
      `expected the cost-budget stop (proves the model gate was passed via reviewMed), got: ${result.error}`,
    );
  });
});

describe("executeWaiReview model resolution (effective level drives per-level model)", () => {
  // Pins the caller contract in executeWaiReview: the generic `wai review`
  // resolves the effective level first (config.reviewLevel ?? model-derived),
  // then resolves the model from that level — so taskModels.reviewMed/reviewHigh
  // are honored on the generic path, not just by the explicit tools.
  const config: YoowaiConfig = {
    secondary: { provider: "opencode-go", id: "glm-5.2" },
    reviewLevel: "med",
    taskModels: {
      review: { provider: "kimi-coding", id: "k3-256k", thinking: "high" },
      reviewMed: { provider: "kimi-coding", id: "k3-256k", thinking: "low" },
      reviewHigh: { provider: "openai", id: "gpt-5", thinking: "max" },
    },
  };

  it("generic review (no tool override) uses the per-level model matching the configured level", () => {
    const level = resolveReviewSettings(config, undefined).level;
    assert.equal(level, "med");
    const model = resolveReviewTaskModel(config, level);
    assert.equal(model.provider, "kimi-coding");
    assert.equal(model.id, "k3-256k");
    assert.equal(model.thinking, "low"); // reviewMed wins over the review task's high
  });

  it("an explicit tool override wins over the configured level when its entry exists", () => {
    const level = resolveReviewSettings(config, "high").level;
    const model = resolveReviewTaskModel(config, level);
    assert.equal(model.provider, "openai"); // reviewHigh beats reviewMed + review task
    assert.equal(model.id, "gpt-5");
    assert.equal(model.thinking, "max");
  });

  it("explicit override falls back to the review task when the per-level entry is missing", () => {
    const level = resolveReviewSettings(config, "min").level;
    const model = resolveReviewTaskModel(config, level);
    assert.equal(model.id, "k3-256k"); // no reviewMin entry → review task
    assert.equal(model.thinking, "high");
  });

  it("configs without per-level entries are unchanged (fallback to the review task)", () => {
    const plain: YoowaiConfig = {
      secondary: { provider: "opencode-go", id: "glm-5.2" },
      reviewLevel: "med",
      taskModels: { review: { provider: "kimi-coding", id: "k3-256k", thinking: "high" } },
    };
    const level = resolveReviewSettings(plain, undefined).level;
    const model = resolveReviewTaskModel(plain, level);
    assert.equal(model.id, "k3-256k");
    assert.equal(model.thinking, "high");
  });
});

describe("planAdvanceFromReview (guarded auto-completion)", () => {
  it("consensus advances by the relative completedSteps count", () => {
    assert.deepEqual(planAdvanceFromReview(review({ completedSteps: 2 }), true, false), { count: 2 });
    assert.deepEqual(planAdvanceFromReview(review(), true, false), { count: 1 });
  });

  it("stepComplete advances exactly one step on a pass, even with minor issues", () => {
    // A pass with a low-severity nit: consensus is false, but the model
    // explicitly confirmed the current step's work is finished and covered.
    const result = review({
      consensus: false,
      stepComplete: true,
      issues: [{ severity: "low", issue: "nit", suggestion: "polish" }],
    });
    assert.deepEqual(planAdvanceFromReview(result, true, false), { count: 1 });
  });

  it("a bare pass without consensus or stepComplete does not advance", () => {
    assert.equal(planAdvanceFromReview(review({ consensus: false, stepComplete: false }), true, false), null);
    assert.equal(planAdvanceFromReview(review({ consensus: false }), true, false), null);
  });

  it("needs-work never advances, even with stepComplete", () => {
    const result = review({ verdict: "needs-work", consensus: false, stepComplete: true });
    assert.equal(planAdvanceFromReview(result, true, false), null);
  });

  it("no plan or an already-complete plan never advances", () => {
    assert.equal(planAdvanceFromReview(review(), false, false), null);
    assert.equal(planAdvanceFromReview(review(), true, true)!.count, 0);
    assert.equal(planAdvanceFromReview(review({ consensus: false, stepComplete: true }), true, true)!.count, 0);
  });
});

describe("mergeReviewResults plan-tracker signals", () => {
  it("stepComplete requires every sub-review; planStale fires on any", () => {
    const merged = mergeReviewResults([
      review({ stepComplete: true, planStale: false }),
      review({ stepComplete: true, planStale: true }),
    ]);
    assert.equal(merged.stepComplete, true);
    assert.equal(merged.planStale, true);

    const merged2 = mergeReviewResults([
      review({ stepComplete: true, planStale: false }),
      review({ stepComplete: false, planStale: false }),
    ]);
    assert.equal(merged2.stepComplete, false);
    assert.equal(merged2.planStale, false);
  });

  it("empty results never claim a step complete", () => {
    const merged = mergeReviewResults([]);
    assert.equal(merged.stepComplete, false);
    assert.equal(merged.planStale, false);
  });
});

describe("dedupeIssues (parallel-review cross-batch dedup)", () => {
  const issue = (overrides: Partial<ReviewIssue>): ReviewIssue => ({
    severity: "medium",
    file: "src/a.ts",
    line: 5,
    issue: "Bad name",
    suggestion: "rename it",
    ...overrides,
  });

  it("collapses exact repeats (same file, line, normalized text)", () => {
    const kept = dedupeIssues([
      issue({}),
      issue({}),
      issue({ issue: "  bad   NAME " }), // whitespace/case-insensitive repeat
    ]);
    assert.equal(kept.length, 1);
  });

  it("keeps two genuinely different issues on the same line", () => {
    const kept = dedupeIssues([issue({ issue: "Bad name" }), issue({ issue: "Unused import" })]);
    assert.equal(kept.length, 2);
  });

  it("keeps the same text on different files or lines", () => {
    const kept = dedupeIssues([
      issue({ file: "src/a.ts", line: 5 }),
      issue({ file: "src/b.ts", line: 5 }),
      issue({ file: "src/a.ts", line: 9 }),
    ]);
    assert.equal(kept.length, 3);
  });

  it("uses file-based keying with an empty line slot when line is missing", () => {
    const kept = dedupeIssues([
      issue({ file: "src/a.ts", line: undefined }),
      issue({ file: "src/b.ts", line: undefined, issue: "General note" }),
      issue({ file: "src/b.ts", line: undefined, issue: "General note" }),
    ]);
    assert.equal(kept.length, 2); // both texts survive once, the b.ts repeat collapses
    assert.deepEqual(
      kept.map((i) => i.issue),
      ["Bad name", "General note"],
    );
  });

  it("falls back to normalized text alone only when file is also missing", () => {
    const kept = dedupeIssues([
      issue({ file: undefined, line: undefined, issue: "General note" }),
      issue({ file: undefined, line: undefined, issue: "General note" }),
      issue({ file: undefined, line: undefined, issue: "Other note" }),
    ]);
    assert.equal(kept.length, 2); // the repeat collapses; the distinct text survives
    assert.deepEqual(
      kept.map((i) => i.issue),
      ["General note", "Other note"],
    );

    // A file-less issue never collapses a file-anchored one with the same text.
    const kept2 = dedupeIssues([
      issue({ file: "src/a.ts", line: undefined, issue: "General note" }),
      issue({ file: undefined, line: undefined, issue: "General note" }),
    ]);
    assert.equal(kept2.length, 2);
  });

  it("keeps the same text on different files when line is missing (file participates in the key)", () => {
    const kept = dedupeIssues([
      issue({ file: "src/a.ts", line: undefined, issue: "General note" }),
      issue({ file: "src/b.ts", line: undefined, issue: "General note" }),
      issue({ file: "src/a.ts", line: undefined, issue: "General note" }),
    ]);
    assert.equal(kept.length, 2); // a.ts and b.ts both survive; the a.ts repeat collapses
  });

  it("keeps the worst severity when a duplicate is reported at different severities", () => {
    const kept = dedupeIssues([issue({ severity: "low" }), issue({ severity: "high" })]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.severity, "high");

    const kept2 = dedupeIssues([issue({ severity: "high" }), issue({ severity: "low" })]);
    assert.equal(kept2[0]?.severity, "high"); // earlier high is kept, not downgraded
  });

  it("preserves encounter order", () => {
    const kept = dedupeIssues([
      issue({ file: "src/a.ts", issue: "first" }),
      issue({ file: "src/b.ts", issue: "second" }),
      issue({ file: "src/a.ts", issue: "first" }),
    ]);
    assert.deepEqual(
      kept.map((i) => i.issue),
      ["first", "second"],
    );
  });

  it("mergeReviewResults dedupes issues across batches while keeping verdict semantics", () => {
    const merged = mergeReviewResults([
      review({ issues: [issue({})] }),
      review({ issues: [issue({}), issue({ issue: "Unused import" })] }),
    ]);
    assert.equal(merged.issues.length, 2);
    // Verdict comes from the batch verdict fields, not issue counts.
    assert.equal(merged.verdict, "pass");
    assert.equal(merged.consensus, false); // issues still block consensus

    const failing = mergeReviewResults([
      review({ issues: [issue({})] }),
      review({ verdict: "needs-work", issues: [issue({})], consensus: false }),
    ]);
    assert.equal(failing.issues.length, 1);
    assert.equal(failing.verdict, "needs-work"); // worst-of unaffected by dedup
  });
});
