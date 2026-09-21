import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import {
  callSdkBackend,
  clearSdkOAuthCache,
  clearSdkRegistryOverride,
  getSdkRegistry,
  isRegistryStreamCapable,
  setSdkGetModelOverride,
  setSdkOAuthResolverOverride,
  setSdkRegistryOverride,
  setSdkSessionRegistry,
  setSdkStreamSimpleOverride,
  type RegistryStreamAdapter,
} from "./sdk-backend.js";
import { setAgentDirForTests, getAgentDir } from "../pi-paths.js";
import { callSecondaryModel, setPiSpawnResolver } from "../secondary-model.js";

// --- Local fakes (mirroring the helpers in secondary-model.test.ts) ---

function fakeSdkModel(provider: string, modelId: string, opts?: { input?: ("text" | "image")[] }): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider,
    baseUrl: "https://example.com",
    reasoning: false,
    input: opts?.input ?? ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
    contextWindow: 128000,
    maxTokens: 4096,
  } as Model<Api>;
}

function fakeSdkAssistantMessage(text: string, stopReason = "stop", errorMessage?: string): AssistantMessage {
  const inputTokens = 10;
  const outputTokens = 5;
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } satisfies Usage,
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  } as AssistantMessage;
}

function fakeSdkStream(message: AssistantMessage): AssistantMessageEventStream {
  return {
    result: async () => message,
    [Symbol.asyncIterator]: async function* () {
      yield { type: "done", reason: "stop", message };
    },
  } as unknown as AssistantMessageEventStream;
}

/** Deferred promise helper for deterministic concurrency tests. */
function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** AssistantMessage shaped like a provider-side credential rejection, as
 *  surfaced by pi-ai's stopReason "error". */
function authRejectedStream(): AssistantMessageEventStream {
  return fakeSdkStream(
    fakeSdkAssistantMessage(
      "",
      "error",
      '401 {"error":{"type":"authentication_error","message":"The API Key appears to be invalid or may have expired."}}',
    ),
  );
}

// --- Registry fakes ---

interface RecordedStreamCall {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions | undefined;
  self: unknown;
}

interface FakeRegistry {
  registry: RegistryStreamAdapter;
  /** Shallow view of the recorded activity, mutated in place. */
  state: {
    findCalls: number;
    streamSimpleCalls: RecordedStreamCall[];
  };
}

/** A registry object with all three methods as real (bound-capable) methods.
 *  `streamSimple` records its receiver so tests can assert method binding. */
function makeCapableRegistry(opts: {
  model: Model<Api> | undefined;
  /** A full stream to return as-is, an AssistantMessage to wrap, or an Error
   *  to throw from streamSimple. Omitted → a plain "registry ok" message. */
  streamSimple?: AssistantMessageEventStream | AssistantMessage | Error;
}): FakeRegistry {
  const state = { findCalls: 0, streamSimpleCalls: [] as RecordedStreamCall[] };
  const registry = {
    find(provider: string, modelId: string): Model<Api> | undefined {
      state.findCalls += 1;
      // Pretend to read the live catalog: only the configured model resolves.
      return opts.model && opts.model.provider === provider && opts.model.id === modelId ? opts.model : undefined;
    },
    stream(): AssistantMessageEventStream {
      throw new Error("registry.stream must never be called by pi-yoowai");
    },
    streamSimple(
      this: unknown,
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream {
      state.streamSimpleCalls.push({ model, context, options, self: this });
      if (opts.streamSimple instanceof Error) throw opts.streamSimple;
      if (opts.streamSimple === undefined) return fakeSdkStream(fakeSdkAssistantMessage("registry ok"));
      if (typeof (opts.streamSimple as AssistantMessage).stopReason === "string") {
        return fakeSdkStream(opts.streamSimple as AssistantMessage);
      }
      return opts.streamSimple as AssistantMessageEventStream;
    },
  };
  return { registry: registry as unknown as RegistryStreamAdapter, state };
}

// --- Harness ---

const originalAgentDir = getAgentDir();
let tempAgentDirs: string[] = [];
let tempCwds: string[] = [];

function makeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-yoowai-sdk-agent-"));
  tempAgentDirs.push(dir);
  setAgentDirForTests(() => dir);
  return dir;
}

function writeAuthJson(agentDir: string, auth: Record<string, unknown>): void {
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth, null, 2), "utf-8");
}

function makeCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-yoowai-sdk-cwd-"));
  tempCwds.push(dir);
  return dir;
}

afterEach(() => {
  clearSdkRegistryOverride();
  setSdkSessionRegistry(null);
  setSdkStreamSimpleOverride(null);
  setSdkGetModelOverride(null);
  setSdkOAuthResolverOverride(null);
  clearSdkOAuthCache();
  setAgentDirForTests(() => originalAgentDir);
  for (const dir of tempAgentDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  for (const dir of tempCwds) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  tempAgentDirs = [];
  tempCwds = [];
});

/** Compat-route fakes: getModel resolves `compatModel`, streamSimple records
 *  its call and returns the given message (or throws the given error). */
function installCompatFakes(opts: {
  compatModel?: Model<Api> | undefined;
  stream?: AssistantMessageEventStream | Error;
}): { streamSimpleCalls: Array<{ context: Context; options: SimpleStreamOptions | undefined }>; count: () => number } {
  const calls: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
  let count = 0;
  setSdkGetModelOverride((provider) =>
    opts.compatModel === undefined
      ? undefined
      : fakeSdkModel(provider, opts.compatModel.id, { input: [...opts.compatModel.input] }),
  );
  setSdkStreamSimpleOverride((_model, context, sdkOptions) => {
    count += 1;
    calls.push({ context, options: sdkOptions });
    if (opts.stream instanceof Error) throw opts.stream;
    return opts.stream ?? fakeSdkStream(fakeSdkAssistantMessage("compat ok"));
  });
  return { streamSimpleCalls: calls, count: () => count };
}

// --- Capability checks ---

describe("isRegistryStreamCapable", () => {
  it("accepts a full Pi 0.86-shaped registry (find + stream + streamSimple)", () => {
    const { registry } = makeCapableRegistry({ model: fakeSdkModel("p", "m") });
    assert.equal(isRegistryStreamCapable(registry), true);
  });

  it("rejects 0.82.1-shaped registries (find but no stream/streamSimple)", () => {
    // Exactly what Pi 0.82.1 exposes on ctx.modelRegistry.
    const legacy = {
      find: (provider: string, modelId: string) => fakeSdkModel(provider, modelId),
      getAvailable: () => [],
    };
    assert.equal(isRegistryStreamCapable(legacy), false);
  });

  it("rejects partial objects missing any of the three methods", () => {
    assert.equal(isRegistryStreamCapable({}), false);
    assert.equal(isRegistryStreamCapable({ find: () => undefined }), false);
    assert.equal(
      // stream + find but no streamSimple: not enough for the registry route.
      isRegistryStreamCapable({ find: () => undefined, stream: () => undefined }),
      false,
    );
    assert.equal(isRegistryStreamCapable(null), false);
    assert.equal(isRegistryStreamCapable("registry"), false);
  });

  it("rejects objects with non-callable methods", () => {
    const { registry } = makeCapableRegistry({ model: undefined });
    const broken = { ...registry, streamSimple: "not-a-function" } as unknown as RegistryStreamAdapter;
    assert.equal(isRegistryStreamCapable(broken), false);
  });
});

describe("getSdkRegistry", () => {
  it("prefers the override and validates it through the capability check", () => {
    const { registry } = makeCapableRegistry({ model: fakeSdkModel("p", "m") });
    setSdkRegistryOverride(() => registry);
    assert.equal(getSdkRegistry(), registry);
  });

  it("drops an override that is not registry-capable", () => {
    const partial = { find: () => undefined, streamSimple: () => undefined } as unknown as RegistryStreamAdapter;
    setSdkRegistryOverride(() => partial);
    assert.equal(getSdkRegistry(), undefined);
  });

  it("resolves and validates the session accessor", () => {
    const { registry } = makeCapableRegistry({ model: fakeSdkModel("p", "m") });
    setSdkSessionRegistry(() => registry);
    assert.equal(getSdkRegistry(), registry);

    const partial = { find: () => undefined, streamSimple: () => undefined } as unknown as RegistryStreamAdapter;
    setSdkSessionRegistry(() => partial);
    assert.equal(getSdkRegistry(), undefined);

    setSdkSessionRegistry(null);
    assert.equal(getSdkRegistry(), undefined);
  });

  it("lets the override take precedence over the session accessor", () => {
    makeAgentDir();
    const sessionRegistry = makeCapableRegistry({ model: fakeSdkModel("session", "m") });
    const overrideRegistry = makeCapableRegistry({ model: fakeSdkModel("override", "m") });
    setSdkSessionRegistry(() => sessionRegistry.registry);
    setSdkRegistryOverride(() => overrideRegistry.registry);
    assert.equal(getSdkRegistry(), overrideRegistry.registry);
  });

  it("a null override forces no registry even when a session accessor is attached", () => {
    const sessionRegistry = makeCapableRegistry({ model: fakeSdkModel("session", "m") });
    setSdkSessionRegistry(() => sessionRegistry.registry);
    setSdkRegistryOverride(null);
    assert.equal(getSdkRegistry(), undefined, "a cleared override must suppress the session accessor too");
  });
});

describe("sdk-backend registry routing", () => {
  it("streams via a capable registry without compat lookup or local auth resolution", async () => {
    const agentDir = makeAgentDir();
    writeAuthJson(agentDir, {
      "test-provider": { type: "oauth", access: "tok", refresh: "ref", expiresAt: Date.now() + 60_000 },
    });
    const cwd = makeCwd();

    const { registry, state } = makeCapableRegistry({
      model: fakeSdkModel("test-provider", "test-model"),
      streamSimple: fakeSdkAssistantMessage("registry ok"),
    });
    setSdkRegistryOverride(() => registry);

    // Both compat hooks would happily serve the call; the registry must win.
    let compatModelLookups = 0;
    setSdkGetModelOverride(() => {
      compatModelLookups += 1;
      return fakeSdkModel("test-provider", "test-model");
    });
    let compatStreamCalls = 0;
    setSdkStreamSimpleOverride(() => {
      compatStreamCalls += 1;
      return fakeSdkStream(fakeSdkAssistantMessage("compat ok"));
    });
    let oauthResolverCalls = 0;
    setSdkOAuthResolverOverride(async () => {
      oauthResolverCalls += 1;
      return { apiKey: "sk-from-pi-yoowai-auth" };
    });

    const { content } = await callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd });
    assert.equal(content, "registry ok");
    assert.equal(state.findCalls, 1);
    assert.equal(state.streamSimpleCalls.length, 1);
    assert.equal(compatModelLookups, 0, "registry route must not consult the compat catalog");
    assert.equal(compatStreamCalls, 0, "registry route must not stream through compat");
    assert.equal(oauthResolverCalls, 0, "registry route must not run local OAuth resolution");
  });

  it("preserves method binding: `this` inside streamSimple is the registry", async () => {
    makeAgentDir();
    const cwd = makeCwd();
    const { registry, state } = makeCapableRegistry({
      model: fakeSdkModel("test-provider", "test-model"),
      streamSimple: fakeSdkAssistantMessage("bound ok"),
    });
    setSdkRegistryOverride(() => registry);

    await callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd });
    assert.equal(state.streamSimpleCalls.length, 1);
    assert.equal(state.streamSimpleCalls[0]?.self, registry);
  });

  it("falls back to compat when the registry cannot resolve the model", async () => {
    makeAgentDir();
    const cwd = makeCwd();
    const { registry, state } = makeCapableRegistry({ model: undefined });
    setSdkRegistryOverride(() => registry);

    const compat = installCompatFakes({
      compatModel: fakeSdkModel("test-provider", "test-model"),
      stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")),
    });
    const { content } = await callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd });

    assert.equal(content, "compat ok");
    assert.equal(state.streamSimpleCalls.length, 0, "registry must not stream when its find misses");
    assert.equal(compat.count(), 1, "compat route must serve the call after a registry find miss");
  });

  it("rejects a partial registry lacking stream and falls back without invoking its streamSimple", async () => {
    makeAgentDir();
    const cwd = makeCwd();
    let partialStreamSimpleCalls = 0;
    // find + streamSimple present, stream missing: a pre-0.86 partial shim.
    const partial = {
      find: () => fakeSdkModel("test-provider", "test-model"),
      streamSimple: () => {
        partialStreamSimpleCalls += 1;
        return fakeSdkStream(fakeSdkAssistantMessage("partial ok"));
      },
    } as unknown as RegistryStreamAdapter;
    setSdkRegistryOverride(() => partial);

    const compat = installCompatFakes({
      compatModel: fakeSdkModel("test-provider", "test-model"),
      stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")),
    });
    const { content } = await callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd });

    assert.equal(content, "compat ok");
    assert.equal(partialStreamSimpleCalls, 0, "a registry without stream must never be streamed through");
    assert.equal(compat.count(), 1);
  });

  it("replays a registry model-resolution miss (not execution) through the full compat chain", async () => {
    makeAgentDir();
    const cwd = makeCwd();
    // Registry resolves nothing; compat getModel also misses → the runtime
    // lookup and the catalog error path stay in charge.
    const { registry } = makeCapableRegistry({ model: undefined });
    setSdkRegistryOverride(() => registry);
    setSdkGetModelOverride(() => undefined);

    await assert.rejects(
      callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd }),
      /not in Pi's built-in catalog/,
    );
  });

  it("does not replay registry execution failures through compat", async () => {
    makeAgentDir();
    const cwd = makeCwd();
    const { registry, state } = makeCapableRegistry({
      model: fakeSdkModel("test-provider", "test-model"),
      streamSimple: new Error("registry boom"),
    });
    setSdkRegistryOverride(() => registry);
    const compat = installCompatFakes({ stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")) });

    await assert.rejects(callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd }), /registry boom/);
    assert.equal(state.streamSimpleCalls.length, 1);
    assert.equal(compat.count(), 0, "an executing registry must never be retried through compat");
  });

  it("serves registry-only models the compat catalog does not know", async () => {
    makeAgentDir();
    const cwd = makeCwd();
    const { registry, state } = makeCapableRegistry({
      model: fakeSdkModel("extension-provider", "custom-model"),
      streamSimple: fakeSdkAssistantMessage("registry-only ok"),
    });
    setSdkRegistryOverride(() => registry);
    setSdkGetModelOverride(() => undefined); // compat catalog: unknown

    const { content } = await callSdkBackend("extension-provider", "custom-model", "sys", "usr", { cwd });
    assert.equal(content, "registry-only ok");
    assert.equal(state.streamSimpleCalls.length, 1);
  });

  it("retries an auth-rejected registry error once on the registry route", async () => {
    const agentDir = makeAgentDir();
    writeAuthJson(agentDir, {
      "test-provider": { type: "oauth", access: "tok", refresh: "ref", expiresAt: Date.now() + 60_000 },
    });
    const cwd = makeCwd();

    const { registry, state } = makeCapableRegistry({ model: fakeSdkModel("test-provider", "test-model") });
    setSdkRegistryOverride(() => registry);
    let calls = 0;
    const original = registry.streamSimple.bind(registry);
    (registry as { streamSimple: RegistryStreamAdapter["streamSimple"] }).streamSimple = function (
      this: unknown,
      ...args: Parameters<RegistryStreamAdapter["streamSimple"]>
    ) {
      calls += 1;
      state.streamSimpleCalls.push({
        model: args[0],
        context: args[1],
        options: args[2],
        self: this,
      });
      return calls === 1 ? authRejectedStream() : fakeSdkStream(fakeSdkAssistantMessage("registry retry ok"));
    };
    void original;

    let oauthResolverCalls = 0;
    setSdkOAuthResolverOverride(async () => {
      oauthResolverCalls += 1;
      return { apiKey: "sk-fresh" };
    });
    const compat = installCompatFakes({ stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")) });

    const { content } = await callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd });
    assert.equal(content, "registry retry ok");
    assert.equal(calls, 2, "exactly one same-route retry after an auth rejection");
    assert.equal(oauthResolverCalls, 0, "registry route re-resolves auth through Pi, not pi-yoowai");
    assert.equal(compat.count(), 0, "the retry must stay on the registry route");
  });

  it("surfaces a re-login hint when the registry auth retry is rejected again", async () => {
    const agentDir = makeAgentDir();
    writeAuthJson(agentDir, {
      "test-provider": { type: "oauth", access: "tok", refresh: "ref", expiresAt: Date.now() + 60_000 },
    });
    const cwd = makeCwd();

    const { registry } = makeCapableRegistry({
      model: fakeSdkModel("test-provider", "test-model"),
      streamSimple: authRejectedStream(),
    });
    setSdkRegistryOverride(() => registry);

    await assert.rejects(
      callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd }),
      /rejected again after re-resolution.*Run \/login in Pi to re-authenticate/s,
    );
  });

  it("does not retry registry errors that are not auth rejections", async () => {
    makeAgentDir();
    const cwd = makeCwd();
    const { registry, state } = makeCapableRegistry({
      model: fakeSdkModel("test-provider", "test-model"),
      streamSimple: new Error("server 500"),
    });
    setSdkRegistryOverride(() => registry);

    await assert.rejects(callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd }), /server 500/);
    assert.equal(state.streamSimpleCalls.length, 1);
  });

  it("forces the compat route when the config carries unrepresentable overrides", async () => {
    makeAgentDir();
    const cwd = makeCwd();
    const overrides: Array<Record<string, unknown>> = [
      { apiKey: "sk-explicit" },
      { baseUrl: "https://custom.example.com/v1" },
      { authHeader: false },
      { authHeader: "X-Custom-Auth" },
    ];

    for (const override of overrides) {
      const { registry, state } = makeCapableRegistry({
        model: fakeSdkModel("test-provider", "test-model"),
        streamSimple: fakeSdkStream(fakeSdkAssistantMessage("registry ok")),
      });
      setSdkRegistryOverride(() => registry);
      const compat = installCompatFakes({
        compatModel: fakeSdkModel("test-provider", "test-model"),
        stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")),
      });

      const { content } = await callSdkBackend("test-provider", "test-model", "sys", "usr", {
        cwd,
        secondary: { provider: "test-provider", id: "test-model", ...override },
      });

      assert.equal(content, "compat ok", `override ${JSON.stringify(override)} must force the compat route`);
      assert.equal(state.streamSimpleCalls.length, 0, `override ${JSON.stringify(override)} must skip the registry`);
      assert.equal(compat.count(), 1);
    }
  });

  it("keeps the pi backend independent of an attached registry", async () => {
    makeAgentDir();
    const cwd = makeCwd();
    // Settings request the pi backend while a capable registry is attached:
    // the resolver must pick pi and neither the registry nor compat may stream.
    const piDir = join(cwd, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "settings.json"),
      JSON.stringify({ "pi-yoowai": { secondary: { provider: "openai", id: "gpt-4o-mini", backend: "pi" } } }, null, 2),
      "utf-8",
    );
    const script = join(cwd, "fake-pi.js");
    writeFileSync(
      script,
      `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"pi backend ok"}],usage:{input:10,output:5,cost:0.0001}}}));`,
      "utf-8",
    );
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script] }));

    const { registry, state } = makeCapableRegistry({
      model: fakeSdkModel("openai", "gpt-4o-mini"),
      streamSimple: fakeSdkStream(fakeSdkAssistantMessage("registry ok")),
    });
    setSdkRegistryOverride(() => registry);
    assert.equal(getSdkRegistry(), registry);
    const compat = installCompatFakes({ stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")) });

    const { content } = await callSecondaryModel("openai", "gpt-4o-mini", "system", "user", {
      thinking: "off",
      cwd,
    });
    assert.equal(content, "pi backend ok");
    assert.equal(state.streamSimpleCalls.length, 0, "registry must not stream when the pi backend is selected");
    assert.equal(state.findCalls, 0, "registry must not even resolve when the pi backend is selected");
    assert.equal(compat.count(), 0, "compat must not stream when the pi backend is selected");
  });

  it("retains cached OAuth refresh on the compat fallback: one resolution serves repeated callers", async () => {
    const agentDir = makeAgentDir();
    writeAuthJson(agentDir, {
      "test-provider": { type: "oauth", access: "tok", refresh: "ref", expiresAt: Date.now() + 60_000 },
    });
    const cwd = makeCwd();

    // Registry attached but unresolvable → the compat fallback owns the call,
    // so the legacy auth-reader OAuth path must stay in charge.
    const { registry } = makeCapableRegistry({ model: undefined });
    setSdkRegistryOverride(() => registry);
    const compat = installCompatFakes({
      compatModel: fakeSdkModel("test-provider", "test-model"),
      stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")),
    });
    let resolverCalls = 0;
    setSdkOAuthResolverOverride(async () => {
      resolverCalls += 1;
      return { apiKey: "sk-refreshed" };
    });

    const first = await callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd });
    const second = await callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd });

    assert.equal(first.content, "compat ok");
    assert.equal(second.content, "compat ok");
    assert.equal(resolverCalls, 1, "the cached refreshed credential must serve repeated callers without re-resolution");
    assert.equal(compat.count(), 2);
    // Both callers rode the refreshed API key — not the raw OAuth token.
    assert.equal(compat.streamSimpleCalls[0]?.options?.apiKey, "sk-refreshed");
    assert.equal(compat.streamSimpleCalls[1]?.options?.apiKey, "sk-refreshed");
  });

  it("serves concurrent fallback callers with the refreshed credential", async () => {
    const agentDir = makeAgentDir();
    writeAuthJson(agentDir, {
      "test-provider": { type: "oauth", access: "tok", refresh: "ref", expiresAt: Date.now() + 60_000 },
    });
    const cwd = makeCwd();

    const { registry } = makeCapableRegistry({ model: undefined }); // attached, unresolvable → fallback
    setSdkRegistryOverride(() => registry);
    const compat = installCompatFakes({
      compatModel: fakeSdkModel("test-provider", "test-model"),
      stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")),
    });
    let resolverCalls = 0;
    setSdkOAuthResolverOverride(async () => {
      resolverCalls += 1;
      // Small delay so the second caller reaches the join point while the
      // first resolution is still in flight.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { apiKey: "sk-refreshed" };
    });

    const [a, b] = await Promise.all([
      callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd }),
      callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd }),
    ]);

    assert.equal(a.content, "compat ok");
    assert.equal(b.content, "compat ok");
    assert.equal(resolverCalls, 1, "concurrent same-credential callers share one OAuth resolution");
    // Every caller rode the refreshed key, not the raw OAuth token. Exactly-once
    // is provided by the in-flight dedupe (the production exactly-once refresh
    // guarantee is Pi's AuthStorage lockfile, layered above this).
    assert.equal(compat.streamSimpleCalls[0]?.options?.apiKey, "sk-refreshed");
    assert.equal(compat.streamSimpleCalls[1]?.options?.apiKey, "sk-refreshed");
  });

  it("keeps the http backend independent of an attached registry", async () => {
    makeAgentDir();
    const cwd = makeCwd();
    // baseUrl set → the resolver picks the http backend before sdk-backend is
    // ever consulted; neither the registry nor compat may serve the call.
    const piDir = join(cwd, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "settings.json"),
      JSON.stringify(
        {
          "pi-yoowai": {
            secondary: {
              provider: "custom-provider",
              id: "x",
              baseUrl: "https://custom.example.com/v1",
              apiKey: "sk-test",
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { registry, state } = makeCapableRegistry({
      model: fakeSdkModel("custom-provider", "x"),
      streamSimple: fakeSdkStream(fakeSdkAssistantMessage("registry ok")),
    });
    setSdkRegistryOverride(() => registry);
    assert.equal(getSdkRegistry(), registry);
    const compat = installCompatFakes({ stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")) });

    const originalFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "http ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const { content } = await callSecondaryModel("custom-provider", "x", "system", "user", { cwd });
      assert.equal(content, "http ok");
      assert.equal(fetchCalls, 1, "http backend must serve via fetch");
      assert.equal(state.streamSimpleCalls.length, 0, "registry must not stream when the http backend is selected");
      assert.equal(state.findCalls, 0, "registry must not even resolve when the http backend is selected");
      assert.equal(compat.count(), 0, "compat must not stream when the http backend is selected");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("serves calls through the session-attached registry and falls back after detach", async () => {
    makeAgentDir();
    const cwd = makeCwd();
    const { registry, state } = makeCapableRegistry({
      model: fakeSdkModel("test-provider", "test-model"),
      streamSimple: fakeSdkAssistantMessage("session registry ok"),
    });
    setSdkSessionRegistry(() => registry);
    const compat = installCompatFakes({ compatModel: fakeSdkModel("test-provider", "test-model") });

    // Attached: the session accessor feeds the dispatch (this is the path
    // attachSessionRegistry establishes on session_start in index.ts).
    const attached = await callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd });
    assert.equal(attached.content, "session registry ok");
    assert.equal(state.streamSimpleCalls.length, 1);
    assert.equal(compat.count(), 0, "an attached registry must win over the compat route");

    // Detached (session switch/shutdown): the compat route resumes.
    setSdkSessionRegistry(null);
    assert.equal(getSdkRegistry(), undefined);
    const detached = await callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd });
    assert.equal(detached.content, "compat ok");
    assert.equal(state.streamSimpleCalls.length, 1, "the registry must not serve calls after detach");
    assert.equal(compat.count(), 1, "the compat route must resume after detach");
  });

  it("shares a failing OAuth resolution with concurrent callers and resolves fresh afterwards", async () => {
    const agentDir = makeAgentDir();
    writeAuthJson(agentDir, {
      "test-provider": { type: "oauth", access: "tok", refresh: "ref", expiresAt: Date.now() + 60_000 },
    });
    const cwd = makeCwd();
    const { registry } = makeCapableRegistry({ model: undefined }); // attached, unresolvable → fallback
    setSdkRegistryOverride(() => registry);
    const compat = installCompatFakes({
      compatModel: fakeSdkModel("test-provider", "test-model"),
      stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")),
    });
    let resolverCalls = 0;
    const started = makeDeferred<void>();
    const failureGate = makeDeferred<never>();
    setSdkOAuthResolverOverride(async () => {
      resolverCalls += 1;
      if (resolverCalls === 1) {
        started.resolve();
        await failureGate.promise;
      }
      return { apiKey: "sk-recovered" };
    });

    // Both callers start while the first resolution is held open, so both join
    // the same in-flight entry before it settles: each callSdkBackend invocation
    // runs synchronously through resolveSdkAuth into the in-flight join (or the
    // override, which signals `started`) before its first await — so by the time
    // this function next suspends, both callers have already joined. The failure
    // is a plain error (not a 401), so the 401 retry path must not engage, and
    // allSettled is NOT awaited until after the gate releases (awaiting it first
    // would deadlock: the callers cannot settle until the rejection lands).
    const results = Promise.allSettled([
      callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd }),
      callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd }),
    ]);
    await started.promise;
    failureGate.reject(new Error("oauth exchange down"));
    const settled = await results;

    assert.equal(settled[0]?.status, "rejected");
    assert.equal(settled[1]?.status, "rejected");
    assert.match(
      String(settled[0] && settled[0].status === "rejected" ? settled[0].reason : ""),
      /oauth exchange down/,
    );
    assert.match(String(settled[1]?.status === "rejected" ? settled[1].reason : ""), /oauth exchange down/);
    assert.equal(resolverCalls, 1, "concurrent same-key callers share one failing resolution");
    assert.equal(compat.count(), 0, "no stream call may happen when OAuth resolution fails");

    // The in-flight entry was removed on settle: a later caller gets a fresh
    // resolution (and the recovered credential), not the cached failure.
    const recovered = await callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd });
    assert.equal(recovered.content, "compat ok");
    assert.equal(resolverCalls, 2, "a failed resolution must not poison later callers");
    assert.equal(compat.streamSimpleCalls[0]?.options?.apiKey, "sk-recovered");
  });

  it("isolates distinct credential hashes in concurrent in-flight resolutions", async () => {
    const agentDir = makeAgentDir();
    writeAuthJson(agentDir, {
      "test-provider": { type: "oauth", access: "cred-v1", refresh: "r1", expiresAt: Date.now() + 60_000 },
    });
    const cwd = makeCwd();
    const { registry } = makeCapableRegistry({ model: undefined });
    setSdkRegistryOverride(() => registry);
    const compat = installCompatFakes({
      compatModel: fakeSdkModel("test-provider", "test-model"),
      stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")),
    });
    let resolverCalls = 0;
    const started = [makeDeferred<void>(), makeDeferred<void>()];
    const gates = [makeDeferred<{ apiKey: string }>(), makeDeferred<{ apiKey: string }>()];
    setSdkOAuthResolverOverride(async () => {
      const myCall = ++resolverCalls;
      started[myCall - 1]?.resolve();
      return await gates[myCall - 1]!.promise;
    });

    // Caller 1 starts with credential v1 and blocks inside the resolver.
    const first = callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd });
    await started[0]!.promise;

    // The stored credential rotates WHILE the v1 resolution is still pending;
    // the v2 caller must create its own in-flight resolution, not join v1's.
    writeAuthJson(agentDir, {
      "test-provider": { type: "oauth", access: "cred-v2", refresh: "r2", expiresAt: Date.now() + 60_000 },
    });
    const second = callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd });
    await started[1]!.promise;
    assert.equal(resolverCalls, 2, "a distinct credential hash must resolve independently");

    gates[0].resolve({ apiKey: "sk-for-cred-v1" });
    gates[1].resolve({ apiKey: "sk-for-cred-v2" });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.content, "compat ok");
    assert.equal(secondResult.content, "compat ok");
    assert.equal(compat.streamSimpleCalls[0]?.options?.apiKey, "sk-for-cred-v1");
    assert.equal(compat.streamSimpleCalls[1]?.options?.apiKey, "sk-for-cred-v2");
  });

  it("runs independent in-flight resolutions for distinct providers concurrently", async () => {
    const agentDir = makeAgentDir();
    writeAuthJson(agentDir, {
      "test-provider": { type: "oauth", access: "tok-a", refresh: "r", expiresAt: Date.now() + 60_000 },
      "other-provider": { type: "oauth", access: "tok-b", refresh: "r", expiresAt: Date.now() + 60_000 },
    });
    const cwd = makeCwd();
    const { registry } = makeCapableRegistry({ model: undefined });
    setSdkRegistryOverride(() => registry);
    const compat = installCompatFakes({
      compatModel: fakeSdkModel("test-provider", "test-model"),
      stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")),
    });
    const providerKeys = new Map<string, string>();
    const started = [makeDeferred<void>(), makeDeferred<void>()];
    const gates = [makeDeferred<{ apiKey: string }>(), makeDeferred<{ apiKey: string }>()];
    let resolverCalls = 0;
    setSdkOAuthResolverOverride(async (provider: string) => {
      const myCall = ++resolverCalls;
      started[myCall - 1]?.resolve();
      const value = await gates[myCall - 1]!.promise;
      providerKeys.set(provider, value.apiKey);
      return value;
    });

    const pendingA = callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd });
    const pendingB = callSdkBackend("other-provider", "test-model", "sys", "usr", { cwd });
    await Promise.all([started[0]!.promise, started[1]!.promise]);
    assert.equal(resolverCalls, 2, "distinct providers must not share an in-flight resolution");
    gates[0].resolve({ apiKey: "sk-provider-a" });
    gates[1].resolve({ apiKey: "sk-provider-b" });

    const [a, b] = await Promise.all([pendingA, pendingB]);

    assert.equal(a.content, "compat ok");
    assert.equal(b.content, "compat ok");
    assert.equal(resolverCalls, 2, "distinct providers must not share an in-flight resolution");
    assert.equal(providerKeys.get("test-provider"), "sk-provider-a");
    assert.equal(providerKeys.get("other-provider"), "sk-provider-b");
    // The two stream calls carry exactly the two provider-specific keys (the
    // recording order between parallel calls is nondeterministic).
    assert.deepEqual(compat.streamSimpleCalls.map((c) => c.options?.apiKey).sort(), ["sk-provider-a", "sk-provider-b"]);
  });

  it("preserves image payloads through a registry-only image-capable model", async () => {
    makeAgentDir();
    const cwd = makeCwd();
    const image = { data: "aGk=", mimeType: "image/png" };
    const { registry, state } = makeCapableRegistry({
      model: fakeSdkModel("extension-provider", "vision-model", { input: ["text", "image"] }),
      streamSimple: fakeSdkAssistantMessage("registry image ok"),
    });
    setSdkRegistryOverride(() => registry);
    setSdkGetModelOverride(() => undefined); // compat catalog: unknown → registry-only
    const compat = installCompatFakes({ stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")) });

    const { content } = await callSdkBackend("extension-provider", "vision-model", "sys", "usr", {
      cwd,
      images: [image],
    });

    assert.equal(content, "registry image ok");
    assert.equal(compat.count(), 0, "registry route must serve the registry-only model");
    const call = state.streamSimpleCalls[0];
    assert.ok(call, "registry streamSimple must have been called");
    const parts = (call.context.messages[0] as unknown as { content: Array<Record<string, unknown>> }).content;
    assert.deepEqual(
      parts.find((p) => p.type === "image"),
      { type: "image", data: "aGk=", mimeType: "image/png" },
      "the base64 payload and MIME type must ride the registry context unchanged",
    );
    const textPart = parts.find((p) => p.type === "text") as { text?: string } | undefined;
    assert.equal(textPart?.text, "usr", "the text part must ride alongside the image");
  });

  it("preserves image payloads through the compat fallback", async () => {
    makeAgentDir();
    const cwd = makeCwd();
    const image = { data: "aGk=", mimeType: "image/png" };
    const { registry } = makeCapableRegistry({ model: undefined }); // unresolvable → fallback
    setSdkRegistryOverride(() => registry);
    const compat = installCompatFakes({
      compatModel: fakeSdkModel("test-provider", "vision-model", { input: ["text", "image"] }),
      stream: fakeSdkStream(fakeSdkAssistantMessage("compat image ok")),
    });

    const { content } = await callSdkBackend("test-provider", "vision-model", "sys", "usr", {
      cwd,
      images: [image],
    });

    assert.equal(content, "compat image ok");
    const call = compat.streamSimpleCalls[0];
    assert.ok(call, "compat streamSimple must have been called");
    const parts = (call.context.messages[0] as unknown as { content: Array<Record<string, unknown>> }).content;
    assert.deepEqual(
      parts.find((p) => p.type === "image"),
      { type: "image", data: "aGk=", mimeType: "image/png" },
      "the base64 payload and MIME type must ride the compat context unchanged",
    );
    const compatTextPart = parts.find((p) => p.type === "text") as { text?: string } | undefined;
    assert.equal(compatTextPart?.text, "usr", "the text part must ride alongside the image");
  });

  it("rejects image requests for text-only models on both routes", async () => {
    makeAgentDir();
    const cwd = makeCwd();
    const image = { data: "aGk=", mimeType: "image/png" };

    // Registry route: model resolves but declares text-only input.
    const { registry, state } = makeCapableRegistry({
      model: fakeSdkModel("test-provider", "test-model", { input: ["text"] }),
      streamSimple: fakeSdkStream(fakeSdkAssistantMessage("registry ok")),
    });
    setSdkRegistryOverride(() => registry);
    await assert.rejects(
      callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd, images: [image] }),
      /does not accept image input/,
    );
    assert.equal(state.streamSimpleCalls.length, 0, "a text-only model must never be streamed images");

    // Compat route: same gate before any provider call.
    setSdkRegistryOverride(null);
    const compat = installCompatFakes({
      compatModel: fakeSdkModel("test-provider", "test-model", { input: ["text"] }),
      stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")),
    });
    await assert.rejects(
      callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd, images: [image] }),
      /does not accept image input/,
    );
    assert.equal(compat.count(), 0, "a text-only compat model must never be streamed images");
  });

  it("keeps request options identical across registry and compat routes", async () => {
    makeAgentDir();
    const cwd = makeCwd();
    const secondary = {
      provider: "test-provider",
      id: "test-model",
      // Non-default values so a missed option shows up in the diff.
      cacheRetention: "long" as const,
      maxRetries: 5,
      timeoutMs: 123_456,
      maxRetryDelayMs: 9_000,
      transport: "auto" as const,
    };
    const runCall = () =>
      callSdkBackend("test-provider", "test-model", "sys", "usr", {
        cwd,
        thinking: "high",
        secondary,
      });

    const { registry, state } = makeCapableRegistry({
      model: fakeSdkModel("test-provider", "test-model"),
      streamSimple: fakeSdkAssistantMessage("registry ok"),
    });
    setSdkRegistryOverride(() => registry);
    await runCall();

    const registryOptions = state.streamSimpleCalls[0]?.options;
    assert.ok(registryOptions, "the registry route must record its options");
    const registryCall = state.streamSimpleCalls[0];

    // Now the identical request through the compat route: un-configure the
    // override and detach the session registry so compat serves the call.
    setSdkRegistryOverride(null);
    clearSdkRegistryOverride();
    setSdkSessionRegistry(null);
    const compat = installCompatFakes({
      compatModel: fakeSdkModel("test-provider", "test-model"),
      stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")),
    });
    await runCall();

    const compatOptions = compat.streamSimpleCalls[0]?.options;
    assert.ok(compatOptions, "the compat route must record its options");

    // Same effective request options on both routes. apiKey/headers are
    // undefined on both here (no auth sources configured in the test), and
    // onResponse/onPayload closures are intentionally excluded (identity).
    const comparable = (o: SimpleStreamOptions) => ({
      apiKey: o.apiKey,
      reasoning: o.reasoning,
      maxTokens: o.maxTokens,
      cacheRetention: o.cacheRetention,
      maxRetries: o.maxRetries,
      timeoutMs: o.timeoutMs,
      maxRetryDelayMs: o.maxRetryDelayMs,
      transport: o.transport,
      sessionId: o.sessionId,
      headers: o.headers,
      noSignal: o.signal === undefined,
    });
    assert.deepEqual(comparable(compatOptions), comparable(registryOptions));

    // And the request payload (system + user text) must match too.
    assert.equal(registryCall?.context.systemPrompt, compat.streamSimpleCalls[0]?.context.systemPrompt);
    const registryParts = (
      registryCall?.context.messages[0] as unknown as {
        content: Array<Record<string, unknown>>;
      }
    ).content;
    const compatParts = (
      compat.streamSimpleCalls[0]?.context.messages[0] as unknown as {
        content: Array<Record<string, unknown>>;
      }
    ).content;
    assert.deepEqual(registryParts, compatParts);
  });

  it("reuses the persisted refreshed credential across memory-cache evictions", async () => {
    const agentDir = makeAgentDir();
    writeAuthJson(agentDir, {
      "test-provider": { type: "oauth", access: "tok", refresh: "ref", expiresAt: Date.now() + 60_000 },
    });
    const cwd = makeCwd();
    const { registry } = makeCapableRegistry({ model: undefined }); // attached, unresolvable → fallback
    setSdkRegistryOverride(() => registry);
    const compat = installCompatFakes({
      compatModel: fakeSdkModel("test-provider", "test-model"),
      stream: fakeSdkStream(fakeSdkAssistantMessage("compat ok")),
    });
    let resolverCalls = 0;
    setSdkOAuthResolverOverride(async () => {
      resolverCalls += 1;
      // No newCredentials: auth.json stays byte-identical so the disk cache's
      // credential hash keeps matching across the simulated restart.
      return { apiKey: "sk-refreshed" };
    });

    await callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd });
    assert.equal(resolverCalls, 1);

    // Simulate a process restart: the in-memory cache is gone, but the
    // cwd-scoped disk cache (.pi/yoowai/oauth-cache.json) still holds the
    // refreshed key — the second resolution must not re-resolve.
    clearSdkOAuthCache();
    const second = await callSdkBackend("test-provider", "test-model", "sys", "usr", { cwd });

    assert.equal(second.content, "compat ok");
    assert.equal(resolverCalls, 1, "the persisted refreshed credential must be reused without re-resolution");
    assert.equal(compat.streamSimpleCalls[1]?.options?.apiKey, "sk-refreshed");
  });
});
