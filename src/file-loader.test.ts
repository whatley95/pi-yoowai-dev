import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFileContentsForReview, isReviewableFile } from "./file-loader.js";
import type { ReviewBudget } from "./token-budget.js";

describe("file-loader", () => {
  const cwd = mkdtempSync(join(tmpdir(), "yoo-file-test-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/small.ts"), "export function foo() {\n  return 1;\n}\n");
  writeFileSync(join(cwd, "src/large.ts"), Array(500).fill("export const x = 1;").join("\n"));
  writeFileSync(join(cwd, "src/image.png"), "binary");

  const budget: ReviewBudget = {
    contextWindow: 128_000,
    reservedOutputTokens: 8192,
    safetyMarginTokens: 12_800,
    availableInputTokens: 100_000,
  };

  it("excludes non-reviewable files", () => {
    assert.equal(isReviewableFile("src/image.png"), false);
    assert.equal(isReviewableFile("package-lock.json"), false);
    assert.equal(isReviewableFile("src/small.ts"), true);
  });

  it("loads small files in full", () => {
    const result = loadFileContentsForReview({
      cwd,
      changedFiles: ["src/small.ts"],
      budget,
      strategy: "auto",
      fullFileThresholdLines: 300,
    });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].mode, "full");
    assert.ok(result.entries[0].content.includes("foo"));
  });

  it("uses outline for large files", () => {
    const result = loadFileContentsForReview({
      cwd,
      changedFiles: ["src/large.ts"],
      budget,
      strategy: "auto",
      fullFileThresholdLines: 300,
    });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].mode, "outline");
    // Outline must be meaningfully smaller than the full 500-line file.
    assert.ok(result.entries[0].content.length < 500 * "export const x = 1;".length);
  });

  it("returns empty for diff-only strategy", () => {
    const result = loadFileContentsForReview({
      cwd,
      changedFiles: ["src/small.ts"],
      budget,
      strategy: "diff-only",
      fullFileThresholdLines: 300,
    });
    assert.equal(result.entries.length, 0);
  });

  it("clamps total tokens to hard input cap", () => {
    const capped: ReviewBudget = { ...budget, availableInputTokens: 100_000, hardInputCap: 10 };
    const result = loadFileContentsForReview({
      cwd,
      changedFiles: ["src/small.ts", "src/large.ts"],
      budget: capped,
      strategy: "auto",
      fullFileThresholdLines: 300,
    });
    assert.ok(result.totalTokens <= 10);
    assert.ok(result.dropped.length > 0);
  });

  it("drops files outside project root", () => {
    const result = loadFileContentsForReview({
      cwd,
      changedFiles: ["../outside.ts", "src/small.ts"],
      budget,
      strategy: "auto",
      fullFileThresholdLines: 300,
    });
    assert.equal(result.entries.length, 1);
    assert.equal(result.dropped.includes("../outside.ts"), true);
  });

  it("cleans up temp dir", () => {
    rmSync(cwd, { recursive: true, force: true });
    assert.ok(true);
  });
});
