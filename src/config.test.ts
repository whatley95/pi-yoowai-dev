import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveTaskModel,
  resolveReviewTaskModel,
  resolveAdvisorTaskModel,
  loadYoowaiConfig,
  resolveJudgeCouncilMembers,
} from "./config.js";
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

describe("resolveAdvisorTaskModel", () => {
  it("uses the advisor override when it exists", () => {
    const config: YoowaiConfig = {
      ...baseConfig,
      taskModels: {
        advisor: { provider: "deepseek", id: "deepseek-v4-flash", thinking: "off" },
        suggest: { provider: "anthropic", id: "claude-sonnet-4" },
      },
    };
    const result = resolveAdvisorTaskModel(config);
    assert.equal(result.provider, "deepseek");
    assert.equal(result.id, "deepseek-v4-flash");
    assert.equal(result.thinking, "off");
  });

  it("falls back to the suggest override when no advisor override exists", () => {
    const config: YoowaiConfig = {
      ...baseConfig,
      taskModels: {
        suggest: { provider: "anthropic", id: "claude-sonnet-4" },
      },
    };
    const result = resolveAdvisorTaskModel(config);
    assert.equal(result.provider, "anthropic");
    assert.equal(result.id, "claude-sonnet-4");
  });

  it("falls back to the base secondary when neither override exists", () => {
    const result = resolveAdvisorTaskModel(baseConfig);
    assert.equal(result.provider, "openai");
    assert.equal(result.id, "gpt-4o-mini");
  });

  it("treats an advisor override with empty provider/id as unset", () => {
    const config: YoowaiConfig = {
      ...baseConfig,
      taskModels: {
        advisor: { provider: "", id: "" },
        suggest: { provider: "anthropic", id: "claude-sonnet-4" },
      },
    };
    const result = resolveAdvisorTaskModel(config);
    assert.equal(result.provider, "anthropic");
    assert.equal(result.id, "claude-sonnet-4");
  });
});

describe("loadYoowaiConfig advisorNotes", () => {
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

  it("defaults to true when unconfigured", () => {
    const cwd = makeTempDir("config-advisor-default-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" } });
    assert.equal(loadYoowaiConfig(cwd).advisorNotes, true);
  });

  it("accepts false (disabled) and true", () => {
    const cwd = makeTempDir("config-advisor-false-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" }, advisorNotes: false });
    assert.equal(loadYoowaiConfig(cwd).advisorNotes, false);

    const cwdT = makeTempDir("config-advisor-true-");
    tmpDirs.push(cwdT);
    writeProjectSettings(cwdT, { secondary: { provider: "openai", id: "gpt-4o" }, advisorNotes: true });
    assert.equal(loadYoowaiConfig(cwdT).advisorNotes, true);
  });

  it("falls back to the default for invalid values", () => {
    for (const invalid of ["yes", 1, null]) {
      const cwd = makeTempDir("config-advisor-invalid-");
      tmpDirs.push(cwd);
      writeProjectSettings(cwd, {
        secondary: { provider: "openai", id: "gpt-4o" },
        advisorNotes: invalid,
      });
      assert.equal(loadYoowaiConfig(cwd).advisorNotes, true, `invalid value ${String(invalid)} should fall back`);
    }
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
    assert.equal(config.noPlanSteerEscalationThreshold, 3);
    assert.equal(config.requireReviewBeforeDone, true);
    assert.equal(config.autoReviewOnSettle, true);
  });

  it("parses the review-enforcement keys", () => {
    const cwd = makeTempDir("config-enforce-parse-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      secondary: { provider: "openai", id: "gpt-4o" },
      steerEscalationThreshold: 5,
      noPlanSteerEscalationThreshold: 5,
      requireReviewBeforeDone: true,
      autoReviewOnSettle: true,
    });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.steerEscalationThreshold, 5);
    assert.equal(config.noPlanSteerEscalationThreshold, 5);
    assert.equal(config.requireReviewBeforeDone, true);
    assert.equal(config.autoReviewOnSettle, true);
  });

  it("rejects invalid review-enforcement values and falls back to defaults", () => {
    const cwd = makeTempDir("config-enforce-invalid-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      secondary: { provider: "openai", id: "gpt-4o" },
      steerEscalationThreshold: -2,
      noPlanSteerEscalationThreshold: -2,
      requireReviewBeforeDone: "yes",
      autoReviewOnSettle: 1,
    });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.steerEscalationThreshold, 3);
    assert.equal(config.noPlanSteerEscalationThreshold, 3);
    assert.equal(config.requireReviewBeforeDone, true);
    assert.equal(config.autoReviewOnSettle, true);
  });
});

describe("loadYoowaiConfig noPlanSteerEscalationThreshold merge", () => {
  const tmpDirs: string[] = [];
  const originalAgentDir = getAgentDir();
  // Isolate from any real global ~/.pi/agent/settings.json.
  const agentDir = mkdtempSync(join(tmpdir(), "config-noplan-agent-"));

  before(() => {
    setAgentDirForTests(() => agentDir);
    // Shared global settings: the inheritance test relies on it, and writing it
    // here keeps both tests independent of execution order.
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        "pi-yoowai": { secondary: { provider: "openai", id: "gpt-4o" }, noPlanSteerEscalationThreshold: 7 },
      }),
      "utf-8",
    );
  });

  after(() => {
    setAgentDirForTests(() => originalAgentDir);
    try {
      rmSync(agentDir, { recursive: true, force: true });
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

  it("lets the project value override the global value", () => {
    const cwd = makeTempDir("config-noplan-override-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      secondary: { provider: "openai", id: "gpt-4o" },
      noPlanSteerEscalationThreshold: 5,
    });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.noPlanSteerEscalationThreshold, 5);
  });

  it("inherits the global value when the project omits the key", () => {
    const cwd = makeTempDir("config-noplan-inherit-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" } });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.noPlanSteerEscalationThreshold, 7);
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

  it("defaults to undefined (level defaults apply) when unconfigured", () => {
    const cwd = makeTempDir("config-codemap-default-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" } });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.codemapMaxTokens, undefined);
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

  it("falls back to undefined (level defaults apply) for invalid values", () => {
    for (const invalid of [-5, 1.5, "lots", NaN]) {
      const cwd = makeTempDir("config-codemap-invalid-");
      tmpDirs.push(cwd);
      writeProjectSettings(cwd, {
        secondary: { provider: "openai", id: "gpt-4o" },
        codemapMaxTokens: invalid,
      });
      assert.equal(loadYoowaiConfig(cwd).codemapMaxTokens, undefined, `invalid value ${invalid} should fall back`);
    }
  });
});

describe("loadYoowaiConfig relatedContextMaxTokens", () => {
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

  it("defaults to undefined (level defaults apply) when unconfigured", () => {
    const cwd = makeTempDir("config-related-default-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" } });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.relatedContextMaxTokens, undefined);
  });

  it("parses a positive integer and accepts 0 (disabled)", () => {
    const cwd = makeTempDir("config-related-parse-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" }, relatedContextMaxTokens: 2500 });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.relatedContextMaxTokens, 2500);

    const cwd0 = makeTempDir("config-related-zero-");
    tmpDirs.push(cwd0);
    writeProjectSettings(cwd0, { secondary: { provider: "openai", id: "gpt-4o" }, relatedContextMaxTokens: 0 });
    assert.equal(loadYoowaiConfig(cwd0).relatedContextMaxTokens, 0);
  });

  it("falls back to undefined for invalid values", () => {
    for (const invalid of [-5, 1.5, "lots", NaN]) {
      const cwd = makeTempDir("config-related-invalid-");
      tmpDirs.push(cwd);
      writeProjectSettings(cwd, {
        secondary: { provider: "openai", id: "gpt-4o" },
        relatedContextMaxTokens: invalid,
      });
      assert.equal(loadYoowaiConfig(cwd).relatedContextMaxTokens, undefined, `invalid ${invalid} should fall back`);
    }
  });
});

describe("loadYoowaiConfig autoPreReviewCommands", () => {
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

  it("defaults to false when unconfigured", () => {
    const cwd = makeTempDir("config-autopre-default-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" } });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.autoPreReviewCommands, false);
  });

  it("parses true/false and rejects non-booleans", () => {
    const cwd = makeTempDir("config-autopre-parse-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" }, autoPreReviewCommands: true });
    assert.equal(loadYoowaiConfig(cwd).autoPreReviewCommands, true);

    const cwdFalse = makeTempDir("config-autopre-false-");
    tmpDirs.push(cwdFalse);
    writeProjectSettings(cwdFalse, { secondary: { provider: "openai", id: "gpt-4o" }, autoPreReviewCommands: "yes" });
    assert.equal(loadYoowaiConfig(cwdFalse).autoPreReviewCommands, false);
  });
});

describe("loadYoowaiConfig instructionsMaxTokens", () => {
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

  it("defaults to 800 when unconfigured", () => {
    const cwd = makeTempDir("config-instructions-default-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" } });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.instructionsMaxTokens, 800);
  });

  it("parses a positive integer and accepts 0 (disabled)", () => {
    const cwd = makeTempDir("config-instructions-parse-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" }, instructionsMaxTokens: 400 });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.instructionsMaxTokens, 400);

    const cwd0 = makeTempDir("config-instructions-zero-");
    tmpDirs.push(cwd0);
    writeProjectSettings(cwd0, { secondary: { provider: "openai", id: "gpt-4o" }, instructionsMaxTokens: 0 });
    assert.equal(loadYoowaiConfig(cwd0).instructionsMaxTokens, 0);
  });

  it("falls back to the default for invalid values", () => {
    for (const invalid of [-5, 1.5, "lots", NaN]) {
      const cwd = makeTempDir("config-instructions-invalid-");
      tmpDirs.push(cwd);
      writeProjectSettings(cwd, {
        secondary: { provider: "openai", id: "gpt-4o" },
        instructionsMaxTokens: invalid,
      });
      assert.equal(loadYoowaiConfig(cwd).instructionsMaxTokens, 800, `invalid value ${invalid} should fall back`);
    }
  });
});

describe("loadYoowaiConfig designRefMaxTokens", () => {
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

  it("defaults to 800 when unconfigured", () => {
    const cwd = makeTempDir("config-designref-default-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" } });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.designRefMaxTokens, 800);
  });

  it("parses a positive integer and accepts 0 (disabled)", () => {
    const cwd = makeTempDir("config-designref-parse-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" }, designRefMaxTokens: 400 });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.designRefMaxTokens, 400);

    const cwd0 = makeTempDir("config-designref-zero-");
    tmpDirs.push(cwd0);
    writeProjectSettings(cwd0, { secondary: { provider: "openai", id: "gpt-4o" }, designRefMaxTokens: 0 });
    assert.equal(loadYoowaiConfig(cwd0).designRefMaxTokens, 0);
  });

  it("falls back to the default for invalid values", () => {
    for (const invalid of [-5, 1.5, "lots", NaN]) {
      const cwd = makeTempDir("config-designref-invalid-");
      tmpDirs.push(cwd);
      writeProjectSettings(cwd, {
        secondary: { provider: "openai", id: "gpt-4o" },
        designRefMaxTokens: invalid,
      });
      assert.equal(loadYoowaiConfig(cwd).designRefMaxTokens, 800, `invalid value ${invalid} should fall back`);
    }
  });
});

describe("loadYoowaiConfig priorReviewMaxTokens", () => {
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

  it("defaults to 800 when unconfigured", () => {
    const cwd = makeTempDir("config-priorreview-default-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" } });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.priorReviewMaxTokens, 800);
  });

  it("parses a positive integer and accepts 0 (disabled)", () => {
    const cwd = makeTempDir("config-priorreview-parse-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, { secondary: { provider: "openai", id: "gpt-4o" }, priorReviewMaxTokens: 400 });

    const config = loadYoowaiConfig(cwd);
    assert.equal(config.priorReviewMaxTokens, 400);

    const cwd0 = makeTempDir("config-priorreview-zero-");
    tmpDirs.push(cwd0);
    writeProjectSettings(cwd0, { secondary: { provider: "openai", id: "gpt-4o" }, priorReviewMaxTokens: 0 });
    assert.equal(loadYoowaiConfig(cwd0).priorReviewMaxTokens, 0);
  });

  it("falls back to the default for invalid values", () => {
    for (const invalid of [-5, 1.5, "lots", NaN]) {
      const cwd = makeTempDir("config-priorreview-invalid-");
      tmpDirs.push(cwd);
      writeProjectSettings(cwd, {
        secondary: { provider: "openai", id: "gpt-4o" },
        priorReviewMaxTokens: invalid,
      });
      assert.equal(loadYoowaiConfig(cwd).priorReviewMaxTokens, 800, `invalid value ${invalid} should fall back`);
    }
  });
});
