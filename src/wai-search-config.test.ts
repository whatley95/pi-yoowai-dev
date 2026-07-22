import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleWaiSearchConfigCommand,
  setSearchConfigAgentDirForTests,
  resetSearchConfigAgentDirForTests,
} from "./wai-search-config.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

type MockUI = {
  notifications: Array<{ message: string; level: "info" | "warn" | "error" }>;
  selects: Array<{ title: string; items: string[] }>;
  selectResult?: string;
};

function makeCtx(
  cwd: string,
  ui: MockUI,
): {
  cwd: string;
  ui: {
    notify: (message: string, level?: "info" | "warn" | "error") => void;
    select: (title: string, items: string[]) => Promise<string | undefined>;
  };
} {
  return {
    cwd,
    ui: {
      notify: (message, level = "info") => {
        ui.notifications.push({ message, level });
      },
      select: async (title, items) => {
        ui.selects.push({ title, items });
        return ui.selectResult;
      },
    },
  };
}

function writeProjectSettings(cwd: string, enabled: boolean): void {
  const piDir = join(cwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "settings.json"),
    JSON.stringify({ "pi-yoowai": { docs: { webSearch: { enabled } } } }, null, 2),
    "utf-8",
  );
}

describe("wai-search-config", () => {
  let tmpDirs: string[] = [];
  let agentDir: string;

  before(() => {
    agentDir = makeTempDir("pi-yoowai-agent-");
    setSearchConfigAgentDirForTests(agentDir);
    tmpDirs.push(agentDir);
  });

  after(() => {
    resetSearchConfigAgentDirForTests();
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs = [];
  });

  afterEach(() => {
    resetSearchConfigAgentDirForTests();
    setSearchConfigAgentDirForTests(agentDir);
    const authPath = join(agentDir, "auth.json");
    const settingsPath = join(agentDir, "settings.json");
    try {
      if (existsSync(authPath)) rmSync(authPath, { force: true });
      if (existsSync(settingsPath)) rmSync(settingsPath, { force: true });
    } catch {
      // ignore
    }
  });

  it("saves Brave provider and API key from inline args", async () => {
    const cwd = makeTempDir("wai-search-config-inline-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, true);
    const ui: MockUI = { notifications: [], selects: [] };
    const ctx = makeCtx(cwd, ui);

    const result = await handleWaiSearchConfigCommand(
      "brave brave-api-key-123",
      ctx as unknown as Parameters<typeof handleWaiSearchConfigCommand>[1],
    );

    assert.match(result.content[0].text, /Brave/);
    const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8")) as Record<string, unknown>;
    assert.equal((auth.brave as { type: string; key: string }).type, "api_key");
    assert.equal((auth.brave as { type: string; key: string }).key, "brave-api-key-123");
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as Record<string, unknown>;
    const webSearch = ((settings["pi-yoowai"] as Record<string, unknown>).docs as Record<string, unknown>)
      .webSearch as Record<string, unknown>;
    assert.equal(webSearch.provider, "brave");
  });

  it("switches provider to duckduckgo from inline args", async () => {
    const cwd = makeTempDir("wai-search-config-duck-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, true);
    const ui: MockUI = { notifications: [], selects: [] };
    const ctx = makeCtx(cwd, ui);

    const result = await handleWaiSearchConfigCommand(
      "duckduckgo",
      ctx as unknown as Parameters<typeof handleWaiSearchConfigCommand>[1],
    );

    assert.match(result.content[0].text, /duckduckgo/);
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as Record<string, unknown>;
    const webSearch = ((settings["pi-yoowai"] as Record<string, unknown>).docs as Record<string, unknown>)
      .webSearch as Record<string, unknown>;
    assert.equal(webSearch.provider, "duckduckgo");
  });

  it("returns error when web search is disabled", async () => {
    const cwd = makeTempDir("wai-search-config-disabled-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, false);
    const ui: MockUI = { notifications: [], selects: [] };
    const ctx = makeCtx(cwd, ui);

    const result = await handleWaiSearchConfigCommand(
      "brave key",
      ctx as unknown as Parameters<typeof handleWaiSearchConfigCommand>[1],
    );

    assert.match(result.content[0].text, /disabled/);
    assert.equal(existsSync(join(agentDir, "auth.json")), false);
  });

  it("TUI selects brave and warns when no API key", async () => {
    const cwd = makeTempDir("wai-search-config-tui-brave-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, true);
    const ui: MockUI = { notifications: [], selects: [], selectResult: "Brave Search (API key required)" };
    const ctx = makeCtx(cwd, ui);

    const result = await handleWaiSearchConfigCommand(
      "",
      ctx as unknown as Parameters<typeof handleWaiSearchConfigCommand>[1],
    );

    assert.equal(ui.selects.length, 1);
    assert.match(ui.selects[0].title, /web search provider/i);
    assert.match(result.content[0].text, /Brave/);
    assert.match(result.content[0].text, /API key/);
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as Record<string, unknown>;
    const webSearch = ((settings["pi-yoowai"] as Record<string, unknown>).docs as Record<string, unknown>)
      .webSearch as Record<string, unknown>;
    assert.equal(webSearch.provider, "brave");
  });

  it("TUI selects duckduckgo", async () => {
    const cwd = makeTempDir("wai-search-config-tui-duck-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, true);
    const ui: MockUI = { notifications: [], selects: [], selectResult: "DuckDuckGo (no API key needed)" };
    const ctx = makeCtx(cwd, ui);

    const result = await handleWaiSearchConfigCommand(
      "",
      ctx as unknown as Parameters<typeof handleWaiSearchConfigCommand>[1],
    );

    assert.match(result.content[0].text, /duckduckgo/);
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as Record<string, unknown>;
    const webSearch = ((settings["pi-yoowai"] as Record<string, unknown>).docs as Record<string, unknown>)
      .webSearch as Record<string, unknown>;
    assert.equal(webSearch.provider, "duckduckgo");
  });
});
