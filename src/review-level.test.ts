import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveReviewLevel,
  resolveReviewSettings,
  getReviewLevelSettings,
  resolveRiskReviewLevel,
} from "./review-level.js";
import type { YoowaiConfig, SecondaryModelConfig } from "./types.js";

function baseConfig(secondary: SecondaryModelConfig): YoowaiConfig {
  return {
    secondary,
    autoJudge: false,
    preReviewCommands: [],
    reviewFullFileThresholdLines: 300,
    reviewMaxConventionsTokens: undefined,
    reviewMaxMemoryTokens: undefined,
    reviewStrategy: undefined,
    verifyDoneClaims: true,
    reviewReminderEdits: 3,
    autoInjectContext: true,
    contextInjectMaxTokens: 800,
    codemapMaxTokens: undefined,
    entryRenderer: true,
    shortcuts: true,
    planWidget: true,
    registerProvider: false,
    steerEscalationThreshold: 3,
    requireReviewBeforeDone: true,
    autoReviewOnSettle: true,
    docs: {
      sources: {},
      maxCharsPerSource: 8000,
      webSearch: { enabled: false, maxResults: 3, maxCharsPerResult: 3000 },
    },
  };
}

describe("resolveReviewLevel", () => {
  it("uses the tool-call override first", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o-mini", thinking: "off" });
    config.reviewLevel = "high";
    for (const level of ["min", "med", "high"] as const) {
      assert.equal(resolveReviewLevel(config, level), level);
    }
  });

  it("uses the config setting when no tool override", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o-mini", thinking: "off" });
    for (const level of ["min", "med", "high"] as const) {
      config.reviewLevel = level;
      assert.equal(resolveReviewLevel(config), level);
    }
  });

  it("defaults to med for cheap, reasoning-heavy, custom, and missing models", () => {
    for (const secondary of [
      { provider: "openai", id: "gpt-4o-mini", thinking: "off" },
      { provider: "openai", id: "gpt-5", thinking: "xhigh" },
      { provider: "anthropic", id: "claude-opus-4-5", thinking: "high" },
      { provider: "deepseek", id: "deepseek-reasoner", thinking: "high" },
      { provider: "unknown", id: "custom-model", thinking: "off" },
      { provider: "", id: "", thinking: "xhigh" },
    ]) {
      assert.equal(resolveReviewLevel(baseConfig(secondary)), "med", secondary.id);
    }
  });

  it("falls back to med for unknown models", () => {
    const config = baseConfig({ provider: "unknown", id: "unknown-model", thinking: "off" });
    assert.equal(resolveReviewLevel(config), "med");
  });

  it("changing the review task model does not change the default depth", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o", thinking: "medium" });
    config.taskModels = { review: { provider: "anthropic", id: "claude-opus-4-5" } };
    assert.equal(resolveReviewLevel(config), "med");
  });
});

describe("resolveRiskReviewLevel", () => {
  const config = {
    ...baseConfig({ provider: "unknown", id: "unknown-model", thinking: "off" }),
    riskBasedReview: true,
  };

  it("deepens sensitive paths, added unsafe code, and truncated diffs", () => {
    assert.equal(resolveRiskReviewLevel(config, undefined, ["src/auth/token.ts"], "+export const token = 1;"), "high");
    assert.equal(
      resolveRiskReviewLevel(config, undefined, ["src\\auth\\token.ts"], "+export const token = 1;"),
      "high",
    );
    assert.equal(resolveRiskReviewLevel(config, undefined, ["src/view.ts"], "+node.innerHTML = value;"), "high");
    assert.equal(resolveRiskReviewLevel(config, undefined, ["src/view.ts"], "", true), "high");
  });

  it("uses a light pass for documentation-only changes and the normal depth for code", () => {
    assert.equal(resolveRiskReviewLevel(config, undefined, ["README.md", "docs/guide.mdx"], "+text"), "min");
    assert.equal(resolveRiskReviewLevel(config, undefined, ["src/view.ts"], "+text"), "med");
  });

  it("routes by evidence rather than a reasoning-heavy review model", () => {
    const strongModelConfig = {
      ...config,
      secondary: { provider: "anthropic", id: "claude-opus-4-5", thinking: "high" },
      taskModels: { review: { provider: "openai", id: "gpt-5", thinking: "xhigh" } },
    };
    assert.equal(resolveRiskReviewLevel(strongModelConfig, undefined, ["README.md"], "+text"), "min");
    assert.equal(resolveRiskReviewLevel(strongModelConfig, undefined, ["src/view.ts"], "+text"), "med");
    assert.equal(resolveRiskReviewLevel(strongModelConfig, undefined, ["src/auth.ts"], "+text"), "high");
  });

  it("honors explicit depth and remains disabled by default", () => {
    assert.equal(resolveRiskReviewLevel(config, "min", ["src/auth.ts"], "+password = value"), "min");
    assert.equal(resolveRiskReviewLevel({ ...config, reviewLevel: "med" }, undefined, ["src/auth.ts"], "+x"), "med");
    assert.equal(
      resolveRiskReviewLevel({ ...config, riskBasedReview: false }, undefined, ["src/auth.ts"], "+x"),
      "med",
    );
  });
});

describe("getReviewLevelSettings", () => {
  it("min level sets diff-only with a compact codemap; no size caps", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o", thinking: "medium" });
    const settings = getReviewLevelSettings(config, "min");
    assert.equal(settings.level, "min");
    assert.equal(settings.reviewStrategy, "diff-only");
    assert.equal(settings.selfVerify, false);
    // Symbol map for changed files + import neighbors; the diff budget deducts
    // the actual rendered length, so the high cap costs nothing on small maps.
    assert.equal(settings.codemapMaxTokens, 20000);
    assert.equal(settings.relatedContextMaxTokens, 1000);
    // Levels are strategy-only: the context-derived budget is the ceiling.
    assert.equal(settings.reviewMaxDiffChars, undefined);
    assert.equal(settings.reviewMaxInputTokens, undefined);
  });

  it("med level defaults to no size caps but a raised codemap", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o", thinking: "medium" });
    const settings = getReviewLevelSettings(config, "med");
    assert.equal(settings.reviewStrategy, "auto");
    assert.equal(settings.reviewMaxDiffChars, undefined);
    assert.equal(settings.reviewMaxInputTokens, undefined);
    assert.equal(settings.codemapMaxTokens, 8000);
    assert.equal(settings.relatedContextMaxTokens, 2500);
    assert.equal(settings.selfVerify, false);
  });

  it("med level preserves configured values", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o", thinking: "medium" });
    config.reviewMaxDiffChars = 5000;
    const settings = getReviewLevelSettings(config, "med");
    assert.equal(settings.reviewStrategy, "auto");
    assert.equal(settings.reviewMaxDiffChars, 5000);
    assert.equal(settings.selfVerify, false);
  });

  it("high level enables full-files and self-verify; no size caps", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o", thinking: "medium" });
    const settings = getReviewLevelSettings(config, "high");
    assert.equal(settings.reviewStrategy, "full-files");
    assert.equal(settings.selfVerify, true);
    assert.equal(settings.reviewMaxConventionsTokens, 1500);
    assert.equal(settings.reviewMaxDiffChars, undefined);
    assert.equal(settings.reviewMaxInputTokens, undefined);
    assert.equal(settings.codemapMaxTokens, 8000);
    assert.equal(settings.relatedContextMaxTokens, 4000);
  });

  it("explicit config overrides level defaults", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o", thinking: "medium" });
    config.reviewStrategy = "diff-only";
    config.selfVerify = false;
    config.reviewMaxDiffChars = 999;
    config.codemapMaxTokens = 0;
    config.relatedContextMaxTokens = 0;
    const settings = getReviewLevelSettings(config, "high");
    assert.equal(settings.reviewStrategy, "diff-only");
    assert.equal(settings.selfVerify, false);
    assert.equal(settings.reviewMaxDiffChars, 999);
    assert.equal(settings.codemapMaxTokens, 0);
    assert.equal(settings.relatedContextMaxTokens, 0);
  });
});

describe("resolveReviewSettings", () => {
  it("combines level resolution and settings application", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o-mini", thinking: "off" });
    const settings = resolveReviewSettings(config);
    assert.equal(settings.level, "med");
    assert.equal(settings.reviewStrategy, "auto");
  });

  it("tool override wins over config and balanced default", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o-mini", thinking: "off" });
    config.reviewLevel = "min";
    const settings = resolveReviewSettings(config, "high");
    assert.equal(settings.level, "high");
    assert.equal(settings.reviewStrategy, "full-files");
  });
});
