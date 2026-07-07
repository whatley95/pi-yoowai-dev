import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveTaskModel } from "./config.js";
import type { HeyyooConfig } from "./types.js";

const baseConfig: HeyyooConfig = {
  secondary: { provider: "openai", id: "gpt-4o-mini", thinking: "off", backend: "pi" },
};

describe("resolveTaskModel", () => {
  it("returns base secondary when no task override exists", () => {
    const result = resolveTaskModel(baseConfig, "review");
    assert.equal(result.provider, "openai");
    assert.equal(result.id, "gpt-4o-mini");
    assert.equal(result.thinking, "off");
    assert.equal(result.backend, "pi");
  });

  it("uses task override fields when present", () => {
    const config: HeyyooConfig = {
      ...baseConfig,
      taskModels: {
        review: { provider: "anthropic", id: "claude-sonnet-4", thinking: "medium" },
      },
    };
    const result = resolveTaskModel(config, "review");
    assert.equal(result.provider, "anthropic");
    assert.equal(result.id, "claude-sonnet-4");
    assert.equal(result.thinking, "medium");
    assert.equal(result.backend, "pi");
  });

  it("falls back to base for omitted override fields", () => {
    const config: HeyyooConfig = {
      ...baseConfig,
      taskModels: { review: { id: "gpt-4o" } },
    };
    const result = resolveTaskModel(config, "review");
    assert.equal(result.provider, "openai");
    assert.equal(result.id, "gpt-4o");
    assert.equal(result.thinking, "off");
  });

  it("ignores overrides for other actions", () => {
    const config: HeyyooConfig = {
      ...baseConfig,
      taskModels: { plan: { provider: "anthropic", id: "claude-sonnet-4" } },
    };
    const result = resolveTaskModel(config, "review");
    assert.equal(result.provider, "openai");
    assert.equal(result.id, "gpt-4o-mini");
  });

  it("applies task-level contextWindow and maxOutputTokens", () => {
    const config: HeyyooConfig = {
      ...baseConfig,
      taskModels: { review: { contextWindow: 128000, maxOutputTokens: 4096 } },
    };
    const result = resolveTaskModel(config, "review");
    assert.equal(result.contextWindow, 128000);
    assert.equal(result.maxOutputTokens, 4096);
    assert.equal(result.provider, "openai");
  });

  it("ignores empty override strings and falls back to base", () => {
    const config: HeyyooConfig = {
      ...baseConfig,
      taskModels: { review: { provider: "", id: "" } },
    };
    const result = resolveTaskModel(config, "review");
    assert.equal(result.provider, "openai");
    assert.equal(result.id, "gpt-4o-mini");
  });

  it("ignores invalid taskModel action keys", () => {
    const config: HeyyooConfig = {
      ...baseConfig,
      taskModels: { revieww: { provider: "anthropic", id: "claude" } } as unknown as HeyyooConfig["taskModels"],
    };
    const result = resolveTaskModel(config, "review");
    assert.equal(result.provider, "openai");
  });

  it("preserves sdk backend override", () => {
    const config: HeyyooConfig = {
      ...baseConfig,
      taskModels: { review: { backend: "sdk" } },
    };
    const result = resolveTaskModel(config, "review");
    assert.equal(result.backend, "sdk");
  });

  it("ignores non-finite numeric overrides", () => {
    const config: HeyyooConfig = {
      ...baseConfig,
      taskModels: { review: { contextWindow: NaN, maxOutputTokens: Infinity } },
    } as unknown as HeyyooConfig;
    const result = resolveTaskModel(config, "review");
    assert.equal(result.contextWindow, undefined);
    assert.equal(result.maxOutputTokens, undefined);
  });

  it("preserves sdk options through task overrides", () => {
    const config: HeyyooConfig = {
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        cacheRetention: "short",
        transport: "sse",
        maxRetries: 3,
        maxRetryDelayMs: 1000,
        timeoutMs: 60000,
      },
      taskModels: {
        review: { cacheRetention: "long", maxRetries: 5 },
      },
    };
    const result = resolveTaskModel(config, "review");
    assert.equal(result.cacheRetention, "long");
    assert.equal(result.transport, "sse");
    assert.equal(result.maxRetries, 5);
    assert.equal(result.maxRetryDelayMs, 1000);
    assert.equal(result.timeoutMs, 60000);
  });
});
