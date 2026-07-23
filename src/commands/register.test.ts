import { describe, it } from "node:test";
import assert from "node:assert";
import {
  computeThinkingLevels,
  resolveModelThinkingDetails,
  formatModelItem,
  parseModelIdFromItem,
  groupModelsByPrefix,
  pickModelFromFlatList,
  pickModelFromProvider,
  pickRecentModel,
  promptSearchModels,
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

  it("falls back to canonical list when no map is provided", () => {
    assert.deepStrictEqual(computeThinkingLevels({}, canonicalLevels), canonicalLevels);
    assert.deepStrictEqual(computeThinkingLevels({ reasoning: true }, canonicalLevels), canonicalLevels);
    assert.deepStrictEqual(computeThinkingLevels(undefined, canonicalLevels), canonicalLevels);
  });

  it("filters to advertised non-null levels plus off", () => {
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
    assert.deepStrictEqual(computeThinkingLevels(modelDetails, canonicalLevels), ["off", "minimal", "low", "high"]);
  });

  it("returns only off when every non-off level is unsupported", () => {
    const modelDetails = {
      reasoning: true,
      thinkingLevelMap: {
        off: null,
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
      assert.deepStrictEqual(computeThinkingLevels(details, canonicalLevels), ["off", "high", "max"]);
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

  it("pickModelFromProvider groups hierarchical models after search is cancelled", async () => {
    const ctx = fakeContext(["openai (11 models)", "openai/model-3"], [undefined]);
    const models: ModelRef[] = [
      ...Array.from({ length: 11 }, (_, i) => ({ id: `openai/model-${i}`, provider: "openrouter" })),
      ...Array.from({ length: 11 }, (_, i) => ({ id: `anthropic/model-${i}`, provider: "openrouter" })),
    ];
    const result = await pickModelFromProvider(ctx, "openrouter", models, "");
    assert.strictEqual(result, "openai/model-3");
  });

  it("pickModelFromProvider uses search-first for large catalogs", async () => {
    const ctx = fakeContext(["openai/model-3"], ["model-3"]);
    const models: ModelRef[] = [
      ...Array.from({ length: 11 }, (_, i) => ({ id: `openai/model-${i}`, provider: "openrouter" })),
      ...Array.from({ length: 11 }, (_, i) => ({ id: `anthropic/model-${i}`, provider: "openrouter" })),
    ];
    const result = await pickModelFromProvider(ctx, "openrouter", models, "");
    assert.strictEqual(result, "openai/model-3");
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
