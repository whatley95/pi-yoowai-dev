import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { join, resolve } from "node:path";
import { acquireReviewModel, resetReviewModelRouterForTests } from "./review-model-router.js";
import type { ReviewModelLease } from "./review-model-router.js";
import type { YoowaiConfig } from "./types.js";

const project = resolve("router-project");

function config(mode?: YoowaiConfig["reviewLoadBalance"]): YoowaiConfig {
  return {
    secondary: { provider: "openai-codex", id: "gpt-codex", backend: "sdk" },
    reviewAlternates: { review: { provider: "anthropic", id: "claude" } },
    reviewLoadBalance: mode,
  };
}

function chosen(lease: ReviewModelLease): string {
  return lease.models[0].id;
}

describe("review model router", () => {
  beforeEach(() => resetReviewModelRouterForTests());

  it("alternates equal-load reviews by default, retaining round-robin state after release", () => {
    const settings = config();
    const ids: string[] = [];
    for (let round = 0; round < 6; round++) {
      const lease = acquireReviewModel(project, settings, "high");
      ids.push(chosen(lease));
      lease.release();
    }
    assert.deepEqual(ids, ["gpt-codex", "claude", "gpt-codex", "claude", "gpt-codex", "claude"]);
  });

  it("reserves whole reviews synchronously and sends new work to the less busy model", () => {
    const settings = config();
    const slowPrimary = acquireReviewModel(project, settings, "high");
    const fastAlternate = acquireReviewModel(project, settings, "high");
    assert.equal(chosen(slowPrimary), "gpt-codex");
    assert.equal(chosen(fastAlternate), "claude");
    fastAlternate.release();
    const next = acquireReviewModel(project, settings, "high");
    assert.equal(chosen(next), "claude");
    const tied = acquireReviewModel(project, settings, "high");
    assert.equal(chosen(tied), "gpt-codex");
    for (const lease of [slowPrimary, next, tied]) lease.release();
  });

  it("round-robin alternates even when the next model has more active work", () => {
    const settings = config("round-robin");
    const first = acquireReviewModel(project, settings, "high");
    const second = acquireReviewModel(project, settings, "high");
    second.release();
    const third = acquireReviewModel(project, settings, "high");
    assert.equal(chosen(third), "gpt-codex");
    first.release();
    third.release();
  });

  it("failover always prefers the primary and exposes the alternate", () => {
    const settings = config("failover");
    const first = acquireReviewModel(project, settings, "high");
    const second = acquireReviewModel(project, settings, "high");
    assert.deepEqual(
      first.models.map((model) => model.id),
      ["gpt-codex", "claude"],
    );
    assert.equal(chosen(second), "gpt-codex");
    first.release();
    second.release();
  });

  it("orders failover after an alternate is preferred", () => {
    const first = acquireReviewModel(project, config(), "high");
    const second = acquireReviewModel(project, config(), "high");
    assert.deepEqual(
      second.models.map((model) => model.id),
      ["claude", "gpt-codex"],
    );
    first.release();
    second.release();
  });

  it("tracks depths and projects independently and normalizes relative path components", () => {
    const settings = config("round-robin");
    const first = acquireReviewModel(project, settings, "high");
    const normalized = acquireReviewModel(join(project, "nested", ".."), settings, "high");
    const otherDepth = acquireReviewModel(project, settings, "med");
    const otherProject = acquireReviewModel(`${project}-other`, settings, "high");
    assert.equal(chosen(first), "gpt-codex");
    assert.equal(chosen(normalized), "claude");
    assert.equal(chosen(otherDepth), "gpt-codex");
    assert.equal(chosen(otherProject), "gpt-codex");
    for (const lease of [first, normalized, otherDepth, otherProject]) lease.release();
  });

  it("resets selection for changes to candidate identity, credentials, request settings or mode", () => {
    const settings = config("round-robin");
    acquireReviewModel(project, settings, "high").release();
    const changedIdentity = config("round-robin");
    changedIdentity.reviewAlternates!.review!.id = "claude-new";
    const changedCredentials = config("round-robin");
    changedCredentials.secondary.apiKey = "private-test-key";
    const changedThinking = config("round-robin");
    changedThinking.secondary.thinking = "high";
    for (const changed of [changedIdentity, changedCredentials, changedThinking, config("least-busy")]) {
      const lease = acquireReviewModel(project, changed, "high");
      assert.equal(chosen(lease), "gpt-codex");
      lease.release();
    }
  });

  it("does not reset a pool just because equivalent object property order changes", () => {
    const first = acquireReviewModel(project, config("round-robin"), "high");
    first.release();
    const equivalent = config("round-robin");
    equivalent.secondary = { backend: "sdk", id: "gpt-codex", provider: "openai-codex" };
    const second = acquireReviewModel(project, equivalent, "high");
    assert.equal(chosen(second), "claude");
    second.release();
  });

  it("moves the whole-review reservation on failover and releases the active model once", () => {
    const settings = config();
    const failed = acquireReviewModel(project, settings, "high");
    failed.activate(1);
    failed.activate(1);
    const whileRetrying = acquireReviewModel(project, settings, "high");
    assert.equal(chosen(whileRetrying), "gpt-codex");
    failed.release();
    failed.release();
    failed.activate(0);
    const afterRetry = acquireReviewModel(project, settings, "high");
    assert.equal(chosen(afterRetry), "claude");
    afterRetry.release();
    whileRetrying.release();
    const allReleased = acquireReviewModel(project, settings, "high");
    assert.equal(chosen(allReleased), "gpt-codex");
    allReleased.release();
  });

  it("uses the lease candidate order when moving from an alternate back to primary", () => {
    const settings = config();
    const primary = acquireReviewModel(project, settings, "high");
    const alternate = acquireReviewModel(project, settings, "high");
    alternate.activate(1);
    const next = acquireReviewModel(project, settings, "high");
    assert.equal(chosen(next), "claude");
    for (const lease of [primary, alternate, next]) lease.release();
  });

  it("rejects invalid candidate indices without losing the original reservation", () => {
    const settings = config();
    const first = acquireReviewModel(project, settings, "high");
    for (const index of [-1, 2, 0.5, Number.NaN]) {
      assert.throws(() => first.activate(index), RangeError);
    }
    const second = acquireReviewModel(project, settings, "high");
    assert.equal(chosen(second), "claude");
    first.release();
    second.release();
  });

  it("supports a single model, including repeated activation and release", () => {
    const settings: YoowaiConfig = { secondary: { provider: "anthropic", id: "claude" } };
    for (let round = 0; round < 3; round++) {
      const lease = acquireReviewModel(project, settings, "min");
      assert.deepEqual(lease.models, [settings.secondary]);
      lease.activate(0);
      lease.release();
      lease.release();
    }
  });

  it("keeps existing review reservations independent when settings change in flight", () => {
    const oldSettings = config();
    const old = acquireReviewModel(project, oldSettings, "high");
    const updated = config();
    updated.secondary.timeoutMs = 12_000;
    const current = acquireReviewModel(project, updated, "high");
    old.release();
    const currentNext = acquireReviewModel(project, updated, "high");
    assert.equal(chosen(currentNext), "claude");
    current.release();
    currentNext.release();
  });

  it("preserves active pools through idle eviction", () => {
    const settings = config();
    const held = acquireReviewModel(project, settings, "high");
    for (let index = 0; index < 300; index++) {
      acquireReviewModel(`${project}-${index}`, settings, "high").release();
    }
    const next = acquireReviewModel(project, settings, "high");
    assert.equal(chosen(next), "claude");
    held.release();
    next.release();
  });
});
