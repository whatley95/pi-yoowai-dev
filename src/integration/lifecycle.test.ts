import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
  TurnEndEvent,
  AgentSettledEvent,
  SessionBeforeCompactEvent,
  SessionBeforeSwitchEvent,
  SessionBeforeForkEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { registerLifecycleHandlers, triggerAutoJudge, type LifecycleDeps } from "./lifecycle.js";
import { setPlan, dropSessionState, getEditTracker, getState, markStepComplete } from "../session-state.js";
import { createLoopDetectionState, type LoopDetectionState } from "../loop-detector.js";
import type { WaiToolResult } from "../types.js";

type EmitToolResult = (event: ToolResultEvent, ctx: ExtensionContext) => void;
type EmitTurnEnd = (event: TurnEndEvent, ctx: ExtensionContext) => void;
type EmitAgentSettled = (event: AgentSettledEvent, ctx: ExtensionContext) => void;
type EmitModelSelect = () => void;
type EmitSessionBeforeCompact = (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => void;
type EmitSessionBeforeSwitch = (event: SessionBeforeSwitchEvent, ctx: ExtensionContext) => void;
type EmitSessionBeforeFork = (event: SessionBeforeForkEvent, ctx: ExtensionContext) => void;
type EmitSessionCompact = (event: SessionCompactEvent, ctx: ExtensionContext) => void;

type FakePi = {
  pi: ExtensionAPI;
  steers: { message: string; options?: Record<string, unknown> }[];
  emitToolResult: EmitToolResult;
  emitTurnEnd: EmitTurnEnd;
  emitAgentSettled: EmitAgentSettled;
  emitModelSelect: EmitModelSelect;
  emitSessionBeforeCompact: EmitSessionBeforeCompact;
  emitSessionBeforeSwitch: EmitSessionBeforeSwitch;
  emitSessionBeforeFork: EmitSessionBeforeFork;
  emitSessionCompact: EmitSessionCompact;
};

function createFakePi(): FakePi {
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const steers: { message: string; options?: Record<string, unknown> }[] = [];

  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    sendUserMessage: (message: string, options?: Record<string, unknown>) => {
      steers.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  const emit = (event: string, data: unknown, ctx: ExtensionContext) => {
    for (const handler of handlers.get(event) ?? []) {
      handler(data, ctx);
    }
  };

  return {
    pi,
    steers,
    emitToolResult: (event, ctx) => emit("tool_result", event, ctx),
    emitTurnEnd: (event, ctx) => emit("turn_end", event, ctx),
    emitAgentSettled: (event, ctx) => emit("agent_settled", event, ctx),
    emitModelSelect: () => emit("model_select", {}, {} as ExtensionContext),
    emitSessionBeforeCompact: (event, ctx) => emit("session_before_compact", event, ctx),
    emitSessionBeforeSwitch: (event, ctx) => emit("session_before_switch", event, ctx),
    emitSessionBeforeFork: (event, ctx) => emit("session_before_fork", event, ctx),
    emitSessionCompact: (event, ctx) => emit("session_compact", event, ctx),
  };
}

function makeContext(cwd: string): ExtensionContext {
  return {
    cwd,
    ui: {
      notify: () => {},
      setStatus: () => {},
    } as unknown as ExtensionContext["ui"],
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

function makeLoopStates(cwd: string): Map<string, LoopDetectionState> {
  const map = new Map<string, LoopDetectionState>();
  map.set(cwd, createLoopDetectionState());
  return map;
}

describe("lifecycle", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(tmpdir(), `wai-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
  });

  afterEach(() => {
    dropSessionState(cwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("increments edit counter on successful write/edit tool_result", () => {
    const { pi, emitToolResult } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd));

    emitToolResult(
      {
        type: "tool_result",
        toolName: "write",
        toolCallId: "1",
        input: {},
        content: [],
        isError: false,
      } as unknown as ToolResultEvent,
      makeContext(cwd),
    );
    emitToolResult(
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "2",
        input: {},
        content: [],
        isError: false,
      } as unknown as ToolResultEvent,
      makeContext(cwd),
    );

    const tracker = getEditTracker(cwd);
    assert.strictEqual(tracker.editsSinceLastReview, 2);
  });

  it("does not increment edit counter on failed write/edit tool_result", () => {
    const { pi, emitToolResult } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd));

    emitToolResult(
      {
        type: "tool_result",
        toolName: "write",
        toolCallId: "1",
        input: {},
        content: [],
        isError: true,
      } as unknown as ToolResultEvent,
      makeContext(cwd),
    );
    emitToolResult(
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "2",
        input: {},
        content: [],
        isError: true,
      } as unknown as ToolResultEvent,
      makeContext(cwd),
    );

    const tracker = getEditTracker(cwd);
    assert.strictEqual(tracker.editsSinceLastReview, 0);
  });

  it("sends a workflow steer at turn_end when unreviewed edits exist", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1"], acceptanceCriteria: [] });
    const state = getState(cwd);
    state.editsSinceLastReview = 3;

    const { pi, steers, emitTurnEnd } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd));

    emitTurnEnd(
      {
        type: "turn_end",
        turnIndex: 1,
        message: { role: "assistant", content: [] },
        toolResults: [{ toolName: "write", isError: false, content: [] }],
      } as unknown as TurnEndEvent,
      makeContext(cwd),
    );

    assert.strictEqual(steers.length, 1);
    assert.ok(steers[0].message.includes("3 file edit(s) since the last review"));
    assert.ok(steers[0].message.includes("WORKFLOW REMINDER"));
    assert.strictEqual(steers[0].options?.deliverAs, "steer");
  });

  it("respects steer cooldown at turn_end", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1"], acceptanceCriteria: [] });
    const state = getState(cwd);
    state.editsSinceLastReview = 3;
    state.lastSteerAt = Date.now();

    const { pi, steers, emitTurnEnd } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd));

    emitTurnEnd(
      {
        type: "turn_end",
        turnIndex: 1,
        message: { role: "assistant", content: [] },
        toolResults: [{ toolName: "write", isError: false, content: [] }],
      } as unknown as TurnEndEvent,
      makeContext(cwd),
    );

    assert.strictEqual(steers.length, 0);
  });

  it("triggers auto-judge on agent_settled when plan is complete and autoJudge is enabled", async () => {
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { autoJudge: true } }));
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1"], acceptanceCriteria: [] });
    markStepComplete(cwd);

    let judgeCalled = false;
    const deps: LifecycleDeps = {
      executeWaiJudge: async () => {
        judgeCalled = true;
        return {
          action: "judge",
          judge: { verdict: "pass", issues: [], suggestions: [], consensus: true, summary: "ok" },
        } as WaiToolResult;
      },
    };

    const { pi, emitAgentSettled } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd), deps);

    await emitAgentSettled({ type: "agent_settled" } as AgentSettledEvent, makeContext(cwd));

    assert.ok(judgeCalled);
    assert.ok(getState(cwd).judgeCompleted);
  });

  it("does not trigger auto-judge when plan is incomplete", async () => {
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { autoJudge: true } }));
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1", "Step 2"], acceptanceCriteria: [] });

    let judgeCalled = false;
    const deps: LifecycleDeps = {
      executeWaiJudge: async () => {
        judgeCalled = true;
        return {
          action: "judge",
          judge: { verdict: "pass", issues: [], suggestions: [], consensus: true, summary: "ok" },
        } as WaiToolResult;
      },
    };

    const { pi, emitAgentSettled } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd), deps);

    await emitAgentSettled({ type: "agent_settled" } as AgentSettledEvent, makeContext(cwd));

    assert.strictEqual(judgeCalled, false);
  });

  it("clears prompt cache on model_select", async () => {
    let cleared = false;
    const deps: LifecycleDeps = {
      clearPromptCache: () => {
        cleared = true;
      },
    };

    const { pi, emitModelSelect } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd), deps);

    emitModelSelect();

    assert.ok(cleared);
  });

  it("sets custom instructions on session_before_compact when a plan is active", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1", "Step 2"], acceptanceCriteria: [] });

    const { pi, emitSessionBeforeCompact } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd));

    const event = {
      type: "session_before_compact",
      customInstructions: "Existing instructions.",
      preparation: {},
      branchEntries: [],
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    } as unknown as SessionBeforeCompactEvent;

    emitSessionBeforeCompact(event, makeContext(cwd));

    assert.ok(event.customInstructions!.includes("Existing instructions."));
    assert.ok(event.customInstructions!.includes("Active wai plan: Refactor auth"));
    assert.ok(event.customInstructions!.includes("Progress: 0/2 steps completed"));
    assert.ok(event.customInstructions!.includes("Current step: Step 1"));
  });

  it("triggerAutoJudge exposes the situation to the judge runner", async () => {
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { autoJudge: true } }));
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1"], acceptanceCriteria: [] });
    markStepComplete(cwd);

    let receivedDescription = "";
    const runJudge = async (_cwd: string, description: string) => {
      receivedDescription = description;
      return {
        action: "judge",
        judge: { verdict: "pass", issues: [], suggestions: [], consensus: true, summary: "ok" },
      } as WaiToolResult;
    };

    await triggerAutoJudge(makeContext(cwd), "Final verification.", runJudge);

    assert.strictEqual(receivedDescription, "Final verification.");
  });

  it("flushes volatile counters to disk on session_before_switch", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1"], acceptanceCriteria: [] });
    getState(cwd).editsSinceLastReview = 5;

    const { pi, emitSessionBeforeSwitch } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd));

    emitSessionBeforeSwitch(
      { type: "session_before_switch", reason: "resume" } as SessionBeforeSwitchEvent,
      makeContext(cwd),
    );

    const saved = JSON.parse(readFileSync(join(cwd, ".pi", "yoowai", "plan.json"), "utf-8"));
    assert.strictEqual(saved.editsSinceLastReview, 5);
  });

  it("flushes volatile counters to disk on session_before_fork", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1"], acceptanceCriteria: [] });
    getState(cwd).editsSinceLastDone = 7;

    const { pi, emitSessionBeforeFork } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd));

    emitSessionBeforeFork(
      { type: "session_before_fork", entryId: "abc", position: "at" } as SessionBeforeForkEvent,
      makeContext(cwd),
    );

    const saved = JSON.parse(readFileSync(join(cwd, ".pi", "yoowai", "plan.json"), "utf-8"));
    assert.strictEqual(saved.editsSinceLastDone, 7);
  });

  it("flushes volatile counters to disk on session_compact", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1"], acceptanceCriteria: [] });
    getState(cwd).editsSinceLastReview = 4;

    const { pi, emitSessionCompact } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd));

    emitSessionCompact(
      {
        type: "session_compact",
        compactionEntry: {
          type: "compaction",
          id: "c1",
          parentId: null,
          timestamp: new Date().toISOString(),
          summary: "",
          firstKeptEntryId: "e1",
          tokensBefore: 100,
        },
        fromExtension: false,
        reason: "threshold",
        willRetry: false,
      } as SessionCompactEvent,
      makeContext(cwd),
    );

    const saved = JSON.parse(readFileSync(join(cwd, ".pi", "yoowai", "plan.json"), "utf-8"));
    assert.strictEqual(saved.editsSinceLastReview, 4);
  });
});
