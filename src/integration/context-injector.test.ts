import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ContextEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContextInjector, setWaiToolExecuting } from "./context-injector.js";
import { setPlan, recordFileEdit, setPlanProgress } from "../session-state.js";
import { recordIssues } from "../review-memory.js";
import { recordLearnedFact } from "../wai-learn.js";
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

  it("includes learned facts and decisions in the injected context", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Move login logic"], acceptanceCriteria: [] });
    recordLearnedFact(cwd, "auth uses token refresh", { category: "auth" });
    recordLearnedFact(cwd, "never update lockfile manually", { kind: "decision" });

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);
    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    const content = typeof lastUser?.content === "string" ? lastUser.content : "";
    assert.ok(content.includes("<project_knowledge>"));
    assert.ok(content.includes("auth uses token refresh"));
    assert.ok(content.includes("[decision] never update lockfile manually"), "decisions carry a [decision] marker");
  });

  it("omits the project-knowledge block when no facts are recorded", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Move login logic"], acceptanceCriteria: [] });

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);
    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    const content = typeof lastUser?.content === "string" ? lastUser.content : "";
    assert.ok(!content.includes("<project_knowledge>"), "no facts → no knowledge block");
  });

  it("drops project knowledge first when the context exceeds its budget", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Move login logic"], acceptanceCriteria: [] });
    // A big learned store + conventions, with a tiny contextInjectMaxTokens.
    for (let i = 0; i < 30; i++) {
      recordLearnedFact(cwd, `fact ${i}: ${"x".repeat(80)}`);
    }
    saveConventions(cwd, {
      stack: "Node/TS",
      naming: "camelCase",
      structure: "src/",
      patterns: [],
      entryPoints: [],
      scripts: [],
      generatedAt: new Date().toISOString(),
    });
    const configDir = join(cwd, ".pi");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({
        "pi-yoowai": {
          autoInjectContext: true,
          contextInjectMaxTokens: 40,
          secondary: { provider: "openai", id: "gpt-4o-mini" },
        },
      }),
      "utf-8",
    );

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);
    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    const content = typeof lastUser?.content === "string" ? lastUser.content : "";
    assert.ok(
      !content.includes("<project_knowledge>"),
      "project knowledge must be dropped first under budget pressure",
    );
    assert.ok(content.includes("Refactor auth"), "the plan must survive budget pressure");
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
    // An active plan with remaining steps adds the done nudge.
    assert.ok(lastUser.content.includes("wai({ done: true })"));
    assert.ok(lastUser.content.includes("plan step (1/1)"));
  });

  it("nudges judge when the plan is complete but never judged", () => {
    setPlan(cwd, {
      summary: "Refactor auth",
      todo: ["Step 1", "Step 2"],
      acceptanceCriteria: [],
    });
    setPlanProgress(cwd, 2);

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);

    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    assert.ok(lastUser);
    assert.ok(typeof lastUser.content === "string");
    assert.ok(lastUser.content.includes("PLAN COMPLETE"));
    assert.ok(lastUser.content.includes("wai({ judge"));
  });

  it("nudges plan creation when edits pile up with no active plan", () => {
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
    assert.ok(lastUser.content.includes("No active wai plan"));
  });

  it("injects advisor notes from review memory of edited files", () => {
    recordFileEdit(cwd, "src/auth.ts");
    recordIssues(cwd, [
      {
        severity: "high",
        file: "src/auth.ts",
        issue: "Missing try/catch around token refresh",
        suggestion: "Wrap it",
      },
    ]);

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);

    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    assert.ok(lastUser);
    assert.ok(typeof lastUser.content === "string");
    assert.ok(lastUser.content.includes("<advisor_notes>"), "advisor notes must be injected");
    assert.ok(lastUser.content.includes("Missing try/catch around token refresh"));
  });

  it("suppresses advisor notes when advisorNotes is false", () => {
    recordFileEdit(cwd, "src/auth.ts");
    recordIssues(cwd, [
      {
        severity: "high",
        file: "src/auth.ts",
        issue: "Missing try/catch around token refresh",
        suggestion: "Wrap it",
      },
    ]);
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { advisorNotes: false } }));

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);

    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    assert.ok(lastUser);
    assert.strictEqual(lastUser.content, "first", "no injection at all when advisorNotes is false");
  });

  it("omits advisor notes when there is no review memory", () => {
    recordFileEdit(cwd, "src/auth.ts");

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);

    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    assert.ok(lastUser);
    assert.ok(typeof lastUser.content === "string");
    assert.ok(!lastUser.content.includes("<advisor_notes>"));
  });

  it("caps oversized advisor notes with balanced tags and keeps reminders", () => {
    // 3 edits → workflow reminder fires; 40 large issues → notes far over a
    // tiny budget. The notes must be shrunk IN PLACE (balanced tags, truncation
    // marker) while the reminder survives whole-block truncation.
    for (let i = 0; i < 3; i++) recordFileEdit(cwd, "src/auth.ts");
    recordIssues(
      cwd,
      Array.from({ length: 40 }, (_, i) => ({
        severity: "high",
        file: "src/auth.ts",
        issue: `Long standing issue number ${i} ` + "x".repeat(200),
        suggestion: "Fix it",
      })),
    );
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { contextInjectMaxTokens: 100 } }));

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);

    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    assert.ok(lastUser);
    assert.ok(typeof lastUser.content === "string");
    const content = lastUser.content;
    // Balanced tags and a truncation marker inside the notes block.
    assert.ok(content.includes("<advisor_notes>"), "notes block must be present");
    assert.ok(content.includes("</advisor_notes>"), "notes block must be closed");
    assert.ok(content.includes("advisor notes truncated"), "notes content must be capped in place");
    // Reminders survive: they come after the notes in the block.
    assert.ok(content.includes("WORKFLOW REMINDER"), "workflow reminder must survive truncation");
    // The whole wrapper stays intact — no tail truncation of the block.
    assert.ok(content.includes("</wai_context>"), "wai_context wrapper must stay closed");
    assert.ok(
      !content.includes("truncated to token budget"),
      "the generic whole-block truncation fallback must not be needed",
    );
    // The injected block stays strictly within the token budget.
    const injected = content.slice(content.indexOf("<wai_context>"));
    assert.ok(Math.ceil(injected.length / 4) <= 100, "injected context must respect contextInjectMaxTokens");
  });

  it("never leaves a lone surrogate when advisor notes contain astral characters", () => {
    // Emoji-heavy issues: wherever the truncation boundary lands, the injected
    // text must not contain a split surrogate pair.
    recordFileEdit(cwd, "src/auth.ts");
    recordIssues(
      cwd,
      Array.from({ length: 30 }, (_, i) => ({
        severity: "high",
        file: "src/auth.ts",
        issue: `Emoji issue ${i} 🚀🎯 ` + "z".repeat(150),
        suggestion: "Fix it",
      })),
    );
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { contextInjectMaxTokens: 80 } }));

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);

    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    assert.ok(lastUser);
    assert.ok(typeof lastUser.content === "string");
    const injected = lastUser.content.slice(lastUser.content.indexOf("<wai_context>"));
    const loneHigh = injected.match(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const loneLow = injected.match(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    assert.equal(loneHigh, null, "no lone high surrogate may remain");
    assert.equal(loneLow, null, "no lone low surrogate may remain");
  });
});
