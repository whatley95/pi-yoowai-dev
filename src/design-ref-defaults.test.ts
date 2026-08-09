import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  addDesignRule,
  clearDesignRules,
  loadDesignRules,
  peekDesignRules,
  listDesignRefDocs,
  readDesignRefDoc,
  DESIGN_REF_TOPIC_DESCRIPTIONS,
} from "./design-ref.js";
import {
  DEFAULT_DESIGN_RULES,
  DEFAULT_RULES_SOURCE,
  formatWriterDesignGuidance,
  resetDesignRulesToDefaults,
  seedDefaultDesignRules,
} from "./design-ref-defaults.js";
import { estimateTokens } from "./token-budget.js";

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("seedDefaultDesignRules", () => {
  it("seeds a missing store", () => {
    const cwd = makeTempDir("design-ref-seed-missing-");
    assert.equal(seedDefaultDesignRules(cwd), true);
    const rules = peekDesignRules(cwd);
    assert.equal(rules.length, DEFAULT_DESIGN_RULES.length);
    assert.ok(rules.every((r) => r.source === DEFAULT_RULES_SOURCE));
  });

  it("seeds a zero-rule store", () => {
    const cwd = makeTempDir("design-ref-seed-zero-");
    clearDesignRules(cwd); // persists an explicit empty store
    assert.equal(seedDefaultDesignRules(cwd), true);
    assert.equal(peekDesignRules(cwd).length, DEFAULT_DESIGN_RULES.length);
  });

  it("does not touch a store with user rules", () => {
    const cwd = makeTempDir("design-ref-seed-user-");
    addDesignRule(cwd, "My own design rule");
    assert.equal(seedDefaultDesignRules(cwd), false);
    const rules = peekDesignRules(cwd);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].rule, "My own design rule");
  });

  it("is idempotent", () => {
    const cwd = makeTempDir("design-ref-seed-idem-");
    assert.equal(seedDefaultDesignRules(cwd), true);
    assert.equal(seedDefaultDesignRules(cwd), false);
    assert.equal(peekDesignRules(cwd).length, DEFAULT_DESIGN_RULES.length);
  });

  it("seeds lazily through loadDesignRules", () => {
    const cwd = makeTempDir("design-ref-seed-lazy-");
    const rules = loadDesignRules(cwd);
    assert.equal(rules.length, DEFAULT_DESIGN_RULES.length);
    assert.equal(rules[0].rule, DEFAULT_DESIGN_RULES[0]);
  });
});

describe("resetDesignRulesToDefaults", () => {
  it("replaces user rules with the defaults", () => {
    const cwd = makeTempDir("design-ref-reset-");
    addDesignRule(cwd, "Custom rule one");
    addDesignRule(cwd, "Custom rule two");
    const count = resetDesignRulesToDefaults(cwd);
    assert.equal(count, DEFAULT_DESIGN_RULES.length);
    const rules = peekDesignRules(cwd);
    assert.equal(rules.length, DEFAULT_DESIGN_RULES.length);
    assert.ok(rules.every((r) => r.source === DEFAULT_RULES_SOURCE));
    assert.ok(!rules.some((r) => r.rule.startsWith("Custom rule")));
  });
});

describe("listDesignRefDocs", () => {
  it("finds all 9 vendored topics with SKILL.md present", () => {
    const topics = listDesignRefDocs();
    assert.equal(topics.length, 9);
    for (const t of topics) {
      assert.ok(t.docs.includes("SKILL.md"), `${t.topic} should have SKILL.md`);
      assert.equal(t.docs[0], "SKILL.md", "SKILL.md should be listed first");
      assert.ok(typeof DESIGN_REF_TOPIC_DESCRIPTIONS[t.topic] === "string", `${t.topic} needs a description`);
    }
    const names = topics.map((t) => t.topic);
    for (const expected of [
      "animate",
      "animation-vocabulary",
      "apple-design",
      "emil-design-eng",
      "find-animation-opportunities",
      "improve-animations",
      "pick-ui-library",
      "prototype",
      "review-animations",
    ]) {
      assert.ok(names.includes(expected), expected);
    }
    // Extra docs are listed for topics that have them.
    assert.ok(topics.find((t) => t.topic === "animate")?.docs.includes("RECIPES.md"));
    assert.ok(topics.find((t) => t.topic === "improve-animations")?.docs.includes("AUDIT.md"));
  });
});

describe("readDesignRefDoc", () => {
  it("returns the topic SKILL.md by default with expected markers", () => {
    const content = readDesignRefDoc("review-animations");
    assert.ok(content.includes("ease-out"));
    assert.ok(content.length > 100);
  });

  it("reads a specific doc", () => {
    const content = readDesignRefDoc("improve-animations", "AUDIT.md");
    assert.ok(content.length > 100);
  });

  it("respects a small maxTokens budget", () => {
    const content = readDesignRefDoc("review-animations", undefined, 50);
    assert.ok(estimateTokens(content) <= 60, "truncated content should stay near the budget");
    assert.ok(content.includes("truncated"));
  });

  it("throws on unknown topic and lists the available ones", () => {
    assert.throws(() => readDesignRefDoc("no-such-topic"), /Unknown design reference topic.*review-animations/s);
  });

  it("rejects traversal and unlisted docs", () => {
    assert.throws(() => readDesignRefDoc("../review-animations"), /Unknown design reference topic/);
    assert.throws(() => readDesignRefDoc("review-animations", "../animate/SKILL.md"), /Unknown doc/);
    assert.throws(() => readDesignRefDoc("review-animations", "C:/Windows/win.ini"), /Unknown doc/);
    assert.throws(() => readDesignRefDoc("review-animations", "MISSING.md"), /Unknown doc/);
  });
});

describe("formatWriterDesignGuidance", () => {
  it("renders the load-bearing rules and ends with the tool hint", () => {
    const cwd = makeTempDir("design-ref-writer-");
    const text = formatWriterDesignGuidance(cwd, 2000);
    assert.ok(text.endsWith("Call the wai_design_ref tool for full design guidance."));
    assert.ok(text.includes("ease-out"));
    assert.ok(text.includes("transform and opacity"));
  });

  it("stays under a tight budget", () => {
    const cwd = makeTempDir("design-ref-writer-budget-");
    const budget = 120;
    const text = formatWriterDesignGuidance(cwd, budget);
    assert.ok(text.length > 0);
    assert.ok(estimateTokens(text) <= budget);
    assert.ok(text.endsWith("Call the wai_design_ref tool for full design guidance."));
  });

  it("returns empty for non-positive budgets", () => {
    const cwd = makeTempDir("design-ref-writer-zero-");
    assert.equal(formatWriterDesignGuidance(cwd, 0), "");
    assert.equal(formatWriterDesignGuidance(cwd, -1), "");
  });
});
