import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCacheKey,
  clearReviewCache,
  getCachedReview,
  setCachedResult,
} from "./review-cache.js";
import type { ReviewResult } from "./types.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("review-cache", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempDir("pi-heyyoo-review-cache-");
  });

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("builds stable cache keys", () => {
    const a = buildCacheKey("review", { diff: "abc", description: "x" });
    const b = buildCacheKey("review", { description: "x", diff: "abc" });
    assert.equal(a, b);
    assert.equal(typeof a, "string");
    assert.equal(a.length, 32);
  });

  it("stores and retrieves review results", () => {
    const review: ReviewResult = {
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
    };
    const model = { provider: "openai", id: "gpt-4o" };
    const key = buildCacheKey("review", { diff: "abc" });

    assert.equal(getCachedReview(cwd, key), undefined);

    setCachedResult(cwd, "review", key, { review, model, cost: undefined });
    const cached = getCachedReview(cwd, key);
    assert.ok(cached);
    assert.deepEqual(cached?.review, review);
    assert.deepEqual(cached?.model, model);
  });

  it("clears the cache", () => {
    const review: ReviewResult = {
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
    };
    const key = buildCacheKey("review", { diff: "abc" });
    setCachedResult(cwd, "review", key, { review, model: { provider: "x", id: "y" } });
    clearReviewCache(cwd);
    assert.equal(getCachedReview(cwd, key), undefined);
  });
});
