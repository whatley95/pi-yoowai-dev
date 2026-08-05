import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTaskModel, resolveReviewTaskModel, loadYoowaiConfig, resolveJudgeCouncilMembers } from "./config.js";
import { setAgentDirForTests, getAgentDir } from "./pi-paths.js";
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

describe("resolveReviewTaskModel", () => {
  it("uses the per-level override when it exists", () => {
    const config: YoowaiConfig = {
      ...baseConfig,
      taskModels: {
        reviewMin: { provider: "deepseek", id: "deepseek-v4-flash", thinking: "off" },
      },
    };
    const result = resolveReviewTaskModel(config, "min");
    assert.equal(result.provider, "deepseek");
    assert.equal(result.id, "deepseek-v4-flash");
    assert.equal(result.thinking, "off");
  });

  it("falls back to the generic review override when no per-level override exists", () => {
    const config: YoowaiConfig = {
      ...baseConfig,
      taskModels: {
        review: { provider: "anthropic", id: "claude-sonnet-4" },
      },
    };
    const result = resolveReviewTaskModel(config, "high");
    assert.equal(result.provider, "anthropic");
    assert.equal(result.id, "claude-sonnet-4");
  });

  it("falls back to the base secondary when neither override exists", () => {
    const result = resolveReviewTaskModel(baseConfig, "med");
    assert.equal(result.provider, "openai");
    assert.equal(result.id, "gpt-4o-mini");
  });

  it("treats a per-level override with empty provider/id as unset", () => {
    const config: YoowaiConfig = {
      ...baseConfig,
      taskModels: {
        reviewHigh: { provider: "", id: "" },
        review: { provider: "anthropic", id: "claude-sonnet-4" },
      },
    };
    const result = resolveReviewTaskModel(config, "high");
    assert.equal(result.provider, "anthropic");
    assert.equal(result.id, "claude-sonnet-4");
  });

  it("uses the generic review override when no level is given", () => {
    const config: YoowaiConfig = {
      ...baseConfig,
      taskModels: {
        reviewMin: { provider: "deepseek", id: "deepseek-v4-flash" },
        review: { provider: "anthropic", id: "claude-sonnet-4" },
      },
    };
    const result = resolveReviewTaskModel(config);
    assert.equal(result.provider, "anthropic");
    assert.equal(result.id, "claude-sonnet-4");
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
});

describe("loadYoowaiConfig review enforcement", () => {
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

  it("defaults the review-enforcement keys when unconfigured", () => {
    const cwd = makeTempDir("config-enforce-default-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" } });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.steerEscalationThreshold, 3);
    assert.equal(config.requireReviewBeforeDone, true);
    assert.equal(config.autoReviewOnSettle, true);
  });

  it("parses the review-enforcement keys", () => {
    const cwd = makeTempDir("config-enforce-parse-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      secondary: { provider: "openai", id: "gpt-4o" },
      steerEscalationThreshold: 5,
      requireReviewBeforeDone: true,
      autoReviewOnSettle: true,
    });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.steerEscalationThreshold, 5);
    assert.equal(config.requireReviewBeforeDone, true);
    assert.equal(config.autoReviewOnSettle, true);
  });

  it("rejects invalid review-enforcement values and falls back to defaults", () => {
    const cwd = makeTempDir("config-enforce-invalid-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      secondary: { provider: "openai", id: "gpt-4o" },
      steerEscalationThreshold: -2,
      requireReviewBeforeDone: "yes",
      autoReviewOnSettle: 1,
    });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.steerEscalationThreshold, 3);
    assert.equal(config.requireReviewBeforeDone, true);
    assert.equal(config.autoReviewOnSettle, true);
  });
});

describe("loadYoowaiConfig judgeCouncil", () => {
  const tmpDirs: string[] = [];
  const originalAgentDir = getAgentDir();
  // Isolate from any real global ~/.pi/agent/settings.json.
  const emptyAgentDir = mkdtempSync(join(tmpdir(), "config-council-agent-"));

  before(() => {
    setAgentDirForTests(() => emptyAgentDir);
  });

  after(() => {
    setAgentDirForTests(() => originalAgentDir);
    try {
      rmSync(emptyAgentDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("defaults to undefined when not configured", () => {
    const cwd = makeTempDir("config-council-default-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" } });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.judgeCouncil, undefined);
  });

  it("parses provider/model strings, splitting on the first slash", () => {
    const cwd = makeTempDir("config-council-strings-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      secondary: { provider: "openai", id: "gpt-4o" },
      judgeCouncil: ["anthropic/claude-sonnet-4", "openai/gpt-4o", "custom/model/with/slashes"],
    });

    const config = loadYoowaiConfig(cwd);
    assert.deepEqual(config.judgeCouncil, [
      { provider: "anthropic", id: "claude-sonnet-4" },
      { provider: "openai", id: "gpt-4o" },
      { provider: "custom", id: "model/with/slashes" },
    ]);
  });

  it("parses partial secondary config objects", () => {
    const cwd = makeTempDir("config-council-objects-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      secondary: { provider: "openai", id: "gpt-4o" },
      judgeCouncil: [{ provider: "deepseek", id: "deepseek-chat", thinking: "high" }, { id: "gpt-4o-mini" }],
    });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.judgeCouncil?.length, 2);
    assert.equal(config.judgeCouncil?.[0].provider, "deepseek");
    assert.equal(config.judgeCouncil?.[0].id, "deepseek-chat");
    assert.equal(config.judgeCouncil?.[0].thinking, "high");
    assert.equal(config.judgeCouncil?.[1].id, "gpt-4o-mini");
    assert.equal(config.judgeCouncil?.[1].provider, undefined);
  });

  it("drops malformed entries", () => {
    const cwd = makeTempDir("config-council-malformed-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      secondary: { provider: "openai", id: "gpt-4o" },
      judgeCouncil: [
        "anthropic/claude-sonnet-4",
        "",
        "/no-provider",
        "no-id/",
        42,
        null,
        ["nested"],
        {},
        { thinking: "high" },
      ],
    });

    const config = loadYoowaiConfig(cwd);
    assert.deepEqual(config.judgeCouncil, [{ provider: "anthropic", id: "claude-sonnet-4" }]);
  });

  it("treats an empty or fully-invalid array as unconfigured", () => {
    const cwd = makeTempDir("config-council-empty-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      secondary: { provider: "openai", id: "gpt-4o" },
      judgeCouncil: [42, ""],
    });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.judgeCouncil, undefined);
  });

  it("resolves members over the base secondary config", () => {
    const cwd = makeTempDir("config-council-resolve-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      secondary: { provider: "openai", id: "gpt-4o", thinking: "off" },
      judgeCouncil: ["anthropic/claude-sonnet-4", { id: "gpt-4o-mini" }, { thinking: "high" }],
    });

    const config = loadYoowaiConfig(cwd);
    const members = resolveJudgeCouncilMembers(config);
    assert.equal(members.length, 2);
    assert.deepEqual(
      members.map((m) => ({ provider: m.provider, id: m.id })),
      [
        { provider: "anthropic", id: "claude-sonnet-4" },
        { provider: "openai", id: "gpt-4o-mini" },
      ],
    );
    // Inherited fields fall back to secondary.
    assert.equal(members[1].thinking, "off");
  });
});

describe("loadYoowaiConfig codemapMaxTokens", () => {
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

  it("defaults to 1500 when unconfigured", () => {
    const cwd = makeTempDir("config-codemap-default-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" } });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.codemapMaxTokens, 1500);
  });

  it("parses a positive integer and accepts 0 (disabled)", () => {
    const cwd = makeTempDir("config-codemap-parse-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" }, codemapMaxTokens: 500 });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.codemapMaxTokens, 500);

    const cwd0 = makeTempDir("config-codemap-zero-");
    tmpDirs.push(cwd0);
    writeProjectSettings(cwd0, { secondary: { provider: "openai", id: "gpt-4o" }, codemapMaxTokens: 0 });
    assert.equal(loadYoowaiConfig(cwd0).codemapMaxTokens, 0);
  });

  it("falls back to the default for invalid values", () => {
    for (const invalid of [-5, 1.5, "lots", NaN]) {
      const cwd = makeTempDir("config-codemap-invalid-");
      tmpDirs.push(cwd);
      writeProjectSettings(cwd, {
        secondary: { provider: "openai", id: "gpt-4o" },
        codemapMaxTokens: invalid,
      });
      assert.equal(loadYoowaiConfig(cwd).codemapMaxTokens, 1500, `invalid value ${invalid} should fall back`);
    }
  });
});
