import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectEvaluationSkills,
  getSkillSelections,
  clearSkillSelections,
  isAndroidModuleFile,
} from "./skill-guidance.js";
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
  it("selects web guidance for installed frontend frameworks without assuming Node runtime", () => {
    const cwd = temp();
    for (const framework of ["react", "vue", "@angular/core", "svelte", "next"]) {
      writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: { [framework]: "installed" } }));
      const selected = selectEvaluationSkills(cwd, "review", ["src/state.ts"]);
      assert.ok(selected.includes("wai-web"), framework);
      assert.ok(!selected.includes("wai-node"), framework);
      const text = capActionInstructions(cwd, "review", 800, ["src/state.ts"]);
      assert.ok(text.includes("wai-web"));
      assert.ok(estimateTokens(text) <= 800);
    }
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ devDependencies: { vite: "installed" } }));
    assert.ok(selectEvaluationSkills(cwd, "review", ["src/component.vue"]).includes("wai-web"));
    assert.ok(!selectEvaluationSkills(cwd, "review", ["src/service.ts"]).includes("wai-web"));
  });
  it("uses nearest package boundaries in a frontend/backend monorepo", () => {
    const cwd = temp();
    mkdirSync(join(cwd, "web"));
    mkdirSync(join(cwd, "service"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: { react: "installed" } }));
    writeFileSync(join(cwd, "web", "package.json"), JSON.stringify({ dependencies: { vue: "installed" } }));
    writeFileSync(join(cwd, "service", "package.json"), JSON.stringify({ dependencies: { express: "installed" } }));
    const web = selectEvaluationSkills(cwd, "review", ["web/src/state.ts"]);
    assert.ok(web.includes("wai-web"));
    assert.ok(!web.includes("wai-node"));
    const server = selectEvaluationSkills(cwd, "review", ["service/src/main.ts"]);
    assert.ok(server.includes("wai-node"));
    assert.ok(!server.includes("wai-web"));
    const mixed = selectEvaluationSkills(cwd, "review", ["web/src/state.ts", "service/src/main.ts"]);
    assert.ok(mixed.includes("wai-web") && mixed.includes("wai-node"));
    const ssr = selectEvaluationSkills(cwd, "review", ["app/api/session.ts"]);
    assert.ok(ssr.includes("wai-web") && ssr.includes("wai-node"));
  });
  it("selects security criteria for security actions and changed credential boundaries", () => {
    const cwd = temp();
    assert.ok(selectEvaluationSkills(cwd, "security", ["src/main.ts"]).includes("wai-security"));
    assert.ok(selectEvaluationSkills(cwd, "review", ["src/auth/token.ts"]).includes("wai-security"));
    assert.ok(!selectEvaluationSkills(cwd, "review", ["src/main.ts"]).includes("wai-security"));
    const text = capActionInstructions(cwd, "security", 800, ["src/main.ts"]);
    assert.ok(text.includes("wai-security"));
    assert.ok(estimateTokens(text) <= 800);
  });
  it("does not use malformed or external package metadata as stack evidence", () => {
    const cwd = temp(),
      outside = temp();
    writeFileSync(join(cwd, "package.json"), "{broken");
    assert.ok(!selectEvaluationSkills(cwd, "review", ["src/main.ts"]).includes("wai-node"));
    writeFileSync(join(outside, "package.json"), JSON.stringify({ dependencies: { react: "installed" } }));
    symlinkSync(outside, join(cwd, "external"), process.platform === "win32" ? "junction" : "dir");
    const escaped = selectEvaluationSkills(cwd, "review", ["external/src/main.ts", "../external/component.tsx"]);
    assert.ok(!escaped.includes("wai-web"));
    assert.ok(!escaped.includes("wai-node"));
  });
  it("selects Kotlin Android guidance without requiring a separate Kotlin plugin", () => {
    const cwd = temp(),
      module = join(cwd, "android", "app");
    mkdirSync(module, { recursive: true });
    writeFileSync(join(module, "build.gradle.kts"), 'plugins { id("com.android.application") }\n');
    writeFileSync(join(cwd, "pubspec.yaml"), "dependencies:\n  flutter:\n    sdk: flutter\n");
    const file = "android\\app\\src\\main\\kotlin\\app\\MainActivity.kt";
    assert.ok(selectEvaluationSkills(cwd, "review", [file]).includes("wai-kotlin"));
    assert.ok(selectEvaluationSkills(cwd, "test", ["android/app/build.gradle.kts"]).includes("wai-kotlin"));
    const text = capActionInstructions(cwd, "review", 800, [file]);
    assert.ok(text.includes("wai-kotlin"));
    assert.ok(estimateTokens(text) <= 800);
    assert.equal(isAndroidModuleFile(cwd, "../outside/MainActivity.kt"), false);
  });
  it("uses module manifest evidence for catalog aliases and keeps JVM modules separate", () => {
    const cwd = temp(),
      app = join(cwd, "app"),
      backend = join(cwd, "backend");
    mkdirSync(join(app, "src", "main"), { recursive: true });
    mkdirSync(backend);
    writeFileSync(
      join(cwd, "build.gradle.kts"),
      'plugins { id("com.android.application") version "9.0.0" apply false }',
    );
    writeFileSync(join(app, "build.gradle.kts"), "plugins { alias(libs.plugins.mobile) }");
    writeFileSync(join(app, "src", "main", "AndroidManifest.xml"), '<manifest package="example" />');
    writeFileSync(join(backend, "build.gradle.kts"), 'plugins { kotlin("jvm") }');
    assert.ok(selectEvaluationSkills(cwd, "review", ["app/src/main/kotlin/MainActivity.kt"]).includes("wai-kotlin"));
    assert.ok(!selectEvaluationSkills(cwd, "review", ["backend/src/main/kotlin/Server.kt"]).includes("wai-kotlin"));
    assert.ok(!selectEvaluationSkills(backend, "review", ["src/main/kotlin/Server.kt"]).includes("wai-kotlin"));
  });
  it("injects platform-neutral design rules only for confirmed Android UI paths", () => {
    const cwd = temp(),
      app = join(cwd, "app");
    mkdirSync(app);
    const ui = "app/src/main/kotlin/ui/LoginScreen.kt";
    assert.equal(hasUiChanges(cwd, [ui]), false);
    writeFileSync(join(app, "build.gradle"), "plugins { id 'com.android.library' }");
    assert.equal(hasUiChanges(cwd, [ui]), true);
    assert.equal(hasUiChanges(cwd, ["app/src/main/res/layout/activity_login.xml"]), true);
    assert.equal(hasUiChanges(cwd, ["app/src/main/kotlin/data/Repository.kt"]), false);
    const text = formatDesignRulesForPrompt(cwd, 800, [ui]);
    assert.ok(text.includes("reduced motion"));
    assert.ok(!text.includes("Web:"));
  });
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
