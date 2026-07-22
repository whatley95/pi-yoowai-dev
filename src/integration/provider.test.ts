import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { registerWaiProvider, unregisterWaiProvider, type ModelLookup } from "./provider.js";

function createFakePi(): {
  pi: ExtensionAPI;
  registrations: { name: string; config: ProviderConfig }[];
  unregistrations: string[];
} {
  const registrations: { name: string; config: ProviderConfig }[] = [];
  const unregistrations: string[] = [];
  const pi = {
    registerProvider: (name: string, config: ProviderConfig) => {
      registrations.push({ name, config });
    },
    unregisterProvider: (name: string) => {
      unregistrations.push(name);
    },
  } as unknown as ExtensionAPI;
  return { pi, registrations, unregistrations };
}

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "gpt-4o",
    name: "GPT-4o",
    api: "openai-responses" as Api,
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    ...overrides,
  } as Model<Api>;
}

describe("registerWaiProvider", () => {
  let cwd: string;
  const noLookup: ModelLookup = async () => undefined;
  const foundLookup: ModelLookup = async () => makeModel();

  beforeEach(() => {
    cwd = join(tmpdir(), `wai-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("does not register when registerProvider is false", async () => {
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        "pi-yoowai": {
          secondary: { provider: "openai", id: "gpt-4o", apiKey: "sk-test" },
          registerProvider: false,
        },
      }),
    );
    const { pi, registrations } = createFakePi();
    await registerWaiProvider(pi, cwd, foundLookup);
    assert.strictEqual(registrations.length, 0);
  });

  it("does not register without an API key", async () => {
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        "pi-yoowai": {
          secondary: { provider: "openai", id: "gpt-4o" },
          registerProvider: true,
        },
      }),
    );
    const { pi, registrations } = createFakePi();
    await registerWaiProvider(pi, cwd, foundLookup);
    assert.strictEqual(registrations.length, 0);
  });

  it("skips registration when model is not in Pi registry", async () => {
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        "pi-yoowai": {
          secondary: { provider: "unknown", id: "unknown-model", apiKey: "sk-test" },
          registerProvider: true,
        },
      }),
    );
    const { pi, registrations } = createFakePi();
    await registerWaiProvider(pi, cwd, noLookup);

    assert.strictEqual(registrations.length, 0);
  });

  it("registers the secondary model as provider 'wai' using Pi registry metadata", async () => {
    const lookup: ModelLookup = async () =>
      makeModel({
        id: "gpt-4o",
        api: "openai-responses" as Api,
        provider: "openai",
        reasoning: true,
        input: ["text"],
        contextWindow: 256000,
        maxTokens: 32768,
      });

    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        "pi-yoowai": {
          secondary: { provider: "openai", id: "gpt-4o", apiKey: "sk-test" },
          registerProvider: true,
        },
      }),
    );
    const { pi, registrations } = createFakePi();
    await registerWaiProvider(pi, cwd, lookup);

    assert.strictEqual(registrations.length, 1);
    assert.strictEqual(registrations[0].name, "wai");
    const model = registrations[0].config.models![0];
    assert.strictEqual(model.id, "gpt-4o");
    assert.strictEqual(model.reasoning, true);
    assert.deepStrictEqual(model.input, ["text"]);
    assert.strictEqual(model.contextWindow, 256000);
    assert.strictEqual(model.maxTokens, 32768);
    assert.strictEqual(registrations[0].config.api, "openai-responses");
  });

  it("overrides baseUrl from config when model is in Pi registry", async () => {
    const lookup: ModelLookup = async () => makeModel({ baseUrl: "https://api.openai.com/v1" });

    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        "pi-yoowai": {
          secondary: {
            provider: "openai",
            id: "gpt-4o",
            apiKey: "sk-test",
            baseUrl: "https://proxy.example.com/v1",
          },
          registerProvider: true,
        },
      }),
    );
    const { pi, registrations } = createFakePi();
    await registerWaiProvider(pi, cwd, lookup);

    assert.strictEqual(registrations[0].config.baseUrl, "https://proxy.example.com/v1");
  });

  it("caches the resolved API key across registrations for the same cwd", async () => {
    let calls = 0;
    const resolveKey = () => {
      calls++;
      return "sk-test";
    };

    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        "pi-yoowai": {
          secondary: { provider: "openai", id: "gpt-4o", apiKey: "!ignored" },
          registerProvider: true,
        },
      }),
    );

    const { pi, registrations } = createFakePi();
    await registerWaiProvider(pi, cwd, foundLookup, resolveKey);
    await registerWaiProvider(pi, cwd, foundLookup, resolveKey);

    assert.strictEqual(calls, 1);
    assert.strictEqual(registrations.length, 2);
  });

  it("clears the cached API key when the provider is unregistered", async () => {
    let calls = 0;
    const resolveKey = () => {
      calls++;
      return "sk-test";
    };

    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        "pi-yoowai": {
          secondary: { provider: "openai", id: "gpt-4o", apiKey: "sk-test" },
          registerProvider: true,
        },
      }),
    );

    const { pi, registrations, unregistrations } = createFakePi();
    await registerWaiProvider(pi, cwd, foundLookup, resolveKey);
    unregisterWaiProvider(pi, cwd);
    await registerWaiProvider(pi, cwd, foundLookup, resolveKey);

    assert.strictEqual(calls, 2);
    assert.strictEqual(unregistrations.length, 1);
    assert.strictEqual(registrations.length, 2);
  });
});
