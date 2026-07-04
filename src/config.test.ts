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
});
