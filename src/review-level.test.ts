import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveReviewLevel, resolveReviewSettings, getReviewLevelSettings } from "./review-level.js";
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
    assert.equal(resolveReviewLevel(config, "high"), "high");
  });

  it("uses the config setting when no tool override", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o-mini", thinking: "off" });
    config.reviewLevel = "min";
    assert.equal(resolveReviewLevel(config), "min");
  });

  it("falls back to the model-derived default", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o-mini", thinking: "off" });
    assert.equal(resolveReviewLevel(config), "min");
  });

  it("falls back to med for unknown models", () => {
    const config = baseConfig({ provider: "unknown", id: "unknown-model", thinking: "off" });
    assert.equal(resolveReviewLevel(config), "med");
  });

  it("uses the effective review task model for defaults", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o", thinking: "medium" });
    config.taskModels = { review: { provider: "anthropic", id: "claude-opus-4-5" } };
    assert.equal(resolveReviewLevel(config), "high");
  });
});

describe("getReviewLevelSettings", () => {
  it("min level sets diff-only and disables codemap", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o", thinking: "medium" });
    const settings = getReviewLevelSettings(config, "min");
    assert.equal(settings.level, "min");
    assert.equal(settings.reviewStrategy, "diff-only");
    assert.equal(settings.selfVerify, false);
    assert.equal(settings.codemapMaxTokens, 0);
    assert.equal(settings.reviewMaxDiffChars, 3000);
  });

  it("med level preserves configured values", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o", thinking: "medium" });
    config.reviewMaxDiffChars = 5000;
    const settings = getReviewLevelSettings(config, "med");
    assert.equal(settings.reviewStrategy, "auto");
    assert.equal(settings.reviewMaxDiffChars, 5000);
    assert.equal(settings.selfVerify, false);
  });

  it("high level enables full-files and self-verify", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o", thinking: "medium" });
    const settings = getReviewLevelSettings(config, "high");
    assert.equal(settings.reviewStrategy, "full-files");
    assert.equal(settings.selfVerify, true);
    assert.equal(settings.reviewMaxConventionsTokens, 1500);
  });

  it("explicit config overrides level defaults", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o", thinking: "medium" });
    config.reviewStrategy = "diff-only";
    config.selfVerify = false;
    config.reviewMaxDiffChars = 999;
    const settings = getReviewLevelSettings(config, "high");
    assert.equal(settings.reviewStrategy, "diff-only");
    assert.equal(settings.selfVerify, false);
    assert.equal(settings.reviewMaxDiffChars, 999);
  });
});

describe("resolveReviewSettings", () => {
  it("combines level resolution and settings application", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o-mini", thinking: "off" });
    const settings = resolveReviewSettings(config);
    assert.equal(settings.level, "min");
    assert.equal(settings.reviewStrategy, "diff-only");
  });

  it("tool override wins over config and model default", () => {
    const config = baseConfig({ provider: "openai", id: "gpt-4o-mini", thinking: "off" });
    config.reviewLevel = "min";
    const settings = resolveReviewSettings(config, "high");
    assert.equal(settings.level, "high");
    assert.equal(settings.reviewStrategy, "full-files");
  });
});
