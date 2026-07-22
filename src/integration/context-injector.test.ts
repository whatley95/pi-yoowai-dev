import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ContextEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContextInjector, setWaiToolExecuting } from "./context-injector.js";
import { setPlan, recordFileEdit } from "../session-state.js";
import { saveConventions } from "../conventions.js";

type FakePi = {
  pi: ExtensionAPI;
  contexts: ContextEvent[];
  steers: string[];
  emitContext(event: ContextEvent, ctx: ExtensionContext): void;
};

function createFakePi(): FakePi {
  const contexts: ContextEvent[] = [];
  const steers: string[] = [];
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();

  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    sendUserMessage: (message: string) => {
      steers.push(message);
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    contexts,
    steers,
    emitContext(event: ContextEvent, ctx: ExtensionContext) {
      contexts.push(event);
      for (const handler of handlers.get("context") ?? []) {
        handler(event, ctx);
      }
    },
  };
}

function makeContext(cwd: string): ExtensionContext {
  return {
    cwd,
    ui: {} as ExtensionContext["ui"],
    sessionManager: {} as ExtensionContext["sessionManager"],
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: undefined,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
  };
}

function makeMessages(): ContextEvent {
  return {
    type: "context",
    messages: [
      { role: "user", content: "first", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "openai",
        provider: "openai",
        model: "gpt-4",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    ],
  };
}

describe("context-injector", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(tmpdir(), `wai-context-injector-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("appends context when state exists and autoInjectContext is true", () => {
    setPlan(cwd, {
      summary: "Refactor auth",
      todo: ["Move login logic", "Update tests"],
      acceptanceCriteria: ["Tests pass"],
    });
    saveConventions(cwd, {
      stack: "Node/TS",
      naming: "camelCase",
      structure: "src/",
      patterns: ["async/await"],
      entryPoints: ["src/index.ts"],
      scripts: ["test"],
      generatedAt: new Date().toISOString(),
    });

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);

    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    assert.ok(lastUser);
    assert.ok(typeof lastUser.content === "string");
    assert.ok(lastUser.content.startsWith("first"));
    assert.ok(lastUser.content.includes("Refactor auth"));
    assert.ok(lastUser.content.includes("Node/TS"));
  });

  it("does nothing when autoInjectContext is false", () => {
    setPlan(cwd, {
      summary: "Refactor auth",
      todo: ["Move login logic"],
      acceptanceCriteria: [],
    });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { autoInjectContext: false } }));

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);

    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    assert.ok(lastUser);
    assert.strictEqual(lastUser.content, "first");
  });

  it("respects contextInjectMaxTokens", () => {
    setPlan(cwd, {
      summary: "A".repeat(10_000),
      todo: ["Step 1"],
      acceptanceCriteria: [],
    });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { contextInjectMaxTokens: 10 } }));

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);

    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    assert.ok(lastUser);
    assert.ok(typeof lastUser.content === "string");
    assert.ok(lastUser.content.includes("truncated to token budget"));
  });

  it("skips injection during wai tool execution", () => {
    setPlan(cwd, {
      summary: "Refactor auth",
      todo: ["Step 1"],
      acceptanceCriteria: [],
    });

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);

    setWaiToolExecuting(cwd, true);
    const event = makeMessages();
    emitContext(event, makeContext(cwd));
    setWaiToolExecuting(cwd, false);

    const lastUser = event.messages.find((m) => m.role === "user");
    assert.ok(lastUser);
    assert.strictEqual(lastUser.content, "first");
  });

  it("includes workflow reminder when edits exceed threshold", () => {
    setPlan(cwd, {
      summary: "Refactor auth",
      todo: ["Step 1"],
      acceptanceCriteria: [],
    });
    recordFileEdit(cwd);
    recordFileEdit(cwd);
    recordFileEdit(cwd);

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);

    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    assert.ok(lastUser);
    assert.ok(typeof lastUser.content === "string");
    assert.ok(lastUser.content.includes("WORKFLOW REMINDER"));
    assert.ok(lastUser.content.includes("3 file edit(s) since the last review"));
  });
});
