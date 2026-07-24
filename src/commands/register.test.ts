import { describe, it } from "node:test";
import assert from "node:assert";
import {
  computeThinkingLevels,
  resolveThinkingLevelOptions,
  resolveModelThinkingDetails,
  formatModelItem,
  parseModelIdFromItem,
  groupModelsByPrefix,
  pickModelFromFlatList,
  pickModelFromProvider,
  pickRecentModel,
  promptSearchModels,
  buildModelConfigEntry,
  isScopeConfigured,
  type ModelRef,
} from "./register.js";
import { setSdkGetModelOverride } from "../backends/sdk-backend.js";
import type { RecentModel } from "../model-history.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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

  it("falls back to off plus the current default only for unknown models", () => {
    assert.deepStrictEqual(resolveThinkingLevelOptions(undefined, canonicalLevels, "xhigh"), ["off", "xhigh"]);
    assert.deepStrictEqual(resolveThinkingLevelOptions({}, canonicalLevels, "high"), ["off"]);
  });

  it("falls back to just off when the current default is off or absent", () => {
    assert.deepStrictEqual(resolveThinkingLevelOptions(undefined, canonicalLevels, "off"), ["off"]);
    assert.deepStrictEqual(resolveThinkingLevelOptions(undefined, canonicalLevels, ""), ["off"]);
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

describe("resolveModelThinkingDetails", () => {
  it("prefers the SDK catalog map over the registry", async () => {
    setSdkGetModelOverride(() => fakeSdkModel({ off: null, high: "high", max: "max" }) as never);
    try {
      const details = await resolveModelThinkingDetails("deepseek", "deepseek-chat", { reasoning: true });
      assert.deepStrictEqual(details?.thinkingLevelMap, { off: null, high: "high", max: "max" });
      assert.deepStrictEqual(computeThinkingLevels(details, canonicalLevels), [
        "minimal",
        "low",
        "medium",
        "high",
        "max",
      ]);
    } finally {
      setSdkGetModelOverride(null);
    }
  });

  it("falls back to the registry when SDK catalog has no map", async () => {
    setSdkGetModelOverride(() => fakeSdkModel(undefined) as never);
    try {
      const registryMap = { off: null, high: "high" } as Record<string, string | null>;
      const details = await resolveModelThinkingDetails("deepseek", "deepseek-chat", {
        reasoning: true,
        thinkingLevelMap: registryMap,
      });
      assert.deepStrictEqual(details?.thinkingLevelMap, registryMap);
    } finally {
      setSdkGetModelOverride(null);
    }
  });

  it("returns registry details when SDK catalog is unavailable", async () => {
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
    assert.strictEqual(isScopeConfigured("Use for review only", taskConfigured), true);
    assert.strictEqual(isScopeConfigured("Use for suggest only", taskConfigured), false);
    // Base configured but no task override: task scope is NOT current.
    assert.strictEqual(isScopeConfigured("Use for review only", baseConfigured), false);
  });
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
