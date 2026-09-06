import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTRUCTION_ACTIONS,
  MAX_INSTRUCTION_FILE_BYTES,
  capActionInstructions,
  getInstructionFilePath,
  loadActionInstructions,
  resetInstructionsCache,
} from "./instructions.js";
import { buildAdaptiveReviewPrompt } from "./prompts/builders.js";
import { estimateTokens } from "./token-budget.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write an instruction file for an action and force a distinct mtime so the
 *  fingerprint cache cannot accidentally serve stale content. */
function writeInstruction(cwd: string, action: string, content: string, mtimeMs?: number): string {
  const dir = join(cwd, ".pi", "yoowai", "instructions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${action}.md`);
  writeFileSync(path, content, "utf-8");
  if (mtimeMs !== undefined) {
    utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  }
  return path;
}

describe("loadActionInstructions", () => {
  const tmpDirs: string[] = [];

  before(() => {
    resetInstructionsCache();
  });

  after(() => {
    resetInstructionsCache();
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty string when the file is missing", () => {
    const cwd = makeTempDir("wai-inst-missing-");
    tmpDirs.push(cwd);
    assert.equal(loadActionInstructions(cwd, "review"), "");
  });

  it("returns an empty string for an empty file", () => {
    const cwd = makeTempDir("wai-inst-empty-");
    tmpDirs.push(cwd);
    writeInstruction(cwd, "review", "   \n  ");
    assert.equal(loadActionInstructions(cwd, "review"), "");
  });

  it("returns the file content for a valid file", () => {
    const cwd = makeTempDir("wai-inst-valid-");
    tmpDirs.push(cwd);
    writeInstruction(cwd, "review", "# Review rules\n\n- always check auth\n");
    assert.equal(loadActionInstructions(cwd, "review"), "# Review rules\n\n- always check auth");
  });

  it("returns an empty string for unknown actions without touching the filesystem", () => {
    const cwd = makeTempDir("wai-inst-unknown-");
    tmpDirs.push(cwd);
    // Even a crafted action name cannot resolve to a path.
    assert.equal(loadActionInstructions(cwd, "../../etc/passwd"), "");
    assert.equal(loadActionInstructions(cwd, "reviewx"), "");
  });

  it("rejects files larger than the size cap with a warning", () => {
    const cwd = makeTempDir("wai-inst-large-");
    tmpDirs.push(cwd);
    writeInstruction(cwd, "security", "x".repeat(MAX_INSTRUCTION_FILE_BYTES + 1));
    assert.equal(loadActionInstructions(cwd, "security"), "");
  });

  it("serves cached content while the fingerprint is unchanged", () => {
    const cwd = makeTempDir("wai-inst-cache-");
    tmpDirs.push(cwd);
    const mtime = Date.now() - 60_000;
    writeInstruction(cwd, "plan", "version one", mtime);
    assert.equal(loadActionInstructions(cwd, "plan"), "version one");
    // Same mtime + size: the cached string is returned (no re-read visible).
    writeInstruction(cwd, "plan", "version one", mtime);
    assert.equal(loadActionInstructions(cwd, "plan"), "version one");
  });

  it("reloads content when the fingerprint (mtime or size) changes", () => {
    const cwd = makeTempDir("wai-inst-change-");
    tmpDirs.push(cwd);
    writeInstruction(cwd, "judge", "old content", Date.now() - 120_000);
    assert.equal(loadActionInstructions(cwd, "judge"), "old content");
    // Size change alone invalidates the fingerprint.
    writeInstruction(cwd, "judge", "new longer content", Date.now() - 120_000);
    assert.equal(loadActionInstructions(cwd, "judge"), "new longer content");
    // mtime change alone also invalidates it.
    writeInstruction(cwd, "judge", "new longer content", Date.now() - 60_000);
    assert.equal(loadActionInstructions(cwd, "judge"), "new longer content");
  });

  it("recovers after the file is deleted (cache eviction)", () => {
    const cwd = makeTempDir("wai-inst-evict-");
    tmpDirs.push(cwd);
    const path = writeInstruction(cwd, "test", "cached content", Date.now() - 60_000);
    assert.equal(loadActionInstructions(cwd, "test"), "cached content");
    rmSync(path);
    assert.equal(loadActionInstructions(cwd, "test"), "");
  });

  it("exposes the supported action names and file paths", () => {
    const cwd = makeTempDir("wai-inst-paths-");
    tmpDirs.push(cwd);
    assert.ok(INSTRUCTION_ACTIONS.includes("review"));
    assert.ok(INSTRUCTION_ACTIONS.includes("advisor"));
    assert.ok(INSTRUCTION_ACTIONS.includes("planUpdate"));
    assert.ok(INSTRUCTION_ACTIONS.includes("vision"));
    assert.equal(getInstructionFilePath(cwd, "review"), join(cwd, ".pi", "yoowai", "instructions", "review.md"));
  });
});

describe("capActionInstructions", () => {
  const tmpDirs: string[] = [];

  after(() => {
    resetInstructionsCache();
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty string when maxTokens is 0 (disabled)", () => {
    const cwd = makeTempDir("wai-inst-cap0-");
    tmpDirs.push(cwd);
    writeInstruction(cwd, "plan", "some rules");
    assert.equal(capActionInstructions(cwd, "plan", 0), "");
  });

  it("returns the full text when within budget", () => {
    const cwd = makeTempDir("wai-inst-capfull-");
    tmpDirs.push(cwd);
    writeInstruction(cwd, "plan", "short rules here");
    assert.equal(capActionInstructions(cwd, "plan", 1000), "short rules here");
  });

  it("truncates on a whole-line boundary when over budget", () => {
    const cwd = makeTempDir("wai-inst-captrunc-");
    tmpDirs.push(cwd);
    const lines = ["line one", "line two", "line three", "line four"].join("\n");
    writeInstruction(cwd, "plan", lines);
    const capped = capActionInstructions(cwd, "plan", 2);
    // 2 tokens * 4 chars per token = 8 chars — must stop at a newline, so
    // only "line one" (plus nothing partial from "line two") may remain.
    assert.ok(capped.length > 0);
    assert.ok(!capped.includes("line three"));
    assert.ok(capped.endsWith("line one") || capped.endsWith("line two"));
  });

  it("isolation: an action's instruction file never leaks into another action", () => {
    const cwd = makeTempDir("wai-inst-isolation-");
    tmpDirs.push(cwd);
    writeInstruction(cwd, "review", "REVIEW_ONLY_RULE");
    writeInstruction(cwd, "test", "TEST_ONLY_RULE");
    writeInstruction(cwd, "security", "SECURITY_ONLY_RULE");

    const review = capActionInstructions(cwd, "review", 1000);
    assert.ok(review.includes("REVIEW_ONLY_RULE"));
    assert.ok(!review.includes("TEST_ONLY_RULE"), "test rules must not leak into review");
    assert.ok(!review.includes("SECURITY_ONLY_RULE"), "security rules must not leak into review");

    const test = capActionInstructions(cwd, "test", 1000);
    assert.ok(test.includes("TEST_ONLY_RULE"));
    assert.ok(!test.includes("REVIEW_ONLY_RULE"), "review rules must not leak into test");
    assert.ok(!test.includes("SECURITY_ONLY_RULE"));

    const security = capActionInstructions(cwd, "security", 1000);
    assert.ok(security.includes("SECURITY_ONLY_RULE"));
    assert.ok(!security.includes("REVIEW_ONLY_RULE"));
    assert.ok(!security.includes("TEST_ONLY_RULE"));
  });

  it("combined budget: instructions + design rules + conventions + memory stay bounded", () => {
    const cwd = makeTempDir("wai-inst-budget-");
    tmpDirs.push(cwd);
    // Distinct markers per block; each block is LARGER than its configured cap.
    const hugeInstructions = Array.from({ length: 80 }, (_, i) => `I${i}: ${"x".repeat(60)}`).join("\n");
    const hugeConventions = Array.from({ length: 80 }, (_, i) => `C${i}: ${"x".repeat(60)}`).join("\n");
    const hugeMemory = Array.from({ length: 80 }, (_, i) => `M${i}: ${"x".repeat(60)}`).join("\n");
    const hugeDesign = Array.from({ length: 80 }, (_, i) => `D${i}: ${"x".repeat(60)}`).join("\n");
    writeInstruction(cwd, "review", hugeInstructions);
    // The instructions block is capped by capActionInstructions (800 tokens).
    const instructionsText = capActionInstructions(cwd, "review", 800);
    assert.ok(estimateTokens(instructionsText) <= 800, "instructions stay within the configured cap");

    const { system, user } = buildAdaptiveReviewPrompt("desc", "diff", [], {
      instructionsText,
      conventionsText: hugeConventions,
      memoryContext: hugeMemory,
      decisionsText: "",
      designRefText: hugeDesign,
    });
    // Each marker appears in its own prompt location exactly once.
    for (const [marker, prompt] of [
      ["<user_instructions>", system],
      ["<project_conventions>", user],
      ["<memory>", user],
      ["<design_rules>", user],
    ] as const) {
      const count = prompt.split(marker).length - 1;
      assert.equal(count, 1, `${marker} appears exactly once`);
    }
    assert.ok(user.includes("<diff>"), "diff still present");
    // Derived ceiling: base prompt (all blocks empty) + capped instructions + the
    // three uncapped blocks at input size + measured per-block wrapper overhead.
    // The probe isolates the real wrapper cost (section headers + XML tags + join
    // tokens), so the bound follows from measurement, not a magic constant.
    const base = buildAdaptiveReviewPrompt("desc", "diff", [], {});
    const baseTokens = estimateTokens(base.system) + estimateTokens(base.user);
    const oneLine = "probe-line";
    const probed = buildAdaptiveReviewPrompt("desc", "diff", [], {
      instructionsText: oneLine,
      conventionsText: oneLine,
      memoryContext: oneLine,
      designRefText: oneLine,
    });
    const probedTokens = estimateTokens(probed.system) + estimateTokens(probed.user);
    const wrapperOverhead = probedTokens - baseTokens - estimateTokens(oneLine) * 4;
    const ceiling =
      baseTokens +
      800 +
      estimateTokens(hugeConventions) +
      estimateTokens(hugeMemory) +
      estimateTokens(hugeDesign) +
      wrapperOverhead;
    const total = estimateTokens(system) + estimateTokens(user);
    assert.ok(total <= ceiling, `combined prompt stays within derived ceiling (${total} <= ${ceiling})`);
  });
});
