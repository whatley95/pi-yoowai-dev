import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPreset, describePreset, formatPresetList, getPreset, listPresets } from "./presets.js";
import { loadYoowaiConfig } from "./config.js";
import { getAgentDir, setAgentDirForTests } from "./pi-paths.js";
import type { YoowaiConfig, YoowaiPreset } from "./types.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const baseConfig: YoowaiConfig = {
  secondary: { provider: "openai", id: "gpt-4o-mini", thinking: "off" },
};

describe("presets", () => {
  const originalAgentDir = getAgentDir();
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      tempDir = undefined;
    }
    setAgentDirForTests(() => originalAgentDir);
  });

  it("lists presets sorted by name", () => {
    const config: YoowaiConfig = {
      ...baseConfig,
      presets: {
        careful: { secondary: { provider: "anthropic", id: "claude-sonnet-4-6" } },
        cheap: { secondary: { provider: "deepseek", id: "deepseek-chat", thinking: "off" } },
      },
    };
    const entries = listPresets(config);
    assert.deepEqual(
      entries.map((e) => e.name),
      ["careful", "cheap"],
    );
    assert.equal(getPreset(config, "cheap")?.secondary?.id, "deepseek-chat");
    assert.equal(getPreset(config, "missing"), undefined);
  });

  it("describes a preset in one line", () => {
    const preset: YoowaiPreset = {
      secondary: { provider: "openai", id: "gpt-5-mini", thinking: "low" },
      taskModels: { review: { provider: "anthropic", id: "claude-sonnet-4-6" } },
    };
    const text = describePreset(preset);
    assert.match(text, /secondary: openai:gpt-5-mini \(low\)/);
    assert.match(text, /taskModels: review/);
  });

  it("formats an empty preset list as no lines", () => {
    assert.deepEqual(formatPresetList(baseConfig), []);
  });

  it("loads presets from project settings and ignores malformed entries", () => {
    tempDir = makeTempDir("wai-preset-config-");
    const piDir = join(tempDir, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "settings.json"),
      JSON.stringify({
        "pi-yoowai": {
          secondary: { provider: "openai", id: "gpt-4o-mini" },
          presets: {
            cheap: { secondary: { provider: "deepseek", id: "deepseek-chat", thinking: "off" } },
            broken: "not-an-object",
            empty: {},
            tasks: { taskModels: { review: { id: "claude-sonnet-4-6" }, bogusTask: { id: "x" } } },
          },
        },
      }),
      "utf-8",
    );
    const config = loadYoowaiConfig(tempDir);
    assert.equal(config.presets?.cheap.secondary?.provider, "deepseek");
    assert.equal(config.presets?.broken, undefined);
    assert.equal(config.presets?.empty, undefined);
    assert.deepEqual(Object.keys(config.presets?.tasks.taskModels ?? {}), ["review"]);
  });

  it("applies a preset to global settings, preserving other keys", () => {
    tempDir = makeTempDir("wai-preset-apply-");
    setAgentDirForTests(() => tempDir!);
    const settingsPath = join(tempDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          "other-extension": { enabled: true },
          "pi-yoowai": {
            autoJudge: true,
            secondary: { provider: "openai", id: "gpt-4o-mini", baseUrl: "https://example.test" },
            taskModels: { scan: { id: "deepseek-chat" } },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const written = applyPreset({
      secondary: { provider: "anthropic", id: "claude-sonnet-4-6" },
      taskModels: { review: { provider: "anthropic", id: "claude-sonnet-4-6" } },
    });
    assert.equal(written, settingsPath);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      "other-extension": { enabled: boolean };
      "pi-yoowai": {
        autoJudge: boolean;
        secondary: Record<string, unknown>;
        taskModels: Record<string, Record<string, unknown>>;
      };
    };
    assert.deepEqual(settings["other-extension"], { enabled: true });
    const wai = settings["pi-yoowai"];
    assert.equal(wai.autoJudge, true);
    // Preset fields override; unrelated secondary fields are preserved.
    assert.equal(wai.secondary.provider, "anthropic");
    assert.equal(wai.secondary.id, "claude-sonnet-4-6");
    assert.equal(wai.secondary.baseUrl, "https://example.test");
    // Existing task overrides are merged, not replaced.
    assert.equal(wai.taskModels.scan.id, "deepseek-chat");
    assert.equal(wai.taskModels.review.provider, "anthropic");
  });

  it("creates the settings file when missing", () => {
    tempDir = makeTempDir("wai-preset-create-");
    setAgentDirForTests(() => tempDir!);
    const settingsPath = join(tempDir, "settings.json");
    assert.equal(existsSync(settingsPath), false);
    applyPreset({ secondary: { provider: "openai", id: "gpt-5-mini" } });
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      "pi-yoowai": { secondary: Record<string, unknown> };
    };
    assert.equal(settings["pi-yoowai"].secondary.id, "gpt-5-mini");
  });
});
