import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTaskModel, loadYoowaiConfig } from "./config.js";
import type { YoowaiConfig } from "./types.js";

const baseConfig: YoowaiConfig = {
  secondary: { provider: "openai", id: "gpt-4o-mini", thinking: "off", backend: "pi" },
};

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeProjectSettings(cwd: string, yooSettings: Record<string, unknown>): void {
  const piDir = join(cwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(piDir, "settings.json"), JSON.stringify({ "pi-yoowai": yooSettings }, null, 2), "utf-8");
}

describe("resolveTaskModel", () => {
  it("returns base secondary when no task override exists", () => {
    const result = resolveTaskModel(baseConfig, "review");
    assert.equal(result.provider, "openai");
    assert.equal(result.id, "gpt-4o-mini");
    assert.equal(result.thinking, "off");
    assert.equal(result.backend, "pi");
  });

  it("uses task override fields when present", () => {
    const config: YoowaiConfig = {
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
    const config: YoowaiConfig = {
      ...baseConfig,
      taskModels: { review: { id: "gpt-4o" } },
    };
    const result = resolveTaskModel(config, "review");
    assert.equal(result.provider, "openai");
    assert.equal(result.id, "gpt-4o");
    assert.equal(result.thinking, "off");
  });

  it("ignores overrides for other actions", () => {
    const config: YoowaiConfig = {
      ...baseConfig,
      taskModels: { plan: { provider: "anthropic", id: "claude-sonnet-4" } },
    };
    const result = resolveTaskModel(config, "review");
    assert.equal(result.provider, "openai");
    assert.equal(result.id, "gpt-4o-mini");
  });

  it("applies task-level contextWindow and maxOutputTokens", () => {
    const config: YoowaiConfig = {
      ...baseConfig,
      taskModels: { review: { contextWindow: 128000, maxOutputTokens: 4096 } },
    };
    const result = resolveTaskModel(config, "review");
    assert.equal(result.contextWindow, 128000);
    assert.equal(result.maxOutputTokens, 4096);
    assert.equal(result.provider, "openai");
  });

  it("ignores empty override strings and falls back to base", () => {
    const config: YoowaiConfig = {
      ...baseConfig,
      taskModels: { review: { provider: "", id: "" } },
    };
    const result = resolveTaskModel(config, "review");
    assert.equal(result.provider, "openai");
    assert.equal(result.id, "gpt-4o-mini");
  });

  it("ignores invalid taskModel action keys", () => {
    const config: YoowaiConfig = {
      ...baseConfig,
      taskModels: { revieww: { provider: "anthropic", id: "claude" } } as unknown as YoowaiConfig["taskModels"],
    };
    const result = resolveTaskModel(config, "review");
    assert.equal(result.provider, "openai");
  });

  it("supports done taskModel override", () => {
    const config: YoowaiConfig = {
      ...baseConfig,
      taskModels: { done: { provider: "deepseek", id: "deepseek-chat", thinking: "off" } },
    };
    const result = resolveTaskModel(config, "done");
    assert.equal(result.provider, "deepseek");
    assert.equal(result.id, "deepseek-chat");
    assert.equal(result.thinking, "off");
    assert.equal(result.backend, "pi");
  });

  it("preserves sdk backend override", () => {
    const config: YoowaiConfig = {
      ...baseConfig,
      taskModels: { review: { backend: "sdk" } },
    };
    const result = resolveTaskModel(config, "review");
    assert.equal(result.backend, "sdk");
  });

  it("ignores non-finite numeric overrides", () => {
    const config: YoowaiConfig = {
      ...baseConfig,
      taskModels: { review: { contextWindow: NaN, maxOutputTokens: Infinity } },
    } as unknown as YoowaiConfig;
    const result = resolveTaskModel(config, "review");
    assert.equal(result.contextWindow, undefined);
    assert.equal(result.maxOutputTokens, undefined);
  });

  it("preserves sdk options through task overrides", () => {
    const config: YoowaiConfig = {
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

describe("loadYoowaiConfig docs", () => {
  const tmpDirs: string[] = [];

  after(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("provides default docs config when none is configured", () => {
    const cwd = makeTempDir("config-docs-default-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" } });

    const config = loadYoowaiConfig(cwd);
    assert.ok(config.docs);
    assert.deepEqual(config.docs?.sources, {});
    assert.equal(config.docs?.maxCharsPerSource, 8000);
    assert.equal(config.docs?.webSearch.enabled, false);
    assert.equal(config.docs?.webSearch.maxResults, 3);
    assert.equal(config.docs?.webSearch.maxCharsPerResult, 3000);
  });

  it("merges project docs sources and web search settings", () => {
    const cwd = makeTempDir("config-docs-merge-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      secondary: { provider: "openai", id: "gpt-4o" },
      docs: {
        sources: { react: "https://react.dev" },
        maxCharsPerSource: 5000,
        webSearch: { enabled: true, maxResults: 5, maxCharsPerResult: 1000 },
      },
    });

    const config = loadYoowaiConfig(cwd);
    assert.deepEqual(config.docs?.sources, { react: "https://react.dev" });
    assert.equal(config.docs?.maxCharsPerSource, 5000);
    assert.equal(config.docs?.webSearch.enabled, true);
    assert.equal(config.docs?.webSearch.maxResults, 5);
    assert.equal(config.docs?.webSearch.maxCharsPerResult, 1000);
  });

  it("ignores non-positive integer limits and falls back to defaults", () => {
    const cwd = makeTempDir("config-docs-invalid-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      secondary: { provider: "openai", id: "gpt-4o" },
      docs: {
        maxCharsPerSource: -100,
        webSearch: { enabled: true, maxResults: 0, maxCharsPerResult: 3.5 },
      },
    });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.docs?.maxCharsPerSource, 8000);
    assert.equal(config.docs?.webSearch.maxResults, 3);
    assert.equal(config.docs?.webSearch.maxCharsPerResult, 3000);
  });

  it("ignores invalid source entries", () => {
    const cwd = makeTempDir("config-docs-sources-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      secondary: { provider: "openai", id: "gpt-4o" },
      docs: {
        sources: { react: "https://react.dev", empty: "", invalid: 123 as unknown as string },
      },
    });

    const config = loadYoowaiConfig(cwd);
    assert.deepEqual(config.docs?.sources, { react: "https://react.dev" });
  });

  it("falls back to legacy pi-heyyoo config key", () => {
    const cwd = makeTempDir("config-legacy-key-");
    tmpDirs.push(cwd);
    const piDir = join(cwd, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "settings.json"),
      JSON.stringify({ "pi-heyyoo": { secondary: { provider: "anthropic", id: "claude-sonnet-4" } } }, null, 2),
      "utf-8",
    );

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.secondary.provider, "anthropic");
    assert.equal(config.secondary.id, "claude-sonnet-4");
  });
});
