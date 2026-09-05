import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectIndex, saveProjectIndex } from "./project-index.js";
import {
  recordLearnedFact,
  loadLearnedFacts,
  findLearnedFacts,
  formatLearnedFacts,
  clearLearnedFacts,
  verifyLearnedFacts,
  formatVerificationReport,
  verifyLearnedFactsDeep,
} from "./wai-learn.js";

describe("wai-learn", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "wai-learn-test-"));
  });

  it("rejects invalid kinds (recorded as plain facts)", () => {
    // The public tool passes only 'fact' | 'decision'; a stray invalid kind
    // must not poison the store — it records as a plain fact (kind undefined).
    const entry = recordLearnedFact(cwd, "Some note.", { kind: "bogus" as never });
    assert.equal(entry.kind, undefined);
    assert.equal(findLearnedFacts(cwd, undefined, "decision").length, 0);
    assert.equal(findLearnedFacts(cwd).length, 1);
  });

  it("records decisions and filters by kind", () => {
    recordLearnedFact(cwd, "Use camelCase.", { category: "conventions" });
    recordLearnedFact(cwd, "Never update the lockfile manually.", { kind: "decision", source: "review" });

    const decisions = findLearnedFacts(cwd, undefined, "decision");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.kind, "decision");
    assert.equal(decisions[0]?.fact, "Never update the lockfile manually.");
    assert.equal(decisions[0]?.source, "review");

    const facts = findLearnedFacts(cwd, undefined, "fact");
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.kind, undefined, "plain facts keep kind undefined (legacy-compatible)");

    // All kinds together (no filter), newest first.
    const all = findLearnedFacts(cwd);
    assert.equal(all.length, 2);
    assert.equal(all[0]?.kind, "decision", "newest first");
  });

  it("records and loads facts", () => {
    recordLearnedFact(cwd, "Use camelCase.", { category: "conventions" });
    recordLearnedFact(cwd, "Auth uses Clerk.", { category: "auth", source: "README.md" });

    const facts = loadLearnedFacts(cwd);
    assert.equal(facts.length, 2);
    assert.ok(facts.some((f) => f.fact === "Use camelCase."));
  });

  it("finds facts by query", () => {
    recordLearnedFact(cwd, "Use camelCase.", { category: "conventions" });
    recordLearnedFact(cwd, "Auth uses Clerk.", { category: "auth" });

    const found = findLearnedFacts(cwd, "auth");
    assert.equal(found.length, 1);
    assert.equal(found[0].fact, "Auth uses Clerk.");
  });

  it("formats facts", () => {
    recordLearnedFact(cwd, "Use camelCase.", { category: "conventions" });
    const text = formatLearnedFacts(loadLearnedFacts(cwd));
    assert.match(text, /\[conventions\] Use camelCase\./);
  });

  it("clears facts", () => {
    recordLearnedFact(cwd, "Use camelCase.");
    clearLearnedFacts(cwd);
    assert.equal(loadLearnedFacts(cwd).length, 0);
    assert.ok(existsSync(join(cwd, ".pi", "yoowai", "learned.json")));
  });

  it("flags outdated facts with missing files", () => {
    recordLearnedFact(cwd, "Old logic lives in src/old.ts", { source: "src/old.ts" });
    const results = verifyLearnedFacts(cwd);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "outdated");
    assert.match(results[0].reasons.join(" "), /src\/old\.ts/);
  });

  it("flags questionable facts with missing symbols", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "demo.ts"), "export const demo = 1;", "utf-8");
    saveProjectIndex(cwd, buildProjectIndex(cwd));

    recordLearnedFact(cwd, "Call removedFunction() to reset state.");
    const results = verifyLearnedFacts(cwd);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "questionable");
    assert.match(results[0].reasons.join(" "), /removedFunction/);
  });

  it("marks facts valid when references exist", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "demo.ts"), "export const demo = 1;", "utf-8");
    saveProjectIndex(cwd, buildProjectIndex(cwd));

    recordLearnedFact(cwd, "Use the demo export in src/demo.ts.");
    const results = verifyLearnedFacts(cwd);
    assert.equal(results[0].status, "valid");
    assert.match(formatVerificationReport(results), /1 valid/);
  });

  it("deep verify uses the model caller", async () => {
    recordLearnedFact(cwd, "Auth uses Clerk.");
    const caller = async () => ({
      content: "STATUS: questionable\nREASON: No Clerk references found.",
      usage: {
        estimatedInputTokens: 10,
        estimatedOutputTokens: 5,
        estimatedCostUsd: 0.0001,
        sessionCostUsd: 0.0001,
      },
    });
    const { results, cost } = await verifyLearnedFactsDeep(cwd, undefined, undefined, () => {}, undefined, caller);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "questionable");
    assert.match(results[0].reasons[0], /No Clerk references/);
    assert.ok(cost.estimatedCostUsd > 0);
  });

  it("cleans up temp dir", () => {
    rmSync(cwd, { recursive: true, force: true });
    assert.ok(true);
  });
});
