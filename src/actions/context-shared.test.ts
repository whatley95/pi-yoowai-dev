import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveEffectiveToolLoop, resolveEffectivePreReviewCommands, prepareActionDiff } from "./context-shared.js";
import type { YoowaiConfig } from "../types.js";

describe("resolveEffectiveToolLoop (level-aware defaults)", () => {
  it("unset toolUseLoop resolves off/3/5 for min/med/high", () => {
    const config: YoowaiConfig = { secondary: { provider: "openai", id: "gpt-4o-mini" } };
    assert.equal(resolveEffectiveToolLoop(config, "min"), undefined);
    assert.equal(resolveEffectiveToolLoop(config, "med"), 3);
    assert.equal(resolveEffectiveToolLoop(config, "high"), 5);
  });

  it("explicit toolUseLoop config overrides the level default", () => {
    const config: YoowaiConfig = { secondary: { provider: "openai", id: "gpt-4o-mini" }, toolUseLoop: 1 };
    assert.equal(resolveEffectiveToolLoop(config, "min"), 1);
    assert.equal(resolveEffectiveToolLoop(config, "high"), 1);

    const off: YoowaiConfig = { secondary: { provider: "openai", id: "gpt-4o-mini" }, toolUseLoop: false };
    assert.equal(resolveEffectiveToolLoop(off, "high"), false);
  });
});

describe("resolveEffectivePreReviewCommands (auto-detection opt-in)", () => {
  const tmpDirs: string[] = [];

  after(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  function makeProject(scripts?: Record<string, string>): string {
    const cwd = mkdtempSync(join(tmpdir(), "review-precmd-"));
    tmpDirs.push(cwd);
    const pkg = { name: "probe", version: "1.0.0" } as Record<string, unknown>;
    if (scripts) pkg.scripts = scripts;
    writeFileSync(join(cwd, "package.json"), JSON.stringify(pkg), "utf-8");
    return cwd;
  }

  const base = (overrides: Partial<YoowaiConfig> = {}): YoowaiConfig => ({
    secondary: { provider: "openai", id: "gpt-4o-mini" },
    ...overrides,
  });

  it("default-off: no commands without autoPreReviewCommands, at any level", () => {
    const cwd = makeProject({ typecheck: "tsc --noEmit", lint: "eslint ." });
    assert.deepEqual(resolveEffectivePreReviewCommands(cwd, base(), "min"), []);
    assert.deepEqual(resolveEffectivePreReviewCommands(cwd, base(), "med"), []);
    assert.deepEqual(resolveEffectivePreReviewCommands(cwd, base(), "high"), []);
  });

  it("auto mode: med detects typecheck+lint, high adds test, min nothing", () => {
    const cwd = makeProject({ typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run" });
    const auto = base({ autoPreReviewCommands: true });
    assert.deepEqual(resolveEffectivePreReviewCommands(cwd, auto, "min"), []);
    assert.deepEqual(resolveEffectivePreReviewCommands(cwd, auto, "med"), ["npm run typecheck", "npm run lint"]);
    assert.deepEqual(resolveEffectivePreReviewCommands(cwd, auto, "high"), [
      "npm run typecheck",
      "npm run lint",
      "npm run test",
    ]);
  });

  it("explicit preReviewCommands always wins over auto mode", () => {
    const cwd = makeProject({ typecheck: "tsc --noEmit" });
    const explicit = base({ autoPreReviewCommands: true, preReviewCommands: ["npm run custom-check"] });
    assert.deepEqual(resolveEffectivePreReviewCommands(cwd, explicit, "high"), ["npm run custom-check"]);
  });

  it("an explicitly empty preReviewCommands list also wins (never triggers auto mode)", () => {
    const cwd = makeProject({ typecheck: "tsc --noEmit" });
    const explicitEmpty = base({ autoPreReviewCommands: true, preReviewCommands: [] });
    assert.deepEqual(resolveEffectivePreReviewCommands(cwd, explicitEmpty, "high"), []);
  });
});

describe("prepareActionDiff (fail-closed, never truncates)", () => {
  it("returns the full diff when it fits the budget", () => {
    const result = prepareActionDiff("judge", {
      diff: "a".repeat(4000),
      availableInputTokens: 5000,
      fileTokens: 500,
    });
    assert.ok(result.ok);
    assert.equal(result.diff, "a".repeat(4000));
  });

  it("fails closed with guidance when the diff exceeds the budget", () => {
    const result = prepareActionDiff("security", {
      diff: "a".repeat(40_000), // ~10k tokens
      availableInputTokens: 5000,
      fileTokens: 0,
    });
    assert.ok(!result.ok);
    assert.match(result.error, /too large for a security review/);
    assert.match(result.error, /files:\[\.\.\.\]/);
    assert.match(result.error, /reviewMaxInputTokens/);
  });

  it("deducts codemap and designRef after files (yields to them)", () => {
    // 4000 available − 1000 system − 1000 codemap − 500 designRef = 1500 tokens
    // left for the diff (~6000 chars). A 5000-char diff fits, 7000 does not.
    const fits = prepareActionDiff("judge", {
      diff: "a".repeat(5000),
      availableInputTokens: 4000,
      fileTokens: 0,
      codemap: "b".repeat(4000),
      designRefText: "c".repeat(2000),
    });
    assert.ok(fits.ok, "diff under remaining budget must pass");

    const over = prepareActionDiff("judge", {
      diff: "a".repeat(7000),
      availableInputTokens: 4000,
      fileTokens: 0,
      codemap: "b".repeat(4000),
      designRefText: "c".repeat(2000),
    });
    assert.ok(!over.ok);
    assert.match(over.error, /judge/);
  });

  it("honors the overridable system-prompt estimate", () => {
    // Default 1000 leaves 900 tokens; a larger estimate (2000) leaves nothing.
    const tight = prepareActionDiff("test", {
      diff: "a".repeat(3600), // 900 tokens
      availableInputTokens: 2000,
      fileTokens: 0,
      systemPromptEstimate: 1100,
    });
    assert.ok(tight.ok);
    assert.ok(!tight.ok ? true : tight.diff.length === 3600);

    const none = prepareActionDiff("test", {
      diff: "a".repeat(100),
      availableInputTokens: 2000,
      fileTokens: 0,
      systemPromptEstimate: 2000,
    });
    assert.ok(!none.ok, "any diff fails when the system estimate consumes the whole budget");
  });
});
