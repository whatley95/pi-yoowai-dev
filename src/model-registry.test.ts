import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveModelInfo } from "./model-registry.js";

describe("resolveModelInfo", () => {
  it("returns known Anthropic context window", () => {
    const info = resolveModelInfo("anthropic", "claude-3-5-sonnet");
    assert.equal(info.contextWindow, 200_000);
    assert.equal(info.maxOutputTokens, 8192);
  });

  it("returns known OpenAI context window", () => {
    const info = resolveModelInfo("openai", "gpt-4o");
    assert.equal(info.contextWindow, 128_000);
    assert.equal(info.maxOutputTokens, 16_384);
  });

  it("allows override", () => {
    const info = resolveModelInfo("openai", "gpt-4o", { contextWindow: 64_000, maxOutputTokens: 4096 });
    assert.equal(info.contextWindow, 64_000);
    assert.equal(info.maxOutputTokens, 4096);
  });

  it("falls back to default for unknown models", () => {
    const info = resolveModelInfo("unknown", "custom-model");
    assert.equal(info.contextWindow, 128_000);
    assert.ok(info.maxOutputTokens > 0);
  });

  it("matches longest known prefix", () => {
    const info = resolveModelInfo("openrouter", "deepseek/deepseek-r1-1234");
    assert.equal(info.contextWindow, 64_000);
    assert.equal(info.maxOutputTokens, 8192);
  });

  it("does not match substring in the middle of model id", () => {
    const info = resolveModelInfo("openrouter", "my-claude-3-5-sonnet-custom");
    assert.equal(info.contextWindow, 128_000);
  });
});
