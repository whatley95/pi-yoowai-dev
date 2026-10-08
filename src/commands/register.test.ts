import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert";
import {
  computeThinkingLevels,
  resolveThinkingLevelOptions,
  resolveModelThinkingDetails,
  findModelThinkingDetails,
  formatModelItem,
  parseModelIdFromItem,
  groupModelsByPrefix,
  pickModelFromFlatList,
  pickModelFromProvider,
  pickRecentModel,
  promptSearchModels,
  buildModelConfigEntry,
  buildReviewLevelItems,
  buildReviewModelItems,
  formatCouncilSynthesisModel,
  parseReviewLevelItem,
  isScopeConfigured,
  buildModelScopeOptions,
  resetModelSelection,
  parseLanguageCommandArgs,
  applyLanguageSetting,
  registerWaiCommands,
  type ModelRef,
} from "./register.js";
import { loadYoowaiConfig } from "../config.js";
import { setSdkGetModelOverride } from "../backends/sdk-backend.js";
import { getAgentDir, setAgentDirForTests } from "../pi-paths.js";
import { setPlan, dropSessionState, getState } from "../session-state.js";
import { buildPlanView } from "../plan-view.js";
import { getSessionCost } from "../cost-tracker.js";
import { setSearchFnForTests, resetSearchFnForTests } from "../doc-fetcher.js";
import type { SearchResults } from "duck-duck-scrape";
import type { RecentModel } from "../model-history.js";
import type { YoowaiConfig } from "../types.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer } from "node:http";

const canonicalLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function fakeContext(
  selectQueue: (string | undefined)[] = [],
  inputQueue: (string | undefined)[] = [],
): ExtensionContext {
  return {
    ui: {
      select: async () => {
        const next = selectQueue.shift();
        return next ?? undefined;
      },
      input: async () => {
        const next = inputQueue.shift();
        return next ?? undefined;
      },
      notify: () => {},
    },
  } as unknown as ExtensionContext;
}

describe("parseLanguageCommandArgs", () => {
  it("returns usage for empty input", () => {
    assert.deepStrictEqual(parseLanguageCommandArgs("   "), { kind: "usage" });
  });

  it("parses reset case-insensitively", () => {
    assert.deepStrictEqual(parseLanguageCommandArgs("RESET"), { kind: "reset" });
  });

  it("treats multiword input as one language name", () => {
    assert.deepStrictEqual(parseLanguageCommandArgs("  Latin American Spanish "), {
      kind: "set",
      language: "Latin American Spanish",
    });
  });
});

describe("applyLanguageSetting", () => {
  it("sets, persists, and resets only the language key", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wai-language-agent-"));
    try {
      const settingsPath = join(agentDir, "settings.json");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({ other: 1, "pi-yoowai": { secondary: { provider: "p", id: "m" } } }),
        "utf-8",
      );

      applyLanguageSetting(settingsPath, "set", "French");
      const afterSet = JSON.parse(readFileSync(settingsPath, "utf-8"));
      assert.equal(afterSet["pi-yoowai"].language, "French");
      assert.equal(afterSet.other, 1);
      assert.ok(afterSet["pi-yoowai"].secondary);

      applyLanguageSetting(settingsPath, "reset");
      const afterReset = JSON.parse(readFileSync(settingsPath, "utf-8"));
      assert.ok(!("language" in afterReset["pi-yoowai"]));
      assert.equal(afterReset.other, 1);
      assert.ok(afterReset["pi-yoowai"].secondary);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("throws on set with an empty language and leaves the file unchanged", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wai-language-agent-"));
    try {
      const settingsPath = join(agentDir, "settings.json");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ "pi-yoowai": { language: "French" } }), "utf-8");

      assert.throws(() => applyLanguageSetting(settingsPath, "set", "   "));
      const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
      assert.equal(after["pi-yoowai"].language, "French");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("creates the agent directory when missing", () => {
    const agentDir = join(tmpdir(), `wai-language-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const settingsPath = join(agentDir, "settings.json");
      applyLanguageSetting(settingsPath, "set", "French");
      const afterSet = JSON.parse(readFileSync(settingsPath, "utf-8"));
      assert.equal(afterSet["pi-yoowai"].language, "French");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe("/wai-language handler", () => {
  const originalAgentDir = getAgentDir();
  const tmpDirs: string[] = [];

  const makeTemp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  };

  after(() => {
    setAgentDirForTests(() => originalAgentDir);
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  type CapturedCommand = { description: string; handler: (args: string, ctx: unknown) => Promise<void> };

  function captureWaiCommands(): Map<string, CapturedCommand> {
    const commands = new Map<string, CapturedCommand>();
    const pi = {
      registerCommand: (name: string, def: CapturedCommand) => {
        commands.set(name, def);
      },
    } as unknown as ExtensionAPI;
    registerWaiCommands(pi, new Map());
    return commands;
  }

  function makeCtx(cwd: string, notifications: string[]): unknown {
    return { cwd, ui: { notify: (msg: string) => notifications.push(msg) } };
  }

  describe("/wai-plan command", () => {
    function makeNotifyCtx(cwd: string, notifications: string[]): unknown {
      return {
        cwd,
        ui: {
          notify: (message: string) => notifications.push(message),
        },
      };
    }

    it("registers /wai-plan between /wai and /wai-status", () => {
      const commands = captureWaiCommands();
      const order = [...commands.keys()];
      const wai = order.indexOf("wai");
      const plan = order.indexOf("wai-plan");
      const status = order.indexOf("wai-status");
      assert.ok(wai >= 0 && plan >= 0 && status >= 0, "all three commands must be registered");
      assert.ok(
        wai < plan && plan < status,
        `wai-plan must sit between /wai and /wai-status (got: ${order.join(", ")})`,
      );
      assert.match(commands.get("wai-plan")!.description, /plan/);
    });

    it("/wai-status renders diagnostics on the timeline surface (no picker)", async () => {
      const cwd = makeTemp("wai-status-notify-");
      mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
      const handler = captureWaiCommands().get("wai-status")!.handler;
      const notifications: string[] = [];
      let selectInvoked = false;
      const ctx = {
        cwd,
        ui: {
          notify: (message: string) => notifications.push(message),
          select: async () => {
            selectInvoked = true;
            return undefined;
          },
        },
      };
      await handler("", ctx);

      assert.equal(selectInvoked, false, "/wai-status must not open the select picker anymore");
      assert.equal(notifications.length, 1);
      const text = notifications[0]!;
      assert.match(text, /pi-yoowai v/, "the first diagnostic section (version header) must lead the notification");
      assert.match(text, /Session:/, "the session section must be present");
      assert.match(text, /Project conventions:/, "the last diagnostic section must be present");
    });

    it("/wai-index renders on the timeline (no picker)", async () => {
      const cwd = makeTemp("wai-index-notify-");
      mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
      const handler = captureWaiCommands().get("wai-index")!.handler;
      const notifications: string[] = [];
      await handler("plan", {
        cwd,
        ui: { notify: (message: string) => notifications.push(message) },
      });
      assert.equal(notifications.length, 1);
      assert.ok(notifications[0]!.length > 0, "the index result text must be notified");
    });

    it("/wai-search renders on the timeline (no picker)", async () => {
      const cwd = makeTemp("wai-search-notify-");
      mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
      // Web search is opt-in per project: enable it for this fixture.
      writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({ "pi-yoowai": { docs: { webSearch: { enabled: true } } } }),
        "utf-8",
      );
      setSearchFnForTests(
        async () =>
          ({
            noResults: false,
            results: [{ title: "React Hooks", url: "https://react.dev/reference/react", description: "Official docs" }],
          }) as unknown as SearchResults,
      );
      const handler = captureWaiCommands().get("wai-search")!.handler;
      const notifications: string[] = [];
      try {
        await handler("react hooks", {
          cwd,
          ui: { notify: (message: string) => notifications.push(message) },
        });
      } finally {
        resetSearchFnForTests();
      }
      assert.equal(notifications.length, 1);
      assert.ok(notifications[0]!.includes("react.dev"), "the search result must be notified on the timeline");
    });

    it("renders the no-plan message when no plan is active", async () => {
      const cwd = makeTemp("wai-plan-noplan-");
      mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
      const handler = captureWaiCommands().get("wai-plan")!.handler;
      const notifications: string[] = [];
      await handler("", makeNotifyCtx(cwd, notifications));

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0], "No active plan.");
    });

    it("notifies the full plan view for an active plan (timeline surface, not the picker)", async () => {
      const cwd = makeTemp("wai-plan-active-");
      mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
      setPlan(cwd, {
        summary: "Ship the feature",
        todo: ["build it", "review it"],
        acceptanceCriteria: ["tests pass"],
      });
      // Nonzero pending edits: proves the handler forwards the edit tracker's
      // count into the renderer (the review-pending line only renders then).
      // getEditTracker returns a copy, so set the live state directly.
      getState(cwd).editsSinceLastReview = 3;
      const handler = captureWaiCommands().get("wai-plan")!.handler;
      const notifications: string[] = [];
      await handler("", makeNotifyCtx(cwd, notifications));

      assert.equal(notifications.length, 1, "the handler must present exactly one notification");
      const expected = buildPlanView(getState(cwd), getSessionCost(cwd), { unreviewedEdits: 3 });
      assert.deepEqual(
        notifications[0]!.split(String.fromCharCode(10)),
        expected,
        "rendered lines must match the renderer output exactly",
      );
      assert.ok(notifications[0]!.includes("1. → build it"));
      assert.ok(notifications[0]!.includes("2. · review it"));
      assert.ok(notifications[0]!.includes("⚠ review pending: 3 edits"));
      dropSessionState(cwd);
    });
  });

  it("empty input shows usage and performs no write", async () => {
    const agentDir = makeTemp("wai-language-handler-agent-");
    setAgentDirForTests(() => agentDir);
    const cwd = makeTemp("wai-language-handler-cwd-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });

    const handler = captureWaiCommands().get("wai-language")!.handler;
    const notifications: string[] = [];
    await handler("   ", makeCtx(cwd, notifications));

    assert.ok(notifications.some((n) => n.includes("Usage: /wai-language")));
    assert.ok(!existsSync(join(agentDir, "settings.json")));
  });

  it("set persists a multiword language visible to a fresh config load", async () => {
    const agentDir = makeTemp("wai-language-handler-agent-");
    setAgentDirForTests(() => agentDir);
    const cwd = makeTemp("wai-language-handler-cwd-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });

    const handler = captureWaiCommands().get("wai-language")!.handler;
    const notifications: string[] = [];
    await handler("Latin American Spanish", makeCtx(cwd, notifications));

    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    assert.equal(settings["pi-yoowai"].language, "Latin American Spanish");
    assert.equal(loadYoowaiConfig(cwd).language, "Latin American Spanish");
    assert.ok(notifications.some((n) => n.includes('Language set to "Latin American Spanish"')));
  });

  it("warns when a project-level language overrides the global value", async () => {
    const agentDir = makeTemp("wai-language-handler-agent-");
    setAgentDirForTests(() => agentDir);
    const cwd = makeTemp("wai-language-handler-cwd-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { language: "Japanese" } }));

    const handler = captureWaiCommands().get("wai-language")!.handler;
    const notifications: string[] = [];
    await handler("French", makeCtx(cwd, notifications));

    assert.ok(notifications.some((n) => n.includes("project-level override is active: Japanese")));
  });

  it("reset clears only the language key and preserves unrelated settings", async () => {
    const agentDir = makeTemp("wai-language-handler-agent-");
    setAgentDirForTests(() => agentDir);
    const cwd = makeTemp("wai-language-handler-cwd-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const settingsPath = join(agentDir, "settings.json");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ other: 1, "pi-yoowai": { language: "French", reviewLevel: "med" } }),
      "utf-8",
    );

    const handler = captureWaiCommands().get("wai-language")!.handler;
    const notifications: string[] = [];
    await handler("reset", makeCtx(cwd, notifications));

    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.ok(!("language" in after["pi-yoowai"]));
    assert.equal(after.other, 1);
    assert.equal(after["pi-yoowai"].reviewLevel, "med");
    assert.ok(notifications.some((n) => n.includes("Language cleared")));
  });
});

describe("computeThinkingLevels", () => {
  it("returns only off for non-reasoning models", () => {
    assert.deepStrictEqual(computeThinkingLevels({ reasoning: false }, canonicalLevels), ["off"]);
  });

  it("returns null only when the model is entirely unknown", () => {
    assert.strictEqual(computeThinkingLevels(undefined, canonicalLevels), null);
  });

  it("treats a missing reasoning flag as non-reasoning (mirrors pi-ai)", () => {
    assert.deepStrictEqual(computeThinkingLevels({}, canonicalLevels), ["off"]);
  });

  it("offers the default reasoning set for reasoning models with no map (OpenRouter case)", () => {
    assert.deepStrictEqual(computeThinkingLevels({ reasoning: true }, canonicalLevels), [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("drops null-mapped levels, including off itself (gpt-5 case)", () => {
    const modelDetails = {
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: "minimal",
        low: "low",
        medium: null,
        high: "high",
        xhigh: null,
        max: null,
      } as Record<string, string | null>,
    };
    assert.deepStrictEqual(computeThinkingLevels(modelDetails, canonicalLevels), ["minimal", "low", "high"]);
  });

  it("includes unmapped mid levels by default but requires explicit xhigh/max mappings", () => {
    const modelDetails = {
      reasoning: true,
      thinkingLevelMap: { off: null, high: "high", max: "max" } as Record<string, string | null>,
    };
    assert.deepStrictEqual(computeThinkingLevels(modelDetails, canonicalLevels), [
      "minimal",
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("returns only off when every other level is unsupported", () => {
    const modelDetails = {
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      } as Record<string, string | null>,
    };
    assert.deepStrictEqual(computeThinkingLevels(modelDetails, canonicalLevels), ["off"]);
  });
});

describe("resolveThinkingLevelOptions", () => {
  it("returns advertised levels when a thinkingLevelMap is present", () => {
    const modelDetails = {
      reasoning: true,
      thinkingLevelMap: { off: null, high: "high", max: "max" } as Record<string, string | null>,
    };
    assert.deepStrictEqual(resolveThinkingLevelOptions(modelDetails, canonicalLevels, "xhigh"), [
      "minimal",
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("offers the default reasoning set for map-less reasoning models (OpenRouter case)", () => {
    assert.deepStrictEqual(resolveThinkingLevelOptions({ reasoning: true }, canonicalLevels, "xhigh"), [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("never offers guessed levels when capability metadata is unavailable", () => {
    assert.deepStrictEqual(resolveThinkingLevelOptions(undefined, canonicalLevels, "xhigh"), []);
    assert.deepStrictEqual(resolveThinkingLevelOptions(undefined, canonicalLevels, "off"), []);
    assert.deepStrictEqual(resolveThinkingLevelOptions({}, canonicalLevels, "high"), ["off"]);
  });
});

function fakeSdkModel(thinkingLevelMap?: Record<string, string | null>, reasoning = true) {
  return {
    id: "m",
    name: "m",
    api: "openai",
    provider: "p",
    baseUrl: "",
    reasoning,
    thinkingLevelMap,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

describe("findModelThinkingDetails", () => {
  const live = {
    provider: "openai-codex",
    id: "gpt-6-astra",
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh", max: "max" },
  };
  const other = { provider: "openai", id: "gpt-6-astra", reasoning: false };

  it("uses the live find lookup and honors GPT-6 levels", () => {
    const registry = {
      find: () => live,
      getAvailable: () => [other],
    } as never;
    const details = findModelThinkingDetails(registry, live.provider, live.id);
    assert.deepStrictEqual(computeThinkingLevels(details, canonicalLevels), [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("takes a custom live Sol model's explicit capabilities without guessing from its name", () => {
    // This is a custom-provider fixture, NOT an assertion about built-in GPT-6 Sol support.
    const sol = {
      provider: "custom-gateway",
      id: "gpt-6-sol",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, xhigh: null, max: "max" },
    };
    const registry = { find: () => sol, getAvailable: () => [sol] } as never;
    assert.deepStrictEqual(
      computeThinkingLevels(findModelThinkingDetails(registry, sol.provider, sol.id), canonicalLevels),
      ["high", "max"],
    );
  });

  it("looks up exact provider and id in getAll on older hosts", () => {
    const registry = { getAll: () => [other, live], getAvailable: () => [] } as never;
    assert.deepStrictEqual(
      computeThinkingLevels(findModelThinkingDetails(registry, live.provider, live.id), canonicalLevels),
      ["minimal", "low", "medium", "high", "xhigh", "max"],
    );
    assert.deepStrictEqual(
      computeThinkingLevels(findModelThinkingDetails(registry, other.provider, other.id), canonicalLevels),
      ["off"],
    );
    assert.strictEqual(findModelThinkingDetails(registry, "opencode-go", live.id), undefined);
  });

  it("uses static catalog for legacy provider/id-only registry entries", async () => {
    const registry = { getAvailable: () => [{ provider: "openai-codex", id: "gpt-6-astra" }] } as never;
    const liveDetails = findModelThinkingDetails(registry, "openai-codex", "gpt-6-astra");
    assert.strictEqual(liveDetails, undefined);
    setSdkGetModelOverride(() => fakeSdkModel({ off: null, xhigh: "xhigh" }) as never);
    try {
      const details = await resolveModelThinkingDetails("openai-codex", "gpt-6-astra", liveDetails);
      assert.deepStrictEqual(computeThinkingLevels(details, canonicalLevels), [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
    } finally {
      setSdkGetModelOverride(null);
    }
  });

  it("supports getAvailable-only hosts and ignores malformed map values", () => {
    const registry = {
      getAvailable: () => [{ ...live, thinkingLevelMap: { off: null, max: 42, xhigh: "xhigh" } }],
    } as never;
    assert.deepStrictEqual(
      computeThinkingLevels(findModelThinkingDetails(registry, live.provider, live.id), canonicalLevels),
      ["minimal", "low", "medium", "high", "xhigh"],
    );
  });
});

describe("resolveModelThinkingDetails", () => {
  it("prefers the live registry map over the static SDK catalog", async () => {
    setSdkGetModelOverride(() => fakeSdkModel({ off: null, high: "high", max: "max" }) as never);
    try {
      const details = await resolveModelThinkingDetails("deepseek", "deepseek-chat", {
        reasoning: true,
        thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
      });
      assert.deepStrictEqual(computeThinkingLevels(details, canonicalLevels), [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
    } finally {
      setSdkGetModelOverride(null);
    }
  });

  it("does not replace a live model without a map with static catalog metadata", async () => {
    setSdkGetModelOverride(() => fakeSdkModel(undefined) as never);
    try {
      const details = await resolveModelThinkingDetails("deepseek", "deepseek-chat", { reasoning: true });
      assert.deepStrictEqual(computeThinkingLevels(details, canonicalLevels), [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
      ]);
    } finally {
      setSdkGetModelOverride(null);
    }
  });

  it("returns live registry details when SDK catalog is unavailable", async () => {
    setSdkGetModelOverride(() => {
      throw new Error("no sdk");
    });
    try {
      const registryMap = { off: null, max: "max" } as Record<string, string | null>;
      const details = await resolveModelThinkingDetails("deepseek", "deepseek-chat", {
        reasoning: true,
        thinkingLevelMap: registryMap,
      });
      assert.deepStrictEqual(details?.thinkingLevelMap, registryMap);
    } finally {
      setSdkGetModelOverride(null);
    }
  });
});

describe("isScopeConfigured", () => {
  const baseConfigured = { secondary: { provider: "openai", id: "gpt-4o" }, taskModels: {} };
  const taskConfigured = {
    secondary: { provider: "openai", id: "gpt-4o" },
    taskModels: { review: { provider: "anthropic", id: "claude" } },
  };

  it("marks Base as current only when the base secondary is set", () => {
    assert.strictEqual(isScopeConfigured("Base secondary model", baseConfigured), true);
    assert.strictEqual(isScopeConfigured("Base secondary model", { secondary: { provider: "", id: "" } }), false);
  });

  it("marks a task scope current only when that task override is set (independent of base)", () => {
    assert.strictEqual(isScopeConfigured("review", taskConfigured), true);
    assert.strictEqual(isScopeConfigured("suggest", taskConfigured), false);
    // Base configured but no task override: task scope is NOT current.
    assert.strictEqual(isScopeConfigured("review", baseConfigured), false);
  });
});

describe("model role display", () => {
  it("keeps council synthesis out of the general role picker and shows its separate use", () => {
    const config: YoowaiConfig = {
      secondary: { provider: "openai", id: "base-model" },
      taskModels: { judge: { id: "synthesis-model" } },
      judgeCouncil: [],
    };
    const row = () => formatCouncilSynthesisModel(config);
    assert.ok(!buildModelScopeOptions(config).some((scope) => scope.task === "judge"));
    assert.match(row(), /openai:synthesis-model.*unused until two or more members/);
    config.judgeCouncil = [{ id: "member-model", thinking: "low" }];
    assert.match(row(), /openai:synthesis-model.*unused until two or more members/);
    config.judgeCouncil.push({ id: "other-member" });
    assert.match(row(), /openai:synthesis-model.*combines council results/);
  });

  it("keeps non-review roles and omits every review role even with saved review overrides", () => {
    const config: YoowaiConfig = {
      secondary: { provider: "openai", id: "base-model" },
      reviewLevel: "high",
      taskModels: {
        suggest: { id: "advice-model", thinking: "low" },
        review: { id: "general-review" },
        reviewHigh: { id: "deep-review" },
        test: { thinking: "off" },
      },
    };
    const scopes = buildModelScopeOptions(config);
    const row = (task: string) => scopes.find((scope) => scope.task === task)!.text;
    assert.match(row("advisor"), /openai:advice-model.*low.*via suggest/);
    assert.ok(!row("advisor").includes("✓ configured"));
    assert.ok(scopes.every((scope) => !scope.task?.startsWith("review")));
    assert.ok(
      scopes.some((scope) => !scope.task),
      "keep the base model option",
    );
    assert.deepStrictEqual(config.taskModels?.review, { id: "general-review" });
    assert.deepStrictEqual(config.taskModels?.reviewHigh, { id: "deep-review" });
    assert.ok(row("test").includes("✓ configured"), "thinking-only overrides must be visible and resettable");
    assert.match(row("plan"), /also plan updates/);
    assert.match(row("explain"), /also deep fact verification/);
    assert.match(row("done"), /when enabled/);
    assert.ok(scopes.every((scope) => !scope.text.includes(" only")));
  });
});

describe("effective model requests in commands", () => {
  const originalAgentDir = getAgentDir();
  afterEach(() => setAgentDirForTests(() => originalAgentDir));

  for (const task of ["reviewMin", "REVIEWMED", "reviewhigh", "advisor", "review", "judge", "judge-disabled", ""]) {
    it(`/wai-test ${task} calls the effective model and endpoint`, async () => {
      const agentDir = mkdtempSync(join(tmpdir(), "wai-routing-agent-"));
      const cwd = mkdtempSync(join(tmpdir(), "wai-routing-cwd-"));
      const bodies: Array<{ model: string }> = [];
      const server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => {
          bodies.push(JSON.parse(body));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "wai connection OK" } }] }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        setAgentDirForTests(() => agentDir);
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const baseUrl = `http://127.0.0.1:${address.port}`;
        writeFileSync(
          join(agentDir, "settings.json"),
          JSON.stringify({
            "pi-yoowai": {
              secondary: {
                provider: "openai",
                id: "base-model",
                backend: "http",
                baseUrl: task ? "http://127.0.0.1:9" : baseUrl,
                apiKey: "test-key",
                thinking: "off",
              },
              reviewLevel: "high",
              judgeCouncil: task === "judge" ? [{ id: "final-member", baseUrl }] : [],
              taskModels: {
                review: { id: "review-fallback", baseUrl },
                reviewMed: { id: "medium-review", baseUrl },
                reviewHigh: { id: "deep-review", baseUrl },
                suggest: { id: "suggest-fallback", baseUrl },
              },
            },
          }),
        );
        const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
        registerWaiCommands(
          {
            registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
              commands.set(name, def),
          } as unknown as ExtensionAPI,
          new Map(),
        );
        const notifications: string[] = [];
        const ctx = {
          cwd,
          ui: { notify: (message: string) => notifications.push(message), setStatus: () => {} },
        } as unknown as ExtensionContext;
        await commands.get("wai-test")!.handler(task === "judge-disabled" ? "judge" : task, ctx);
        if (task === "judge-disabled") {
          assert.equal(bodies.length, 0);
          assert.ok(notifications.some((message) => message.includes("disabled") && message.includes("skipped")));
          return;
        }
        const expected =
          task === "reviewMin"
            ? "review-fallback"
            : task === "REVIEWMED"
              ? "medium-review"
              : task === "advisor"
                ? "suggest-fallback"
                : task === "judge"
                  ? "final-member"
                  : "deep-review";
        assert.deepStrictEqual(
          bodies.map((body) => body.model),
          task ? [expected] : ["base-model", "deep-review", "review-fallback", "medium-review", "suggest-fallback"],
        );
        assert.ok(
          notifications.some((message) => message.includes("wai-test OK")),
          notifications.join("\n"),
        );
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        rmSync(agentDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  for (const task of ["advisor", "reviewMin", "review"]) {
    const command = task === "advisor" ? "wai-model" : "wai-review-model";
    it(`/${command} preselects the effective ${task} model`, async () => {
      const agentDir = mkdtempSync(join(tmpdir(), "wai-picker-routing-"));
      const cwd = mkdtempSync(join(tmpdir(), "wai-picker-cwd-"));
      try {
        setAgentDirForTests(() => agentDir);
        const settingsPath = join(agentDir, "settings.json");
        const settings = JSON.stringify({
          "pi-yoowai": {
            secondary: { provider: "base-provider", id: "base-model", thinking: "off" },
            reviewLevel: "high",
            taskModels: {
              suggest: { provider: "selected-provider", id: "selected-model" },
              review: { provider: "selected-provider", id: "selected-model" },
              reviewHigh: { provider: "selected-provider", id: "selected-model" },
            },
          },
        });
        writeFileSync(settingsPath, settings);
        const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
        registerWaiCommands(
          {
            registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
              commands.set(name, def),
          } as unknown as ExtensionAPI,
          new Map(),
        );
        const models = [
          { provider: "base-provider", id: "base-model" },
          { provider: "selected-provider", id: "selected-model", reasoning: false },
        ];
        let providers: string[] = [];
        let modelItems: string[] = [];
        const ctx = {
          cwd,
          modelRegistry: {
            getAll: () => models,
            getAvailable: () => models,
            getProviderAuthStatus: () => ({ configured: true }),
            find: () => models[1],
          },
          ui: {
            notify: () => {},
            select: async (title: string, items: string[]) => {
              if (title.startsWith("Which wai model role")) return items.find((item) => item.startsWith(`${task} (`));
              if (title.startsWith("Pick provider")) {
                providers = items;
                return items.find((item) => item.includes("✓ current"));
              }
              if (title.startsWith("Pick model")) {
                modelItems = items;
                return undefined;
              }
              return undefined;
            },
          },
        } as unknown as ExtensionContext;
        await commands.get(command)!.handler(task === "reviewMin" ? "min" : task === "review" ? "all" : "", ctx);
        assert.ok(providers.some((item) => item.startsWith("selected-provider") && item.includes("✓ current")));
        assert.ok(modelItems.includes("selected-model ✓ current"));
        assert.equal(readFileSync(settingsPath, "utf-8"), settings, "cancelling must preserve settings");
      } finally {
        rmSync(agentDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});

describe("/wai-model dedicated menu separation", () => {
  for (const args of [
    "",
    "reset",
    "reset REVIEW",
    "reset REVIEWMIN",
    "reset REVIEWMED",
    "reset REVIEWHIGH",
    "reset JUDGE",
    "save base",
  ]) {
    it(`keeps review and council settings in their dedicated commands: ${args || "picker"}`, async () => {
      const agentDir = mkdtempSync(join(tmpdir(), "wai-separated-picker-agent-"));
      const cwd = mkdtempSync(join(tmpdir(), "wai-separated-picker-cwd-"));
      const previousAgentDir = getAgentDir();
      try {
        setAgentDirForTests(() => agentDir);
        const settingsPath = join(agentDir, "settings.json");
        const initial = {
          "pi-yoowai": {
            secondary: { provider: "picker", id: "base", thinking: "off" },
            reviewLevel: "auto",
            riskBasedReview: true,
            taskModels: {
              review: { id: "shared" },
              reviewMin: { id: "quick" },
              reviewMed: { id: "balanced" },
              reviewHigh: { id: "deep" },
              suggest: { id: "advisor" },
              judge: { id: "synthesizer" },
            },
          },
        };
        const initialText = JSON.stringify(initial);
        writeFileSync(settingsPath, initialText);
        const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
        registerWaiCommands(
          {
            registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
              commands.set(name, def),
          } as unknown as ExtensionAPI,
          new Map(),
        );
        const model = { provider: "picker", id: "next", reasoning: false };
        const notifications: string[] = [];
        let rolesShown = false;
        const ctx = {
          cwd,
          modelRegistry: {
            getAll: () => [model],
            getAvailable: () => [model],
            getProviderAuthStatus: () => ({ configured: true }),
            find: () => model,
          },
          ui: {
            notify: (text: string) => notifications.push(text),
            select: async (title: string, items: string[]) => {
              if (title.startsWith("Which wai model role") || title === "Reset which model selection?") {
                rolesShown = true;
                assert.ok(!items.some((item) => /^review(?:Min|Med|High)?\s*\(/.test(item)), items.join("\n"));
                assert.ok(!items.some((item) => item.startsWith("judge (")), items.join("\n"));
                assert.ok(items.some((item) => item.startsWith("Base secondary model")));
                assert.ok(items.some((item) => item.startsWith("suggest (")));
                return args === "save base" ? items.find((item) => item.startsWith("Base secondary model")) : undefined;
              }
              if (title.startsWith("Pick model") || title.startsWith("Pick thinking")) return items[0];
              throw new Error(`Unexpected picker: ${title}`);
            },
          },
        } as unknown as ExtensionContext;
        await commands.get("wai-model")!.handler(args === "save base" ? "picker" : args, ctx);
        const saved = JSON.parse(readFileSync(settingsPath, "utf8"))["pi-yoowai"];
        assert.deepStrictEqual(saved.taskModels, initial["pi-yoowai"].taskModels);
        assert.equal(saved.reviewLevel, "auto");
        assert.equal(saved.riskBasedReview, true);
        if (args === "save base") {
          assert.equal(saved.secondary.id, "next", notifications.join("\n"));
        } else {
          assert.equal(readFileSync(settingsPath, "utf8"), initialText);
        }
        if (args === "" || args === "reset" || args === "save base") {
          assert.ok(rolesShown, "exercise the real registered picker");
        } else {
          assert.equal(rolesShown, false);
          const target = args === "reset REVIEW" ? "all" : args.slice("reset REVIEW".length).toLowerCase();
          assert.ok(
            notifications.some((text) =>
              args === "reset JUDGE"
                ? text.includes("/wai-council") && text.includes("Reset synthesis model")
                : text.includes(`/wai-review-model reset ${target}`),
            ),
            notifications.join("\n"),
          );
        }
      } finally {
        setAgentDirForTests(() => previousAgentDir);
        for (const dir of [agentDir, cwd]) {
          assert.equal(dirname(realpathSync(dir)), realpathSync(tmpdir()));
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  }
});

describe("review picker automatic mode", () => {
  for (const scenario of ["automatic", "project override", "cancel"] as const) {
    it(`persists review selection safely: ${scenario}`, async () => {
      const agentDir = mkdtempSync(join(tmpdir(), "wai-auto-picker-agent-"));
      const cwd = mkdtempSync(join(tmpdir(), "wai-auto-picker-cwd-"));
      const previousAgentDir = getAgentDir();
      try {
        setAgentDirForTests(() => agentDir);
        const settingsPath = join(agentDir, "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            unrelated: 42,
            "pi-yoowai": {
              secondary: { provider: "picker", id: "model", thinking: "off" },
              reviewLevel: "high",
              riskBasedReview: true,
            },
          }),
        );
        const projectSettings = JSON.stringify({ "pi-yoowai": { reviewLevel: "high" } });
        if (scenario === "project override") {
          mkdirSync(join(cwd, ".pi"));
          writeFileSync(join(cwd, ".pi", "settings.json"), projectSettings);
        }
        const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
        registerWaiCommands(
          {
            registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
              commands.set(name, def),
          } as unknown as ExtensionAPI,
          new Map(),
        );
        const model = { provider: "picker", id: "model", reasoning: false };
        const notifications: string[] = [];
        const ctx = {
          cwd,
          modelRegistry: {
            getAll: () => [model],
            getAvailable: () => [model],
            getProviderAuthStatus: () => ({ configured: true }),
            find: () => model,
          },
          ui: {
            notify: (text: string) => notifications.push(text),
            select: async (title: string, items: string[]) => {
              if (title.startsWith("Pick model") || title.startsWith("Pick thinking")) return items[0];
              if (title === "Pick default review level:")
                return scenario === "cancel" ? undefined : items.find((item) => item.startsWith("Automatic"));
              throw new Error(`Unexpected picker: ${title}`);
            },
          },
        } as unknown as ExtensionContext;
        await commands.get("wai-review-model")!.handler("all picker", ctx);
        const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
        assert.equal(saved.unrelated, 42);
        assert.equal(saved["pi-yoowai"].reviewLevel, scenario === "cancel" ? "high" : "auto", notifications.join("\n"));
        assert.equal(saved["pi-yoowai"].riskBasedReview, true);
        assert.equal(saved["pi-yoowai"].taskModels.review.id, "model");
        assert.equal(loadYoowaiConfig(cwd).reviewLevel, scenario === "automatic" ? "auto" : "high");
        if (scenario === "project override") {
          assert.ok(notifications.some((text) => text.includes("project-level override remains active")));
          assert.equal(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"), projectSettings);
        }
      } finally {
        setAgentDirForTests(() => previousAgentDir);
        for (const dir of [agentDir, cwd]) {
          assert.equal(dirname(realpathSync(dir)), realpathSync(tmpdir()));
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  }
});

describe("/wai-review-model", () => {
  for (const scenario of [
    "shared",
    "min",
    "med",
    "high",
    "max",
    "provider filter",
    "cancel model",
    "cancel thinking",
    "cancel level",
    "project override",
    "reset shared",
    "reset med",
    "reset invalid",
    "nested reset",
  ] as const) {
    it(`manages review settings directly: ${scenario}`, async () => {
      const agentDir = mkdtempSync(join(tmpdir(), "wai-review-picker-agent-"));
      const cwd = mkdtempSync(join(tmpdir(), "wai-review-picker-cwd-"));
      const previousAgentDir = getAgentDir();
      try {
        setAgentDirForTests(() => agentDir);
        const settingsPath = join(agentDir, "settings.json");
        const initial = {
          unrelated: 42,
          "pi-yoowai": {
            secondary: { provider: "picker", id: "base", thinking: "off" },
            reviewLevel: "high",
            riskBasedReview: true,
            judgeCouncil: ["picker/council"],
            taskModels: {
              review: { provider: "picker", id: "shared", backend: "http", baseUrl: "https://example.invalid" },
              reviewMed: { provider: "picker", id: "medium" },
              reviewHigh: { provider: "picker", id: "deep" },
              plan: { provider: "picker", id: "planner" },
            },
          },
        };
        const initialText = JSON.stringify(initial);
        writeFileSync(settingsPath, initialText);
        const projectSettings = JSON.stringify({ "pi-yoowai": { taskModels: { review: { id: "project" } } } });
        if (scenario === "project override") {
          mkdirSync(join(cwd, ".pi"));
          writeFileSync(join(cwd, ".pi", "settings.json"), projectSettings);
        }
        const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
        registerWaiCommands(
          {
            registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
              commands.set(name, def),
          } as unknown as ExtensionAPI,
          new Map(),
        );
        const models = ["base", "shared", "medium", "deep", "next", "project"].map((id) => ({
          provider: "picker",
          id,
          reasoning: false,
        }));
        const notifications: string[] = [];
        const titles: string[] = [];
        let modelItems: string[] = [];
        const ctx = {
          cwd,
          // Reset must work even without the registry or provider credentials.
          modelRegistry: scenario.startsWith("reset")
            ? undefined
            : {
                getAll: () => models,
                getAvailable: () => models,
                getProviderAuthStatus: () => ({ configured: true }),
                find: (provider: string, id: string) =>
                  models.find((model) => model.provider === provider && model.id === id),
              },
          ui: {
            notify: (text: string) => notifications.push(text),
            select: async (title: string, items: string[]) => {
              titles.push(title);
              if (title.startsWith("Pick model")) {
                modelItems = items;
                return scenario === "cancel model" ? undefined : items.find((item) => item.startsWith("next"));
              }
              if (title.startsWith("Pick thinking")) return scenario === "cancel thinking" ? undefined : items[0];
              if (title === "Pick default review level:")
                return scenario === "cancel level" ? undefined : items.find((item) => item.startsWith("Automatic"));
              throw new Error(`Unexpected picker: ${title}`);
            },
          },
        } as unknown as ExtensionContext;
        const args =
          scenario === "reset shared"
            ? "reset"
            : scenario === "reset med"
              ? "reset MED"
              : scenario === "reset invalid"
                ? "reset base"
                : scenario === "nested reset"
                  ? "all reset base"
                  : scenario === "provider filter"
                    ? 'all picker "next"'
                    : ["min", "med", "high", "max"].includes(scenario)
                      ? `${scenario} picker`
                      : "all";
        await commands.get("wai-review-model")!.handler(args, ctx);
        assert.ok(!titles.some((title) => title.includes("Which wai model role")), "must skip the general role menu");
        const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
        const wai = saved["pi-yoowai"];
        assert.equal(saved.unrelated, 42);
        assert.deepStrictEqual(wai.secondary, initial["pi-yoowai"].secondary);
        assert.deepStrictEqual(wai.judgeCouncil, initial["pi-yoowai"].judgeCouncil);
        assert.deepStrictEqual(wai.taskModels.plan, initial["pi-yoowai"].taskModels.plan);
        assert.equal(wai.riskBasedReview, true);
        if (
          scenario === "cancel model" ||
          scenario === "cancel thinking" ||
          scenario === "reset invalid" ||
          scenario === "nested reset"
        ) {
          assert.equal(readFileSync(settingsPath, "utf8"), initialText, notifications.join("\n"));
          if (scenario === "reset invalid" || scenario === "nested reset")
            assert.ok(notifications.some((text) => text.startsWith("Usage:")));
          return;
        }
        if (scenario.startsWith("reset")) {
          const task = scenario === "reset med" ? "reviewMed" : "review";
          assert.equal(wai.taskModels[task], undefined);
          assert.equal(wai.reviewLevel, "high");
          assert.ok(notifications.some((text) => text.includes("Global task model override")));
          assert.ok(
            notifications.some((text) =>
              text.includes(scenario === "reset med" ? "med: picker:shared" : "min: picker:base"),
            ),
          );
        } else {
          const task =
            scenario === "min"
              ? "reviewMin"
              : scenario === "med"
                ? "reviewMed"
                : scenario === "high" || scenario === "max"
                  ? "reviewHigh"
                  : "review";
          assert.equal(wai.taskModels[task].id, "next", notifications.join("\n"));
          for (const other of ["review", "reviewMed", "reviewHigh"] as const) {
            if (other !== task) assert.deepStrictEqual(wai.taskModels[other], initial["pi-yoowai"].taskModels[other]);
          }
          const isShared = task === "review";
          assert.equal(titles.includes("Pick default review level:"), isShared);
          assert.equal(wai.reviewLevel, isShared && scenario !== "cancel level" ? "auto" : "high");
          if (isShared) {
            assert.equal(wai.taskModels.review.baseUrl, "https://example.invalid");
            assert.equal(wai.taskModels.review.backend, "http");
          }
          if (scenario === "shared") {
            assert.ok(modelItems.includes("shared ✓ current"), "mark the edited fallback, not the high override");
            assert.ok(
              notifications.some((text) => text.includes("high: picker:deep") && text.includes("via reviewHigh")),
            );
          }
          if (scenario === "provider filter") assert.ok(!modelItems.some((item) => item.startsWith("shared")));
          if (scenario === "project override") {
            assert.ok(modelItems.includes("project ✓ current"));
            assert.ok(notifications.some((text) => text.includes("min: picker:project")));
            assert.equal(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"), projectSettings);
          }
        }
        assert.ok(
          notifications.some((text) => text.includes("Effective review models")),
          notifications.join("\n"),
        );
      } finally {
        setAgentDirForTests(() => previousAgentDir);
        for (const dir of [agentDir, cwd]) {
          assert.equal(dirname(realpathSync(dir)), realpathSync(tmpdir()));
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  }
});

describe("review model overview", () => {
  it("shows three effective depths first, then shared fallback, mode, and reset", () => {
    const items = buildReviewModelItems({
      secondary: { provider: "picker", id: "base", thinking: "off" },
      reviewLevel: "auto",
      taskModels: { review: { id: "shared" }, reviewHigh: { id: "deep", thinking: "high" } },
    });
    assert.deepStrictEqual(
      items.map((item) => item.target),
      ["reviewMin", "reviewMed", "reviewHigh", "review", "level", "reset"],
    );
    assert.match(items[0].text, /^review-min: picker:shared.*off.*via review/);
    assert.match(items[1].text, /^review-med: picker:shared.*via review/);
    assert.match(items[2].text, /^review-max \(high\): picker:deep.*high.*via reviewHigh.*✓ configured/);
    assert.match(items[3].text, /^Shared fallback: picker:shared/);
    assert.match(items[4].text, /automatic.*med default/);
    assert.ok(!items[0].text.includes("✓ configured"), "inherited models have no own override marker");
  });

  it("shows unset reviewers without requiring a registry", () => {
    const items = buildReviewModelItems({ secondary: { provider: "", id: "" } });
    assert.ok(items.slice(0, 4).every((item) => item.text.includes("not configured")));
  });

  for (const scenario of [
    "cancel",
    "min",
    "med",
    "high",
    "shared",
    "mode",
    "mode cancel",
    "reset med",
    "reset cancel",
    "project",
    "provider filter",
    "no registry",
  ] as const) {
    it(`opens the depth overview and refreshes after changes: ${scenario}`, async () => {
      const agentDir = mkdtempSync(join(tmpdir(), "wai-overview-agent-"));
      const cwd = mkdtempSync(join(tmpdir(), "wai-overview-cwd-"));
      const previousAgentDir = getAgentDir();
      try {
        setAgentDirForTests(() => agentDir);
        const settingsPath = join(agentDir, "settings.json");
        const initial = {
          unrelated: 42,
          "pi-yoowai": {
            secondary: { provider: "picker", id: "base", thinking: "off" },
            reviewLevel: "high",
            riskBasedReview: true,
            judgeCouncil: ["picker/council"],
            taskModels: {
              review: { provider: "picker", id: "shared" },
              reviewMin: { provider: "picker", id: "quick" },
              reviewMed: { provider: "picker", id: "medium" },
              reviewHigh: { provider: "picker", id: "deep" },
              plan: { provider: "picker", id: "planner" },
            },
          },
        };
        const initialText = JSON.stringify(initial);
        writeFileSync(settingsPath, initialText);
        const projectText = JSON.stringify({
          "pi-yoowai": { taskModels: { reviewMed: { id: "project" } }, reviewLevel: "high" },
        });
        if (scenario === "project") {
          mkdirSync(join(cwd, ".pi"));
          writeFileSync(join(cwd, ".pi", "settings.json"), projectText);
        }
        const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
        registerWaiCommands(
          {
            registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
              commands.set(name, def),
          } as unknown as ExtensionAPI,
          new Map(),
        );
        const models = ["base", "shared", "quick", "medium", "deep", "next", "project"].map((id) => ({
          provider: "picker",
          id,
          reasoning: false,
        }));
        const notifications: string[] = [];
        const titles: string[] = [];
        const snapshots: string[][] = [];
        const ctx = {
          cwd,
          modelRegistry:
            scenario === "no registry"
              ? undefined
              : {
                  getAll: () => models,
                  getAvailable: () => models,
                  getProviderAuthStatus: () => ({ configured: true }),
                  find: (provider: string, id: string) =>
                    models.find((model) => model.provider === provider && model.id === id),
                },
          ui: {
            notify: (text: string) => notifications.push(text),
            select: async (title: string, items: string[]) => {
              titles.push(title);
              if (title.startsWith("Review models (")) {
                snapshots.push(items);
                assert.ok(items[0].startsWith("review-min:"));
                assert.ok(items[1].startsWith("review-med:"));
                assert.ok(items[2].startsWith("review-max (high):"));
                if (snapshots.length > 1 || scenario === "cancel" || scenario === "no registry") return undefined;
                const prefix = scenario.startsWith("reset")
                  ? "Reset a review"
                  : scenario.startsWith("mode") || scenario === "project"
                    ? "Review mode:"
                    : scenario === "shared"
                      ? "Shared fallback:"
                      : scenario === "min"
                        ? "review-min:"
                        : scenario === "high"
                          ? "review-max (high):"
                          : "review-med:";
                return items.find((item) => item.startsWith(prefix));
              }
              if (title === "Reset which review model override?")
                return scenario === "reset cancel" ? undefined : items.find((item) => item.startsWith("review-med:"));
              if (title.startsWith("Pick model")) return items.find((item) => item.startsWith("next"));
              if (title.startsWith("Pick thinking")) return items[0];
              if (title === "Pick default review level:")
                return scenario === "mode cancel" ? undefined : items.find((item) => item.startsWith("Automatic"));
              throw new Error(`Unexpected picker: ${title}`);
            },
          },
        } as unknown as ExtensionContext;
        await commands.get("wai-review-model")!.handler(scenario === "provider filter" ? 'picker "next"' : "", ctx);
        const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
        const wai = saved["pi-yoowai"];
        assert.equal(saved.unrelated, 42);
        assert.deepStrictEqual(wai.secondary, initial["pi-yoowai"].secondary);
        assert.deepStrictEqual(wai.judgeCouncil, initial["pi-yoowai"].judgeCouncil);
        assert.deepStrictEqual(wai.taskModels.plan, initial["pi-yoowai"].taskModels.plan);
        assert.equal(wai.riskBasedReview, true);
        assert.equal(wai.taskModels.reviewMax, undefined, "max maps to the existing high depth");
        assert.ok(!titles.some((title) => title.startsWith("Which wai model role")));
        if (["cancel", "no registry", "mode cancel", "reset cancel"].includes(scenario)) {
          assert.equal(readFileSync(settingsPath, "utf8"), initialText, notifications.join("\n"));
          assert.equal(snapshots.length, scenario === "cancel" || scenario === "no registry" ? 1 : 2);
          if (scenario === "no registry") assert.deepStrictEqual(notifications, []);
          return;
        }
        assert.equal(snapshots.length, 2, "return to the fresh overview after editing");
        if (scenario === "mode" || scenario === "project") {
          assert.deepStrictEqual(wai.taskModels, initial["pi-yoowai"].taskModels);
          assert.equal(wai.reviewLevel, "auto");
          assert.ok(!titles.some((title) => title.startsWith("Pick model") || title.startsWith("Pick thinking")));
          assert.ok(
            snapshots[1]
              .find((item) => item.startsWith("Review mode:"))
              ?.includes(scenario === "project" ? "high" : "automatic"),
          );
          if (scenario === "project") {
            assert.ok(snapshots[0][1].includes("picker:project"));
            assert.ok(notifications.some((text) => text.includes("project-level review mode override")));
            assert.equal(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"), projectText);
          }
        } else if (scenario === "reset med") {
          assert.equal(wai.taskModels.reviewMed, undefined);
          assert.deepStrictEqual(wai.taskModels.reviewHigh, initial["pi-yoowai"].taskModels.reviewHigh);
          assert.equal(wai.reviewLevel, "high");
          assert.ok(snapshots[1][1].includes("picker:shared") && snapshots[1][1].includes("via review"));
        } else {
          const task =
            scenario === "min"
              ? "reviewMin"
              : scenario === "high"
                ? "reviewHigh"
                : scenario === "shared"
                  ? "review"
                  : "reviewMed";
          assert.equal(wai.taskModels[task].id, "next", notifications.join("\n"));
          for (const other of ["review", "reviewMin", "reviewMed", "reviewHigh"] as const) {
            if (other !== task) assert.deepStrictEqual(wai.taskModels[other], initial["pi-yoowai"].taskModels[other]);
          }
          assert.equal(wai.reviewLevel, scenario === "shared" ? "auto" : "high");
          assert.ok(snapshots[1].some((item) => item.includes("picker:next")));
          assert.equal(titles.includes("Pick default review level:"), scenario === "shared");
        }
      } finally {
        setAgentDirForTests(() => previousAgentDir);
        for (const dir of [agentDir, cwd]) {
          assert.equal(dirname(realpathSync(dir)), realpathSync(tmpdir()));
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  }
});

describe("buildModelConfigEntry", () => {
  it("preserves existing provider-specific fields when re-selecting the same provider", () => {
    const prev = {
      provider: "opencode-custom",
      id: "old/model",
      thinking: "xhigh",
      baseUrl: "https://x/v1",
      style: "openai-compatible",
      backend: "http",
    };
    const entry = buildModelConfigEntry(prev, { provider: "opencode-custom", id: "new/model", thinking: "high" });
    assert.strictEqual(entry.baseUrl, "https://x/v1");
    assert.strictEqual(entry.style, "openai-compatible");
    assert.strictEqual(entry.backend, "http");
    assert.strictEqual(entry.provider, "opencode-custom");
    assert.strictEqual(entry.id, "new/model");
    assert.strictEqual(entry.thinking, "high");
  });

  it("drops all provider-specific fields when the provider changes", () => {
    const prev = {
      provider: "openai",
      id: "gpt-4o",
      thinking: "xhigh",
      baseUrl: "https://x/v1",
      style: "openai-compatible",
      authHeader: "X",
      authPrefix: "Y",
      apiKey: "secret",
      backend: "http",
      transport: "sse",
      cacheRetention: "short",
      contextWindow: 128000,
      maxOutputTokens: 8192,
      maxRetries: 3,
      maxRetryDelayMs: 1000,
      timeoutMs: 300000,
    };
    const entry = buildModelConfigEntry(prev, { provider: "anthropic", id: "claude", thinking: "high" });
    for (const key of [
      "baseUrl",
      "style",
      "authHeader",
      "authPrefix",
      "apiKey",
      "backend",
      "transport",
      "cacheRetention",
      "contextWindow",
      "maxOutputTokens",
      "maxRetries",
      "maxRetryDelayMs",
      "timeoutMs",
    ]) {
      assert.strictEqual(entry[key], undefined, `expected ${key} to be dropped`);
    }
    assert.strictEqual(entry.provider, "anthropic");
    assert.strictEqual(entry.id, "claude");
    assert.strictEqual(entry.thinking, "high");
  });

  it("starts from nothing when there is no previous entry", () => {
    const entry = buildModelConfigEntry(undefined, { provider: "openai", id: "gpt-4o", thinking: "xhigh" });
    assert.deepStrictEqual(entry, { provider: "openai", id: "gpt-4o", thinking: "xhigh" });
  });
});

describe("model picker helpers", () => {
  it("formatModelItem marks the current model", () => {
    const model: ModelRef = { id: "gpt-4o", provider: "openai" };
    assert.strictEqual(formatModelItem(model), "gpt-4o");
    assert.strictEqual(formatModelItem(model, "gpt-4o"), "gpt-4o ✓ current");
  });

  it("parseModelIdFromItem strips the current marker", () => {
    assert.strictEqual(parseModelIdFromItem("gpt-4o ✓ current"), "gpt-4o");
    assert.strictEqual(parseModelIdFromItem("claude-sonnet"), "claude-sonnet");
  });

  it("groupModelsByPrefix groups hierarchical IDs and sorts each group", () => {
    const models: ModelRef[] = [
      { id: "meta/llama-3-70b", provider: "openrouter" },
      { id: "openai/gpt-4o", provider: "openrouter" },
      { id: "anthropic/claude-sonnet", provider: "openrouter" },
      { id: "openai/gpt-3.5", provider: "openrouter" },
      { id: "plain-model", provider: "openrouter" },
    ];
    const groups = groupModelsByPrefix(models);
    assert.deepStrictEqual(Object.keys(groups).sort(), ["(other)", "anthropic", "meta", "openai"]);
    assert.deepStrictEqual(
      groups.openai.map((m) => m.id),
      ["openai/gpt-3.5", "openai/gpt-4o"],
    );
    assert.strictEqual(groups["(other)"][0].id, "plain-model");
  });

  it("pickModelFromFlatList returns the selected model id", async () => {
    const ctx = fakeContext(["openai/gpt-4o ✓ current"]);
    const result = await pickModelFromFlatList(
      ctx,
      "openrouter",
      [{ id: "openai/gpt-4o", provider: "openrouter" }],
      "openai/gpt-4o",
    );
    assert.strictEqual(result, "openai/gpt-4o");
  });

  it("pickModelFromFlatList returns undefined when cancelled", async () => {
    const ctx = fakeContext([undefined]);
    const result = await pickModelFromFlatList(
      ctx,
      "openrouter",
      [{ id: "openai/gpt-4o", provider: "openrouter" }],
      "",
    );
    assert.strictEqual(result, undefined);
  });

  it("pickModelFromFlatList falls back to prompt search for large lists", async () => {
    const ctx = fakeContext(["openai/model-3"], ["model-3"]);
    const models: ModelRef[] = Array.from({ length: 25 }, (_, i) => ({
      id: `openai/model-${i}`,
      provider: "openrouter",
    }));
    const result = await pickModelFromFlatList(ctx, "openrouter", models, "");
    assert.strictEqual(result, "openai/model-3");
  });

  it("pickModelFromFlatList returns undefined when prompt search is cancelled", async () => {
    const ctx = fakeContext([], [undefined]);
    const models: ModelRef[] = Array.from({ length: 25 }, (_, i) => ({
      id: `openai/model-${i}`,
      provider: "openrouter",
    }));
    const result = await pickModelFromFlatList(ctx, "openrouter", models, "");
    assert.strictEqual(result, undefined);
  });

  it("pickModelFromProvider returns a model from a short flat list", async () => {
    const ctx = fakeContext(["gpt-4o"]);
    const result = await pickModelFromProvider(ctx, "openai", [{ id: "gpt-4o", provider: "openai" }], "");
    assert.strictEqual(result, "gpt-4o");
  });

  it("pickModelFromProvider browses families first for large multi-group catalogs", async () => {
    const ctx = fakeContext(["openai (11 models)", "openai/model-3"]);
    const models: ModelRef[] = [
      ...Array.from({ length: 11 }, (_, i) => ({ id: `openai/model-${i}`, provider: "openrouter" })),
      ...Array.from({ length: 11 }, (_, i) => ({ id: `anthropic/model-${i}`, provider: "openrouter" })),
    ];
    const result = await pickModelFromProvider(ctx, "openrouter", models, "");
    assert.strictEqual(result, "openai/model-3");
  });

  it("pickModelFromProvider offers a search escape hatch from family browse", async () => {
    const ctx = fakeContext(["Search all openrouter models…", "openai/model-3"], ["model-3"]);
    const models: ModelRef[] = [
      ...Array.from({ length: 11 }, (_, i) => ({ id: `openai/model-${i}`, provider: "openrouter" })),
      ...Array.from({ length: 11 }, (_, i) => ({ id: `anthropic/model-${i}`, provider: "openrouter" })),
    ];
    const result = await pickModelFromProvider(ctx, "openrouter", models, "");
    assert.strictEqual(result, "openai/model-3");
  });

  it("pickModelFromProvider returns to family browse when search matches nothing", async () => {
    const ctx = fakeContext(["Search all openrouter models…", "openai (11 models)", "openai/model-3"], ["zzz"]);
    const models: ModelRef[] = [
      ...Array.from({ length: 11 }, (_, i) => ({ id: `openai/model-${i}`, provider: "openrouter" })),
      ...Array.from({ length: 11 }, (_, i) => ({ id: `anthropic/model-${i}`, provider: "openrouter" })),
    ];
    const result = await pickModelFromProvider(ctx, "openrouter", models, "");
    assert.strictEqual(result, "openai/model-3");
  });

  it("pickModelFromProvider still search-first for a large single-family catalog", async () => {
    const ctx = fakeContext(["openai/model-3"], ["model-3"]);
    const models: ModelRef[] = Array.from({ length: 25 }, (_, i) => ({
      id: `openai/model-${i}`,
      provider: "openrouter",
    }));
    const result = await pickModelFromProvider(ctx, "openrouter", models, "");
    assert.strictEqual(result, "openai/model-3");
  });

  it("pickModelFromProvider uses a searchable family list when there are many families", async () => {
    let inputCb: (data: string) => { consume: boolean } = () => ({ consume: false });
    const ctx = {
      ui: {
        onTerminalInput: (cb: (data: string) => { consume: boolean }) => {
          inputCb = cb;
          return () => {};
        },
        setWidget: () => {},
        select: async () => "openai/m1",
        input: async () => undefined,
        notify: () => {},
      },
    } as unknown as ExtensionContext;

    // 26 families (exceeds SOFT_CAP=20) so the searchable family path is used.
    // The "openai" family has a single model so the inner drill-down is a plain select.
    const models: ModelRef[] = [];
    for (let i = 0; i < 25; i++) {
      models.push({ id: `fam${i}/m${i}`, provider: "openrouter" });
    }
    models.push({ id: "openai/m1", provider: "openrouter" });

    const promise = pickModelFromProvider(ctx, "openrouter", models, "");
    // Type "openai" to narrow the family list, then Enter on the match.
    inputCb("openai");
    inputCb("\r");
    const result = await promise;
    assert.strictEqual(result, "openai/m1");
  });

  it("pickModelFromProvider applies a filter argument", async () => {
    const ctx = fakeContext(["openai/gpt-4o"]);
    const models: ModelRef[] = [
      { id: "openai/gpt-4o", provider: "openrouter" },
      { id: "anthropic/claude-sonnet", provider: "openrouter" },
    ];
    const result = await pickModelFromProvider(ctx, "openrouter", models, "", "gpt");
    assert.strictEqual(result, "openai/gpt-4o");
  });

  it("pickModelFromProvider returns undefined when the filter matches nothing", async () => {
    const ctx = fakeContext([]);
    const models: ModelRef[] = [{ id: "openai/gpt-4o", provider: "openrouter" }];
    const result = await pickModelFromProvider(ctx, "openrouter", models, "", "llama");
    assert.strictEqual(result, undefined);
  });

  it("pickRecentModel returns the selected recent entry", async () => {
    const recent: RecentModel[] = [
      { provider: "openai", id: "gpt-4o", thinking: "xhigh", scope: "base", usedAt: "2026-01-01" },
    ];
    const ctx = fakeContext(["openai:gpt-4o · xhigh · base"]);
    const result = await pickRecentModel(ctx, recent);
    assert.ok(result);
    assert.strictEqual(result?.id, "gpt-4o");
  });

  it("pickRecentModel returns undefined when browsing the full list", async () => {
    const recent: RecentModel[] = [
      { provider: "openai", id: "gpt-4o", thinking: "xhigh", scope: "base", usedAt: "2026-01-01" },
    ];
    const ctx = fakeContext(["Browse all configured models…"]);
    const result = await pickRecentModel(ctx, recent);
    assert.strictEqual(result, undefined);
  });

  it("pickRecentModel returns undefined when cancelled", async () => {
    const recent: RecentModel[] = [
      { provider: "openai", id: "gpt-4o", thinking: "xhigh", scope: "base", usedAt: "2026-01-01" },
    ];
    const ctx = fakeContext([undefined]);
    const result = await pickRecentModel(ctx, recent);
    assert.strictEqual(result, undefined);
  });

  it("promptSearchModels filters models by user input and returns a selection", async () => {
    const ctx = fakeContext(["openai/gpt-4o"], ["gpt-4o"]);
    const models: ModelRef[] = [
      { id: "openai/gpt-4o", provider: "openrouter" },
      { id: "openai/gpt-3.5", provider: "openrouter" },
      { id: "anthropic/claude-sonnet", provider: "openrouter" },
    ];
    const result = await promptSearchModels(ctx, "openrouter", models, "");
    assert.strictEqual(result, "openai/gpt-4o");
  });

  it("promptSearchModels returns undefined when cancelled", async () => {
    const ctx = fakeContext([], [undefined]);
    const models: ModelRef[] = [{ id: "openai/gpt-4o", provider: "openrouter" }];
    const result = await promptSearchModels(ctx, "openrouter", models, "");
    assert.strictEqual(result, undefined);
  });

  it("promptSearchModels returns undefined when no models match", async () => {
    const ctx = fakeContext([], ["llama"]);
    const models: ModelRef[] = [{ id: "openai/gpt-4o", provider: "openrouter" }];
    const result = await promptSearchModels(ctx, "openrouter", models, "");
    assert.strictEqual(result, undefined);
  });

  it("pickModelFromFlatList falls back to prompt search for large grouped lists", async () => {
    const ctx = fakeContext(["openai/model-3"], ["model-3"]);
    const models: ModelRef[] = Array.from({ length: 25 }, (_, i) => ({
      id: `openai/model-${i}`,
      provider: "openrouter",
    }));
    const result = await pickModelFromFlatList(ctx, "openrouter", models, "", "openai");
    assert.strictEqual(result, "openai/model-3");
  });
});

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("resetModelSelection", () => {
  const originalAgentDir = getAgentDir();
  let tmpDirs: string[] = [];

  afterEach(() => {
    setAgentDirForTests(() => originalAgentDir);
  });

  after(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs = [];
  });

  function makeTempAgentDir(): string {
    const dir = join(tmpdir(), `wai-reset-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    tmpDirs.push(dir);
    return dir;
  }

  function writeSettings(agentDir: string, waiSettings: Record<string, unknown>): void {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ "pi-yoowai": waiSettings }, null, 2), "utf-8");
  }

  function resetCtx(cwd: string, selectQueue: (string | undefined)[] = []): ExtensionContext & { cwd: string } {
    return { ...fakeContext(selectQueue), cwd } as ExtensionContext & { cwd: string };
  }

  it("clears the base secondary model", async () => {
    const agentDir = makeTempAgentDir();
    const cwd = makeTempDir("wai-reset-base-cwd-");
    setAgentDirForTests(() => agentDir);
    writeSettings(agentDir, {
      secondary: { provider: "openai", id: "gpt-4o", thinking: "high" },
      taskModels: { review: { provider: "deepseek", id: "deepseek-v4-pro" } },
    });

    let refreshed = false;
    await resetModelSelection(resetCtx(cwd), "base", async () => {
      refreshed = true;
    });

    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as {
      "pi-yoowai": Record<string, unknown>;
    };
    assert.equal("secondary" in settings["pi-yoowai"], false);
    assert.deepEqual(settings["pi-yoowai"].taskModels, { review: { provider: "deepseek", id: "deepseek-v4-pro" } });
    assert.ok(refreshed);
  });

  it("clears a task override but keeps base and other tasks", async () => {
    const agentDir = makeTempAgentDir();
    const cwd = makeTempDir("wai-reset-task-cwd-");
    setAgentDirForTests(() => agentDir);
    writeSettings(agentDir, {
      secondary: { provider: "openai", id: "gpt-4o" },
      taskModels: {
        review: { provider: "deepseek", id: "deepseek-v4-pro" },
        judge: { provider: "opencode-go", id: "qwen3.7-max" },
      },
    });

    await resetModelSelection(resetCtx(cwd), "review", async () => {});

    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as {
      "pi-yoowai": Record<string, unknown>;
    };
    assert.deepEqual(settings["pi-yoowai"].secondary, { provider: "openai", id: "gpt-4o" });
    assert.deepEqual(settings["pi-yoowai"].taskModels, {
      judge: { provider: "opencode-go", id: "qwen3.7-max" },
    });
  });

  it("clears the last task override and removes the taskModels key", async () => {
    const agentDir = makeTempAgentDir();
    const cwd = makeTempDir("wai-reset-last-task-cwd-");
    setAgentDirForTests(() => agentDir);
    writeSettings(agentDir, {
      secondary: { provider: "openai", id: "gpt-4o" },
      taskModels: { review: { provider: "deepseek", id: "deepseek-v4-pro" } },
    });

    await resetModelSelection(resetCtx(cwd), "review", async () => {});

    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as {
      "pi-yoowai": Record<string, unknown>;
    };
    assert.equal("taskModels" in settings["pi-yoowai"], false);
  });

  it("rejects an invalid direct target", async () => {
    const agentDir = makeTempAgentDir();
    const cwd = makeTempDir("wai-reset-invalid-cwd-");
    setAgentDirForTests(() => agentDir);
    writeSettings(agentDir, { secondary: { provider: "openai", id: "gpt-4o" } });

    let notified: { message: string; type: string } | undefined;
    const ctx = {
      ...fakeContext(),
      cwd,
      ui: {
        ...fakeContext().ui,
        notify: (message: string, type: string) => {
          notified = { message, type };
        },
      },
    } as ExtensionContext & { cwd: string };

    await resetModelSelection(ctx, "not-a-task", async () => {});

    assert.ok(notified);
    assert.ok(notified!.message.includes('Invalid reset target "not-a-task"'));
    assert.equal(notified!.type, "warning");
  });

  it("interactive reset clears a partial override by role and reports the actual fallback", async () => {
    const agentDir = makeTempAgentDir();
    const cwd = makeTempDir("wai-reset-partial-cwd-");
    setAgentDirForTests(() => agentDir);
    writeSettings(agentDir, {
      secondary: { provider: "openai", id: "base-model" },
      taskModels: { advisor: { thinking: "low" }, suggest: { id: "suggest-model" } },
    });
    const messages: string[] = [];
    const ctx = {
      ...fakeContext(),
      cwd,
      ui: {
        ...fakeContext().ui,
        select: async (_title: string, options: string[]) => {
          const row = options.find((item) => item.startsWith("advisor ("));
          assert.ok(row?.includes("✓ configured"));
          return row;
        },
        notify: (message: string) => messages.push(message),
      },
    } as ExtensionContext;
    await resetModelSelection(ctx, undefined, async () => {});
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"))["pi-yoowai"];
    assert.deepStrictEqual(settings.taskModels, { suggest: { id: "suggest-model" } });
    assert.ok(messages.some((message) => message.includes("openai:suggest-model") && message.includes("via suggest")));
  });

  it("accepts depth reset targets case-insensitively", async () => {
    const agentDir = makeTempAgentDir();
    const cwd = makeTempDir("wai-reset-depth-cwd-");
    setAgentDirForTests(() => agentDir);
    writeSettings(agentDir, {
      secondary: { provider: "openai", id: "base-model" },
      taskModels: { reviewHigh: { id: "depth-model" } },
    });
    await resetModelSelection(resetCtx(cwd), "REVIEWHIGH", async () => {});
    assert.equal(loadYoowaiConfig(cwd).taskModels?.reviewHigh, undefined);
  });

  it("interactive picker marks only scopes that are actually configured", async () => {
    const agentDir = makeTempAgentDir();
    const cwd = makeTempDir("wai-reset-marker-cwd-");
    setAgentDirForTests(() => agentDir);
    writeSettings(agentDir, {
      secondary: { provider: "openai", id: "gpt-4o" },
      taskModels: {
        review: { provider: "deepseek", id: "deepseek-v4-pro" },
        suggest: { provider: "deepseek", id: "deepseek-v4-pro" },
      },
    });

    let items: string[] = [];
    const ctx = {
      ...fakeContext(),
      cwd,
      ui: {
        ...fakeContext().ui,
        select: async (_title: string, options: string[]) => {
          items = options;
          return undefined; // cancel
        },
      },
    } as ExtensionContext & { cwd: string };

    await resetModelSelection(ctx, undefined, async () => {});

    assert.ok(items[0]?.includes("✓ configured"), `base row: ${items[0]}`);
    assert.ok(!items.some((i) => i.startsWith("review")));
    const suggestRow = items.find((i) => i.startsWith("suggest ("));
    assert.ok(!items.some((i) => i.startsWith("judge (")));
    assert.ok(suggestRow?.includes("✓ configured"), `suggest row: ${suggestRow}`);
  });
});

describe("council synthesis configuration", () => {
  it("shows the base or first-member fallback without enabling an empty council", () => {
    const config: YoowaiConfig = { secondary: { provider: "picker", id: "base", thinking: "off" }, judgeCouncil: [] };
    assert.match(formatCouncilSynthesisModel(config), /picker:base.*unused until two or more members/);
    config.secondary = { provider: "", id: "" };
    assert.match(formatCouncilSynthesisModel(config), /not configured.*unused/);
    config.judgeCouncil = [
      { provider: "picker", id: "first" },
      { provider: "picker", id: "second" },
    ];
    assert.match(formatCouncilSynthesisModel(config), /picker:first.*combines council results/);
  });

  for (const scenario of [
    "save",
    "cancel model",
    "cancel thinking",
    "reset",
    "project",
    "empty",
    "no base",
    "save then add",
    "reset then add",
    "save then clear",
    "concurrent settings",
    "view no registry",
    "reset no registry",
  ] as const) {
    it(`manages synthesis from the council menu: ${scenario}`, async () => {
      const agentDir = mkdtempSync(join(tmpdir(), "wai-synthesis-agent-"));
      const cwd = mkdtempSync(join(tmpdir(), "wai-synthesis-cwd-"));
      const previousAgentDir = getAgentDir();
      try {
        setAgentDirForTests(() => agentDir);
        const settingsPath = join(agentDir, "settings.json");
        const initial = {
          unrelated: 42,
          "pi-yoowai": {
            secondary: {
              provider: scenario === "no base" ? "" : "picker",
              id: scenario === "no base" ? "" : "base",
              thinking: "off",
            },
            reviewLevel: "auto",
            autoJudge: false,
            taskModels: {
              ...(scenario === "no base"
                ? {}
                : {
                    judge: {
                      provider: "picker",
                      id: "old",
                      thinking: "off",
                      backend: "http",
                      baseUrl: "https://example.invalid",
                      timeoutMs: 1337,
                    },
                  }),
              reviewMed: { id: "reviewer" },
              plan: { id: "planner" },
            },
            judgeCouncil: scenario === "empty" ? [] : ["picker/member-a", "picker/member-b"],
          },
        };
        const initialText = JSON.stringify(initial);
        writeFileSync(settingsPath, initialText);
        const projectText = JSON.stringify({ "pi-yoowai": { taskModels: { judge: { id: "project" } } } });
        if (scenario === "project") {
          mkdirSync(join(cwd, ".pi"));
          writeFileSync(join(cwd, ".pi", "settings.json"), projectText);
        }
        const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
        registerWaiCommands(
          {
            registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
              commands.set(name, def),
          } as unknown as ExtensionAPI,
          new Map(),
        );
        const models = ["base", "old", "member-a", "member-b", "next", "extra", "project"].map((id) => ({
          provider: "picker",
          id,
          reasoning: false,
        }));
        const notifications: string[] = [];
        const menus: string[][] = [];
        let adding = false;
        let modelItems: string[] = [];
        const ctx = {
          cwd,
          modelRegistry: scenario.endsWith("no registry")
            ? undefined
            : {
                getAll: () => models,
                getAvailable: () => models,
                getProviderAuthStatus: () => ({ configured: true }),
                find: (provider: string, id: string) =>
                  models.find((model) => model.provider === provider && model.id === id),
              },
          ui: {
            notify: (text: string) => notifications.push(text),
            select: async (title: string, items: string[]) => {
              if (title.startsWith("Judge council")) {
                menus.push(items);
                assert.ok(items.some((item) => item.startsWith("Synthesis model:")));
                assert.ok(items.includes("Reset synthesis model"));
                if (menus.length === 1) {
                  if (scenario === "view no registry") return "Done";
                  if (scenario.startsWith("reset")) return "Reset synthesis model";
                  if (scenario === "concurrent settings") {
                    adding = true;
                    return "Add member…";
                  }
                  return items.find((item) => item.startsWith("Synthesis model:"));
                }
                if (menus.length === 2 && (scenario === "save then add" || scenario === "reset then add")) {
                  adding = true;
                  return "Add member…";
                }
                if (menus.length === 2 && scenario === "save then clear") return "Clear council";
                return "Done";
              }
              if (title.startsWith("Pick model")) {
                modelItems = items;
                return scenario === "cancel model"
                  ? undefined
                  : items.find((item) => item.startsWith(adding ? "extra" : "next"));
              }
              if (title.startsWith("Pick thinking")) {
                if (scenario === "concurrent settings") {
                  const latest = JSON.parse(readFileSync(settingsPath, "utf8"));
                  latest.unrelated = 99;
                  latest["pi-yoowai"].taskModels.judge.id = "external-model";
                  writeFileSync(settingsPath, JSON.stringify(latest));
                }
                return scenario === "cancel thinking" ? undefined : items[0];
              }
              throw new Error(`Unexpected picker: ${title}`);
            },
          },
        } as unknown as ExtensionContext;
        await commands.get("wai-council")!.handler("", ctx);
        const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
        const wai = saved["pi-yoowai"];
        assert.equal(saved.unrelated, scenario === "concurrent settings" ? 99 : 42);
        assert.deepStrictEqual(wai.secondary, initial["pi-yoowai"].secondary);
        assert.equal(wai.reviewLevel, "auto");
        assert.equal(wai.autoJudge, false);
        assert.deepStrictEqual(wai.taskModels.reviewMed, initial["pi-yoowai"].taskModels.reviewMed);
        assert.deepStrictEqual(wai.taskModels.plan, initial["pi-yoowai"].taskModels.plan);
        if (scenario === "cancel model" || scenario === "cancel thinking" || scenario === "view no registry") {
          assert.equal(readFileSync(settingsPath, "utf8"), initialText, notifications.join("\n"));
          return;
        }
        if (scenario.startsWith("reset")) {
          assert.equal(wai.taskModels.judge, undefined);
          assert.ok(menus[1].some((item) => item.startsWith("Synthesis model: picker:base")));
        } else if (scenario === "concurrent settings") {
          assert.equal(wai.taskModels.judge.id, "external-model");
        } else {
          assert.equal(wai.taskModels.judge.id, "next", notifications.join("\n"));
          if (scenario !== "no base") {
            assert.equal(wai.taskModels.judge.backend, "http");
            assert.equal(wai.taskModels.judge.baseUrl, "https://example.invalid");
            assert.equal(wai.taskModels.judge.timeoutMs, 1337);
          }
          assert.ok(menus[1].some((item) => item.includes(`picker:${scenario === "project" ? "project" : "next"}`)));
        }
        if (scenario === "save then add" || scenario === "reset then add" || scenario === "concurrent settings") {
          assert.equal(wai.judgeCouncil.length, 3);
          assert.deepStrictEqual(wai.judgeCouncil.slice(0, 2), initial["pi-yoowai"].judgeCouncil);
          assert.equal(wai.judgeCouncil[2].id, "extra");
        } else if (scenario === "save then clear") {
          assert.deepStrictEqual(wai.judgeCouncil, []);
          assert.ok(menus[2].some((item) => item.includes("picker:next") && item.includes("unused")));
        } else {
          assert.deepStrictEqual(wai.judgeCouncil, initial["pi-yoowai"].judgeCouncil);
        }
        if (scenario === "empty") assert.ok(menus[1].some((item) => item.includes("unused until two or more members")));
        if (scenario === "no base") assert.ok(modelItems.includes("member-a ✓ current"));
        if (scenario === "project") {
          assert.ok(modelItems.includes("project ✓ current"));
          assert.ok(
            notifications.some(
              (text) => text.includes("picker:project") && text.includes("Project settings take priority"),
            ),
          );
          assert.equal(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"), projectText);
        }
      } finally {
        setAgentDirForTests(() => previousAgentDir);
        for (const dir of [agentDir, cwd]) {
          assert.equal(dirname(realpathSync(dir)), realpathSync(tmpdir()));
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  }
});

describe("live thinking levels in model and council commands", () => {
  const originalAgentDir = getAgentDir();
  after(() => setAgentDirForTests(() => originalAgentDir));
  const model = {
    provider: "openai-codex",
    id: "gpt-6-astra",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  };

  async function run(
    command: "wai-model" | "wai-council",
    cancelThinking = false,
    unknown = false,
    clear?: "global" | "project",
  ) {
    const agentDir = mkdtempSync(join(tmpdir(), "wai-thinking-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "wai-thinking-project-"));
    try {
      setAgentDirForTests(() => agentDir);
      const settingsPath = join(agentDir, "settings.json");
      writeFileSync(
        settingsPath,
        JSON.stringify({
          "pi-yoowai": {
            secondary: { provider: model.provider, id: model.id, thinking: "medium" },
            ...(clear ? { judgeCouncil: [{ provider: model.provider, id: model.id }] } : {}),
          },
        }),
      );
      if (clear === "project") {
        mkdirSync(join(cwd, ".pi"));
        writeFileSync(
          join(cwd, ".pi", "settings.json"),
          JSON.stringify({ "pi-yoowai": { judgeCouncil: [{ provider: model.provider, id: model.id }] } }),
        );
      }
      const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
      const pi = {
        registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
          commands.set(name, def),
      } as unknown as ExtensionAPI;
      registerWaiCommands(pi, new Map());
      const selections: Array<{ title: string; items: string[] }> = [];
      const notifications: string[] = [];
      if (unknown)
        setSdkGetModelOverride(() => {
          throw new Error("not in static catalog");
        });
      let councilPicks = 0;
      const ctx = {
        cwd,
        modelRegistry: {
          getAll: () => [unknown ? { provider: model.provider, id: model.id } : model],
          getAvailable: () => [unknown ? { provider: model.provider, id: model.id } : model],
          find: () => (unknown ? { provider: model.provider, id: model.id } : model),
          getProviderAuthStatus: () => ({ configured: true }),
          hasConfiguredAuth: () => true,
        },
        ui: {
          notify: (message: string) => notifications.push(message),
          select: async (title: string, items: string[]) => {
            selections.push({ title, items });
            if (title.startsWith("Judge council"))
              return councilPicks++ === 0 ? (clear ? "Clear council" : "Add member…") : "Done";
            if (title.startsWith("Which wai model role")) return items[0];
            if (title.startsWith("Pick model")) return items[0];
            if (title.startsWith("Pick thinking")) return cancelThinking ? undefined : "max";
            return undefined;
          },
        },
      } as unknown as ExtensionContext;
      await commands.get(command)!.handler(command === "wai-model" ? model.provider : "", ctx);
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))["pi-yoowai"];
      if (clear) {
        assert.deepStrictEqual(settings.judgeCouncil, []);
        assert.ok(
          notifications.some((message) =>
            message.includes(clear === "project" ? "project override still supplies" : "final assessment disabled"),
          ),
          notifications.join("\n"),
        );
        assert.equal(loadYoowaiConfig(cwd).judgeCouncil?.length ?? 0, clear === "project" ? 1 : 0);
        assert.ok(
          selections
            .at(-1)
            ?.title.includes(clear === "project" ? "final assessment 1 member(s)" : "final assessment disabled"),
        );
        return;
      }
      const thinkingPicker = selections.find((s) => s.title.startsWith("Pick thinking"));
      if (unknown) {
        assert.equal(thinkingPicker, undefined, "unknown model must not offer guessed levels");
        assert.ok(notifications.some((message) => message.includes("does not advertise any thinking levels")));
      } else {
        assert.ok(thinkingPicker, "thinking picker reached");
        assert.deepStrictEqual(
          thinkingPicker.items.map((item) => item.replace(" ✓ current", "")),
          ["minimal", "low", "medium", "high", "xhigh", "max"],
        );
      }
      if (command === "wai-model") {
        assert.equal(settings.secondary.thinking, cancelThinking || unknown ? "medium" : "max");
      } else {
        assert.deepStrictEqual(
          settings.judgeCouncil ?? [],
          cancelThinking || unknown
            ? []
            : [
                {
                  provider: model.provider,
                  id: model.id,
                  thinking: "max",
                },
              ],
        );
      }
    } finally {
      setSdkGetModelOverride(null);
      setAgentDirForTests(() => originalAgentDir);
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  it("/wai-model displays live max and persists it", () => run("wai-model"));
  it("/wai-model cancel keeps prior selection", () => run("wai-model", true));
  it("/wai-council displays live max and persists it", () => run("wai-council"));
  it("/wai-council cancel leaves council unchanged", () => run("wai-council", true));
  it("/wai-model unknown metadata leaves settings unchanged", () => run("wai-model", false, true));
  it("/wai-council unknown metadata leaves settings unchanged", () => run("wai-council", false, true));
  it("/wai-council clear disables final assessment", () => run("wai-council", false, false, "global"));
  it("/wai-council clear reports a project council override", () => run("wai-council", false, false, "project"));
});

describe("buildReviewLevelItems", () => {
  const automatic = "Automatic (med default; risk routing when enabled)";
  it("lists the configured current level first so a blind Enter keeps it", () => {
    assert.deepStrictEqual(buildReviewLevelItems("min"), ["min ✓ current", automatic, "med", "high"]);
  });

  it("keeps automatic selection when no fixed level is configured", () => {
    for (const current of [undefined, "auto"] as const) {
      assert.deepStrictEqual(buildReviewLevelItems(current), [`${automatic} ✓ current`, "min", "med", "high"]);
    }
  });

  it("keeps the configured current level first even when it differs from the default", () => {
    assert.deepStrictEqual(buildReviewLevelItems("high"), ["high ✓ current", automatic, "min", "med"]);
  });

  it("distinguishes a fixed med level from automatic selection", () => {
    assert.deepStrictEqual(buildReviewLevelItems("med"), ["med ✓ current", automatic, "min", "high"]);
  });

  it("never drops a mode and parses current/default labels without freezing auto to med", () => {
    const items = buildReviewLevelItems("min");
    assert.strictEqual(items.length, 4);
    assert.deepStrictEqual(items.map(parseReviewLevelItem), ["min", "auto", "med", "high"]);
    assert.equal(parseReviewLevelItem(`${automatic} ✓ current`), "auto");
    assert.equal(parseReviewLevelItem("unknown"), undefined);
  });
});
