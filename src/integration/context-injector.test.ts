import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ContextEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  registerContextInjector,
  setWaiToolExecuting,
  beginWaiToolExecution,
  clearWaiToolExecution,
} from "./context-injector.js";
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
    ...{ scopedModels: [] },
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
    clearWaiToolExecution(cwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("keeps injection suppressed until every overlapping execution finishes and ignores stale cleanup", () => {
    setPlan(cwd, { summary: "overlap", todo: ["one"], acceptanceCriteria: [] });
    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);
    const first = beginWaiToolExecution(cwd);
    const second = beginWaiToolExecution(cwd);
    first();
    first();
    const suppressed = makeMessages();
    emitContext(suppressed, makeContext(cwd));
    assert.ok(!JSON.stringify(suppressed).includes("<wai_context>"));
    clearWaiToolExecution(cwd);
    const replacement = beginWaiToolExecution(cwd);
    second();
    const stillSuppressed = makeMessages();
    emitContext(stillSuppressed, makeContext(cwd));
    assert.ok(!JSON.stringify(stillSuppressed).includes("<wai_context>"));
    replacement();
    const restored = makeMessages();
    emitContext(restored, makeContext(cwd));
    assert.ok(JSON.stringify(restored).includes("<wai_context>"));
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

  it("reminds the main agent to schedule intended SVN files before final review even without a plan", () => {
    mkdirSync(join(cwd, ".svn"));
    const nestedCwd = join(cwd, "src");
    mkdirSync(nestedCwd);
    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);
    const event = makeMessages();
    emitContext(event, makeContext(nestedCwd));
    const message = event.messages.find((entry) => entry.role === "user");
    assert.ok(message && typeof message.content === "string");
    const content = message.content;
    assert.ok(content.includes("SVN WORKFLOW"));
    assert.ok(content.includes("svn commit omits files marked ?"));
    assert.ok(content.includes("Before the final whole-tree review"));
    assert.ok(content.includes("svn add --parents -- <explicit file paths>"));
    assert.ok(content.includes("do not bulk-add '.', .pi/, generated outputs, or unrelated files"));
    assert.ok(content.includes("verify intended new files show A"));
    assert.ok(content.includes("run the whole-tree review again"));
  });

  it("uses the nearest VCS marker for the SVN workflow reminder", () => {
    mkdirSync(join(cwd, ".svn"));
    const gitCwd = join(cwd, "git-project");
    mkdirSync(join(gitCwd, ".git"), { recursive: true });
    const svnCwd = join(gitCwd, "svn-project");
    mkdirSync(join(svnCwd, ".svn"), { recursive: true });
    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);
    for (const [directory, expected] of [
      [gitCwd, false],
      [svnCwd, true],
    ] as const) {
      const event = makeMessages();
      emitContext(event, makeContext(directory));
      const message = event.messages.find((entry) => entry.role === "user");
      assert.ok(message && typeof message.content === "string");
      assert.equal(message.content.includes("SVN WORKFLOW"), expected);
      assert.equal(message.content.includes("GIT WORKFLOW"), !expected);
    }
  });

  it("injects Git commit preparation guidance without a plan and recognizes worktree marker files", () => {
    writeFileSync(join(cwd, ".git"), "gitdir: elsewhere\n");
    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);
    const event = makeMessages();
    emitContext(event, makeContext(cwd));
    const message = event.messages.find((entry) => entry.role === "user");
    assert.ok(message && typeof message.content === "string");
    assert.ok(message.content.includes("GIT WORKFLOW"));
    assert.ok(message.content.includes("stage only intended task files or hunks"));
    assert.ok(message.content.includes("using explicit paths"));
    assert.ok(message.content.includes("git diff --cached"));
    assert.ok(message.content.includes("intended new files are included"));
    assert.ok(message.content.includes("Before an authorized commit"));
    assert.ok(message.content.includes("If staging changes after review"));
    assert.ok(!message.content.includes("SVN WORKFLOW"));
  });

  it("injects the configured language directive before all other context", () => {
    setPlan(cwd, {
      summary: "Refactor auth",
      todo: ["Move login logic"],
      acceptanceCriteria: ["Tests pass"],
    });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { language: "French" } }));

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);
    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    assert.ok(lastUser && typeof lastUser.content === "string");
    const block = lastUser.content.slice(lastUser.content.indexOf("<wai_context>"));
    assert.ok(
      block.startsWith(
        "<wai_context>\nLanguage: respond in French.\n\nPlan: Refactor auth\nProgress: 0/1 steps completed\nCurrent step: Move login logic",
      ),
    );
    assert.match(
      block,
      /PLAN ALIGNMENT:.*partial diff, unfinished step, or unchanged preservation check does not make a plan stale/s,
    );
    assert.ok(block.endsWith("\n</wai_context>"));
  });

  it("injects only the language directive when no other context exists", () => {
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { language: "Japanese" } }));

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);
    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    assert.ok(lastUser && typeof lastUser.content === "string");
    assert.equal(lastUser.content, "first\n\n<wai_context>\nLanguage: respond in Japanese.\n</wai_context>");
  });

  it("injects no block at all when language is unset and no other context exists", () => {
    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);
    const event = makeMessages();
    emitContext(event, makeContext(cwd));

    const lastUser = event.messages.find((m) => m.role === "user");
    assert.ok(lastUser && typeof lastUser.content === "string");
    assert.equal(lastUser.content, "first");
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

  it("excludes stale facts/decisions from injection before the 20-item slice", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Move login logic"], acceptanceCriteria: [] });
    // 25 fresh entries — only the newest 20 fit the 20-item slice.
    for (let i = 0; i < 25; i++) {
      recordLearnedFact(cwd, `fresh ${i}: ${"x".repeat(20)}`);
    }
    // FOUR stale entries recorded AFTER the fresh ones (they sort ahead as
    // newest) but must not displace any eligible fresh entry.
    for (let i = 0; i < 4; i++) {
      recordLearnedFact(cwd, `stale decision ${i}`, { kind: "decision" });
    }
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    for (const f of store.facts) {
      if (f.fact.startsWith("stale decision")) {
        f.lastVerifiedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
      }
    }
    writeFileSync(path, JSON.stringify(store));

    const { pi, emitContext } = createFakePi();
    registerContextInjector(pi);
    const event = makeMessages();
    emitContext(event, makeContext(cwd));
    const lastUser = event.messages.find((m) => m.role === "user");
    const content = typeof lastUser?.content === "string" ? lastUser.content : "";
    assert.ok(content.includes("<project_knowledge>"));
    assert.ok(!content.includes("stale decision"), "stale entries must never be injected");
    // The newest 20 fresh entries (fresh-24 … fresh-5) are all present; the
    // oldest five fresh entries are cut by the 20-item slice, not staleness.
    for (let i = 5; i <= 24; i++) {
      assert.ok(content.includes(`fresh ${i}: `), `fresh ${i} must be injected`);
    }
    for (let i = 0; i <= 4; i++) {
      assert.ok(!content.includes(`fresh ${i}: `), `fresh ${i} must yield to the 20-item slice`);
    }
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
    // Inspect progress first: review may already advance the completed step.
    assert.ok(lastUser.content.includes("review.planProgress/review.nextStep"));
    assert.ok(lastUser.content.includes("only if the same reviewed step remains current"));
    assert.ok(lastUser.content.includes("do not advance an unfinished next step"));
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
