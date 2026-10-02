import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectEvaluationSkills, getSkillSelections, clearSkillSelections } from "./skill-guidance.js";
import { capActionInstructions } from "./instructions.js";
import { hasUiChanges, formatDesignRulesForPrompt, addDesignRule, readDesignRefPage } from "./design-ref.js";
import { DEFAULT_RULES_SOURCE } from "./design-ref-defaults.js";
import { estimateTokens } from "./token-budget.js";

const dirs: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "wai-criteria-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    clearSkillSelections(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("selected development guidance", () => {
  it("selects confirmed stack guidance and excludes unrelated stacks", () => {
    const cwd = temp();
    writeFileSync(join(cwd, "pubspec.yaml"), "dependencies:\n  flutter:\n    sdk: flutter\n");
    const result = selectEvaluationSkills(cwd, "review", ["lib/widgets/status.dart"]);
    assert.ok(result.includes("wai-flutter"));
    assert.ok(!result.includes("wai-node"));
    assert.ok(!result.includes("wai-spring"));
    writeFileSync(join(cwd, "pubspec.yaml"), "name: ordinary_dart\n");
    assert.ok(!selectEvaluationSkills(cwd, "review", ["lib/widgets/status.dart"]).includes("wai-flutter"));
    writeFileSync(join(cwd, "pom.xml"), "<dependency>org.springframework.boot</dependency>");
    assert.ok(selectEvaluationSkills(cwd, "review", ["src/Controller.java"]).includes("wai-spring"));
    assert.deepEqual(selectEvaluationSkills(cwd, "plan", ["src/Controller.java"]), []);
  });
  it("preserves project-rule priority and the existing instruction budget", () => {
    const cwd = temp(),
      dir = join(cwd, ".pi", "yoowai", "instructions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(cwd, "package.json"), "{}");
    writeFileSync(join(dir, "review.md"), "PROJECT_RULE");
    const text = capActionInstructions(cwd, "review", 800, ["src/api.ts"]);
    assert.ok(text.startsWith("PROJECT_RULE"));
    assert.ok(text.includes("wai-node"));
    assert.ok(estimateTokens(text) <= 800);
    const tiny = capActionInstructions(cwd, "review", 3, ["src/api.ts"]);
    assert.ok(estimateTokens(tiny) <= 3);
    assert.deepEqual(getSkillSelections(cwd).review, []);
    assert.equal(capActionInstructions(cwd, "review", 0, ["src/api.ts"]), "");
    assert.deepEqual(getSkillSelections(cwd).review, []);
  });
  it("does not invent stack evidence or write project state for optional criteria", () => {
    const cwd = temp();
    const text = capActionInstructions(cwd, "review", 800, ["src/file.ts"]);
    assert.ok(text.includes("wai-testing"));
    assert.ok(!text.includes("wai-node"));
    assert.throws(() => readFileSync(join(cwd, ".pi", "yoowai", "instructions", "review.md")));
  });
});

describe("platform-aware design and complete reference paging", () => {
  it("recognizes Flutter UI without treating every Dart service as UI", () => {
    const cwd = temp();
    assert.equal(hasUiChanges(cwd, ["lib/widgets/card.dart"]), false);
    writeFileSync(join(cwd, "pubspec.yaml"), "dependencies:\n  flutter:\n    sdk: flutter\n");
    assert.equal(hasUiChanges(cwd, ["lib/widgets/card.dart"]), true);
    assert.equal(hasUiChanges(cwd, ["lib\\features\\login\\screens\\login.dart"]), true);
    assert.equal(hasUiChanges(cwd, ["lib/services/data.dart"]), false);
    assert.equal(hasUiChanges(cwd, ["src/card.tsx"]), true);
  });
  it("adapts source-owned legacy defaults without replacing custom rules", () => {
    const cwd = temp();
    addDesignRule(cwd, "Never scale from 0; enter from scale(0.9-0.97) + opacity 0.", DEFAULT_RULES_SOURCE);
    addDesignRule(cwd, "Web: custom product rule", "user");
    const text = formatDesignRulesForPrompt(cwd, 800, ["lib/widgets/card.dart"]);
    assert.ok(text.includes("pure fades"));
    assert.ok(text.includes("custom product rule"));
    assert.ok(!text.includes("Never scale from 0"));
  });
  it("reconstructs a large document across bounded pages without missing any characters", () => {
    let offset = 0,
      full = "";
    for (;;) {
      const page = readDesignRefPage("emil-design-eng", undefined, offset, 100);
      assert.ok(estimateTokens(page.content) <= 100);
      full += page.content;
      if (page.nextOffset === undefined) break;
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    }
    assert.equal(full, readFileSync(join(process.cwd(), "design-refs", "emil-design-eng", "SKILL.md"), "utf8"));
    assert.ok(readDesignRefPage("wai-skill-design", "references/review.md").content.length > 0);
    assert.throws(() => readDesignRefPage("wai-skill-design", "../../package.json"), /Unknown doc/);
    assert.throws(() => readDesignRefPage("animate", undefined, -1), /offset/);
    assert.throws(() => readDesignRefPage("animate", undefined, 0, 6001), /maxTokens/);
  });
});
