import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveReviewToolContext } from "./review-tool-context.js";
import type { ReviewBudget } from "../token-budget.js";

const cwd = mkdtempSync(join(tmpdir(), "wai-context-capacity-"));
after(() => rmSync(cwd, { recursive: true, force: true }));
const budget: ReviewBudget = {
  contextWindow: 64_000,
  reservedOutputTokens: 2048,
  safetyMarginTokens: 6400,
  availableInputTokens: 54_000,
};
const base = {
  cwd,
  paths: ["pubspec.lock"],
  files: [],
  budget,
  system: "system",
  user: "diff",
  evidenceTokens: 2000,
  maxRequests: 3,
  adaptive: true,
};
writeFileSync(join(cwd, "pubspec.lock"), "x".repeat(55_311));

describe("review context capacity", () => {
  it("reserves sufficient bounded pages for a missing 55 KB file", () => {
    const resolved = resolveReviewToolContext(base);
    assert.equal(resolved.readPageChars, 64_000);
    assert.equal(resolved.maxToolIterations, 3);
    assert.ok(resolved.maxToolContextChars! >= 55_311);
    assert.equal(resolved.maxInputTokens, 55_552);
  });

  it("does not charge the captured diff or complete supplied file against read requests", () => {
    const resolved = resolveReviewToolContext({
      ...base,
      files: [{ file: "pubspec.lock", content: "complete", mode: "full", lineCount: 1, tokenEstimate: 2 }],
    });
    assert.equal(resolved.maxToolIterations, 3);
  });

  it("keeps explicit caps and small-file defaults", () => {
    assert.equal(resolveReviewToolContext({ ...base, adaptive: false }).maxToolIterations, 3);
    writeFileSync(join(cwd, "small.ts"), "export const x = 1;");
    assert.equal(resolveReviewToolContext({ ...base, paths: ["small.ts"] }).maxToolIterations, 3);
  });

  it("accounts for all missing files, deduplicates paths, and caps large inputs", () => {
    writeFileSync(join(cwd, "second.lock"), "y".repeat(55_311));
    assert.equal(
      resolveReviewToolContext({ ...base, paths: ["pubspec.lock", "pubspec.lock", "second.lock"] }).maxToolIterations,
      4,
    );
    writeFileSync(join(cwd, "large.ts"), "z".repeat(1_000_000));
    const largeBudget = { ...budget, contextWindow: 1_000_000, availableInputTokens: 900_000 };
    assert.equal(resolveReviewToolContext({ ...base, paths: ["large.ts"], budget: largeBudget }).maxToolIterations, 18);
  });

  it("respects input headroom and cannot inspect outside-project junctions", () => {
    const constrained = resolveReviewToolContext({ ...base, budget: { ...budget, hardInputCap: 3600 } });
    assert.equal(constrained.maxToolContextChars, 1400);
    assert.equal(constrained.readPageChars, 1400);
    assert.equal(
      resolveReviewToolContext({ ...base, budget: { ...budget, hardInputCap: 1000 } }).maxToolContextChars,
      0,
    );
    const outside = mkdtempSync(join(tmpdir(), "wai-context-outside-"));
    const link = join(cwd, "external");
    try {
      writeFileSync(join(outside, "large.ts"), "PRIVATE".repeat(10_000));
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      assert.equal(
        resolveReviewToolContext({ ...base, paths: ["external/large.ts", "../secret.ts", "deleted.ts"] })
          .maxToolIterations,
        3,
      );
    } finally {
      rmSync(link, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
