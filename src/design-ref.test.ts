import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  addDesignRule,
  removeDesignRule,
  clearDesignRules,
  loadDesignRules,
  peekDesignRules,
  formatDesignRules,
  formatDesignRulesForPrompt,
  importDesignRules,
  isUiFile,
  MAX_RULES,
} from "./design-ref.js";
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

describe("addDesignRule", () => {
  it("adds, trims, dedupes case-insensitively, and caps at MAX_RULES", () => {
    const cwd = makeTempDir("design-ref-add-");

    const entry = addDesignRule(cwd, "  Use generous whitespace  ", "SKILL.md");
    assert.equal(entry.rule, "Use generous whitespace");
    assert.equal(entry.source, "SKILL.md");
    assert.equal(loadDesignRules(cwd).length, 1);

    const dup = addDesignRule(cwd, "use generous WHITESPACE");
    assert.equal(loadDesignRules(cwd).length, 1);
    assert.equal(dup.rule, "Use generous whitespace");

    for (let i = 0; i < MAX_RULES + 5; i++) {
      addDesignRule(cwd, `Rule number ${i} for padding purposes`);
    }
    const rules = loadDesignRules(cwd);
    assert.equal(rules.length, MAX_RULES);
    // Oldest rules were dropped, newest kept.
    assert.equal(rules[rules.length - 1].rule, `Rule number ${MAX_RULES + 4} for padding purposes`);
  });
});

describe("removeDesignRule", () => {
  it("removes by 1-based index and rejects invalid indexes", () => {
    const cwd = makeTempDir("design-ref-remove-");
    addDesignRule(cwd, "First rule here");
    addDesignRule(cwd, "Second rule here");

    assert.equal(removeDesignRule(cwd, 0), undefined);
    assert.equal(removeDesignRule(cwd, 3), undefined);
    assert.equal(removeDesignRule(cwd, 1.5), undefined);
    assert.equal(loadDesignRules(cwd).length, 2);

    const removed = removeDesignRule(cwd, 1);
    assert.equal(removed?.rule, "First rule here");
    const remaining = loadDesignRules(cwd);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].rule, "Second rule here");
  });
});

describe("clearDesignRules / peekDesignRules", () => {
  it("clears the store", () => {
    const cwd = makeTempDir("design-ref-clear-");
    addDesignRule(cwd, "Something to clear");
    clearDesignRules(cwd);
    assert.deepEqual(peekDesignRules(cwd), []);
  });

  it("returns empty for a missing file", () => {
    const cwd = makeTempDir("design-ref-missing-");
    assert.deepEqual(peekDesignRules(cwd), []);
  });

  it("returns empty for a corrupt file", () => {
    const cwd = makeTempDir("design-ref-corrupt-");
    const dir = join(cwd, ".pi", "yoowai");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "design-ref.json"), "{ not json !!!", "utf-8");
    assert.deepEqual(peekDesignRules(cwd), []);
  });

  it("returns empty for a file with an invalid shape", () => {
    const cwd = makeTempDir("design-ref-shape-");
    const dir = join(cwd, ".pi", "yoowai");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "design-ref.json"), JSON.stringify({ rules: [{ nope: 1 }] }), "utf-8");
    assert.deepEqual(peekDesignRules(cwd), []);
  });
});

describe("formatDesignRules", () => {
  it("renders bullets and an empty message", () => {
    assert.equal(formatDesignRules([]), "No design rules recorded.");
    const text = formatDesignRules([{ rule: "Keep motion subtle", timestamp: "t" }]);
    assert.equal(text, "- Keep motion subtle");
  });
});

describe("formatDesignRulesForPrompt", () => {
  it("seeds the defaults on first use of an empty store", () => {
    const cwd = makeTempDir("design-ref-prompt-empty-");
    const text = formatDesignRulesForPrompt(cwd, 800);
    assert.ok(text.includes("- "), "seeded defaults should render as bullets");
    assert.ok(text.length > 0);
  });

  it("returns empty string when maxTokens is 0 or negative", () => {
    const cwd = makeTempDir("design-ref-prompt-zero-");
    addDesignRule(cwd, "A rule that should not render");
    assert.equal(formatDesignRulesForPrompt(cwd, 0), "");
    assert.equal(formatDesignRulesForPrompt(cwd, -5), "");
  });

  it("renders rules and truncates to the token budget", () => {
    const cwd = makeTempDir("design-ref-prompt-budget-");
    for (let i = 0; i < 40; i++) {
      addDesignRule(cwd, `Design rule ${i}: prefer clarity and calm layouts over dense decoration`);
    }
    const full = formatDesignRulesForPrompt(cwd, 100000);
    assert.ok(full.includes("- Design rule 0"));

    const budget = 100;
    const truncated = formatDesignRulesForPrompt(cwd, budget);
    assert.ok(truncated.length > 0);
    assert.ok(estimateTokens(truncated) <= budget);
    assert.ok(truncated.length < full.length);
  });
});

describe("importDesignRules", () => {
  it("extracts bullets, numbered items, and heading content; skips fences and frontmatter", () => {
    const cwd = makeTempDir("design-ref-import-");
    const markdown = [
      "---",
      "title: ignored frontmatter rule text",
      "---",
      "",
      "# Animation",
      "",
      "## Motion rules",
      "- Use spring-based motion for interactive elements",
      "* [x] Keep durations under 300ms for micro-interactions",
      "1. Prefer transform over layout-triggering properties",
      "Reduce motion when the user requests it",
      "",
      "```css",
      ".ignored { transition: none; }",
      "```",
      "",
      "- tiny",
      "",
      "## Another section",
      "No bullets here but a full sentence rule lives here",
      "",
      "- Use spring-based motion for interactive elements",
    ].join("\n");
    writeFileSync(join(cwd, "SKILL.md"), markdown, "utf-8");

    const result = importDesignRules(cwd, "SKILL.md");
    assert.equal(result.imported, 5);
    assert.equal(result.skipped, 1); // the last bullet is a duplicate; "tiny" is dropped during extraction

    const rules = loadDesignRules(cwd).map((r) => r.rule);
    assert.ok(rules.includes("Use spring-based motion for interactive elements"));
    assert.ok(rules.includes("Keep durations under 300ms for micro-interactions"));
    assert.ok(rules.includes("Prefer transform over layout-triggering properties"));
    assert.ok(rules.includes("Reduce motion when the user requests it"));
    assert.ok(rules.includes("No bullets here but a full sentence rule lives here"));
    assert.ok(!rules.some((r) => r.includes("transition: none")));
    assert.ok(!rules.some((r) => r.includes("frontmatter")));
    // Source is recorded for imported rules.
    assert.ok(loadDesignRules(cwd).every((r) => r.source === "SKILL.md"));

    // Re-importing the same file imports nothing new.
    const again = importDesignRules(cwd, "SKILL.md");
    assert.equal(again.imported, 0);
    assert.equal(again.skipped, 6); // all extracted candidates (incl. the in-file duplicate) already exist
  });

  it("rejects path traversal and missing files", () => {
    const cwd = makeTempDir("design-ref-import-reject-");
    assert.throws(() => importDesignRules(cwd, "../outside.md"), /Unsafe path/);
    assert.throws(() => importDesignRules(cwd, "does-not-exist.md"), /not found/);
  });
});

describe("isUiFile", () => {
  it("matches UI file extensions case-insensitively", () => {
    for (const ui of [
      "src/App.tsx",
      "src/App.jsx",
      "styles/main.css",
      "styles/main.scss",
      "styles/main.sass",
      "styles/main.less",
      "src/App.svelte",
      "src/App.vue",
      "index.html",
      "src/COMPONENT.TSX",
    ]) {
      assert.equal(isUiFile(ui), true, ui);
    }
  });

  it("rejects non-UI files", () => {
    for (const nonUi of ["src/index.ts", "src/util.js", "README.md", "src/data.json", "src/styles.css.map"]) {
      assert.equal(isUiFile(nonUi), false, nonUi);
    }
  });
});
