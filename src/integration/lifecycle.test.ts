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
import { setAuditExtensionAPI } from "./audit.js";
import {
  setPlan,
  dropSessionState,
  getEditTracker,
  getState,
  markStepComplete,
  resetEditsSinceReview,
} from "../session-state.js";
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
  entries: { type: string; data: unknown }[];
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
  const entries: { type: string; data: unknown }[] = [];

  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    sendUserMessage: (message: string, options?: Record<string, unknown>) => {
      steers.push({ message, options });
    },
    appendEntry: (type: string, data: unknown) => {
      entries.push({ type, data });
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
    entries,
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
    // With an active plan the reminder names the current step.
    assert.ok(steers[0].message.includes("Step 1/1 (Step 1) has 3 unreviewed file edit(s)"));
    assert.ok(steers[0].message.includes("WORKFLOW REMINDER"));
    // An active plan with remaining steps adds the done nudge.
    assert.ok(steers[0].message.includes("wai({ done: true })"));
    assert.ok(steers[0].message.includes("plan step (1/1)"));
    assert.strictEqual(steers[0].options?.deliverAs, "steer");
  });

  it("omits the done nudge in the steer when no plan is active", () => {
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
    assert.ok(steers[0].message.includes("WORKFLOW REMINDER"));
    assert.ok(!steers[0].message.includes("done: true"));
    // Without an active plan the reminder keeps its byte-identical fallback
    // phrasing (no step label) and nudges plan creation instead.
    assert.ok(
      steers[0].message.startsWith(
        "WORKFLOW REMINDER: you have made 3 file edit(s) since the last review. " +
          "Call `wai({ review: '...' })` to review the changes before continuing.",
      ),
    );
    assert.ok(steers[0].message.includes("No active wai plan"));
  });

  it("lists actually edited files in the steer, capped at five", () => {
    const { pi, steers, emitToolResult, emitTurnEnd } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd));

    for (let i = 1; i <= 7; i++) {
      emitToolResult(
        {
          type: "tool_result",
          toolName: "write",
          toolCallId: String(i),
          input: { path: `src/file${i}.ts` },
          content: [],
          isError: false,
        } as unknown as ToolResultEvent,
        makeContext(cwd),
      );
    }

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
    assert.ok(steers[0].message.includes("src/file1.ts"));
    assert.ok(steers[0].message.includes("src/file5.ts"));
    assert.ok(!steers[0].message.includes("src/file6.ts"));
    assert.ok(steers[0].message.includes("(+2 more)"));
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
    // Flush the async handler chain (auto-review check runs before auto-judge).
    await new Promise((resolve) => setImmediate(resolve));

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
    await new Promise((resolve) => setImmediate(resolve));

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

  it("escalates the steer after K consecutive turn_ends with review pending", () => {
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { steerEscalationThreshold: 2 } }));
    const state = getState(cwd);
    state.editsSinceLastReview = 3;

    const { pi, steers, emitTurnEnd } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd));

    const turnEnd = {
      type: "turn_end",
      turnIndex: 1,
      message: { role: "assistant", content: [] },
      toolResults: [{ toolName: "write", isError: false, content: [] }],
    } as unknown as TurnEndEvent;

    emitTurnEnd(turnEnd, makeContext(cwd));
    assert.strictEqual(steers.length, 1);
    assert.ok(steers[0].message.includes("WORKFLOW REMINDER"));
    assert.ok(!steers[0].message.includes("STOP"));

    // Bypass the cooldown so the second turn_end steers again.
    state.lastSteerAt = 0;
    emitTurnEnd(turnEnd, makeContext(cwd));
    assert.strictEqual(steers.length, 2);
    assert.ok(steers[1].message.includes("STOP. Do not continue new work until `wai review` has been run"));
    assert.strictEqual(steers[1].options?.deliverAs, "steer");
  });

  it("names the current plan step in the escalated STOP steer", () => {
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { steerEscalationThreshold: 1 } }));
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1", "Step 2"], acceptanceCriteria: [] });
    const state = getState(cwd);
    state.editsSinceLastReview = 2;

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
    assert.ok(steers[0].message.includes("STOP"));
    assert.ok(steers[0].message.includes("Step 1/2 (Step 1) has 2 unreviewed file edit(s)"));
  });

  it("counts turns with review pending even while the steer cooldown suppresses the message", () => {
    const state = getState(cwd);
    state.editsSinceLastReview = 3;

    const { pi, steers, emitTurnEnd } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd));

    const turnEnd = {
      type: "turn_end",
      turnIndex: 1,
      message: { role: "assistant", content: [] },
      toolResults: [{ toolName: "write", isError: false, content: [] }],
    } as unknown as TurnEndEvent;

    emitTurnEnd(turnEnd, makeContext(cwd));
    emitTurnEnd(turnEnd, makeContext(cwd));
    // Cooldown suppresses the second steer, but the turn still counted.
    assert.strictEqual(steers.length, 1);
    assert.strictEqual(getState(cwd).unreviewedTurns, 2);
  });

  it("resets the escalation streak when a review runs", () => {
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { steerEscalationThreshold: 2 } }));
    const state = getState(cwd);
    state.editsSinceLastReview = 3;

    const { pi, steers, emitTurnEnd } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd));

    const turnEnd = {
      type: "turn_end",
      turnIndex: 1,
      message: { role: "assistant", content: [] },
      toolResults: [{ toolName: "write", isError: false, content: [] }],
    } as unknown as TurnEndEvent;

    emitTurnEnd(turnEnd, makeContext(cwd));
    state.lastSteerAt = 0;
    emitTurnEnd(turnEnd, makeContext(cwd));
    assert.ok(steers[1].message.includes("STOP"));

    // A review clears the pending edits and the consecutive-turn streak.
    resetEditsSinceReview(cwd);
    assert.strictEqual(getState(cwd).unreviewedTurns, 0);

    state.editsSinceLastReview = 2;
    state.lastSteerAt = 0;
    emitTurnEnd(turnEnd, makeContext(cwd));
    assert.strictEqual(steers.length, 3);
    assert.ok(steers[2].message.includes("WORKFLOW REMINDER"));
    assert.ok(!steers[2].message.includes("STOP"));
  });

  it("triggers auto-review before auto-judge on agent_settled when autoReviewOnSettle is enabled", async () => {
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ "pi-yoowai": { autoReviewOnSettle: true, autoJudge: true } }),
    );
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1"], acceptanceCriteria: [] });
    markStepComplete(cwd);
    getState(cwd).editsSinceLastReview = 2;

    const calls: string[] = [];
    const deps: LifecycleDeps = {
      executeWaiReview: async () => {
        calls.push("review");
        return {
          action: "review",
          review: { verdict: "pass", issues: [], suggestions: [], consensus: true },
        } as WaiToolResult;
      },
      executeWaiJudge: async () => {
        calls.push("judge");
        return {
          action: "judge",
          judge: { verdict: "pass", issues: [], suggestions: [], consensus: true, summary: "ok" },
        } as WaiToolResult;
      },
    };

    const { pi, emitAgentSettled } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd), deps);

    await emitAgentSettled({ type: "agent_settled" } as AgentSettledEvent, makeContext(cwd));
    // Flush the async handler chain (review then judge run in microtasks).
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, ["review", "judge"]);
    // The auto-review cleared the pending-edit counter.
    assert.strictEqual(getEditTracker(cwd).editsSinceLastReview, 0);
  });

  it("skips auto-review quietly on a cost-budget error and still runs auto-judge", async () => {
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ "pi-yoowai": { autoReviewOnSettle: true, autoJudge: true } }),
    );
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1"], acceptanceCriteria: [] });
    markStepComplete(cwd);
    getState(cwd).editsSinceLastReview = 2;

    const calls: string[] = [];
    const notifications: { message: string; level?: string }[] = [];
    const deps: LifecycleDeps = {
      executeWaiReview: async () => {
        calls.push("review");
        return { action: "review", error: "Review would exceed the configured cost budget ($0.50)." } as WaiToolResult;
      },
      executeWaiJudge: async () => {
        calls.push("judge");
        return {
          action: "judge",
          judge: { verdict: "pass", issues: [], suggestions: [], consensus: true, summary: "ok" },
        } as WaiToolResult;
      },
    };

    const { pi, emitAgentSettled } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd), deps);

    const ctx = makeContext(cwd);
    ctx.ui = {
      ...ctx.ui,
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
    } as unknown as ExtensionContext["ui"];

    await emitAgentSettled({ type: "agent_settled" } as AgentSettledEvent, ctx);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, ["review", "judge"]);
    // Nothing was reviewed, so the pending edits stay and no error surfaces.
    assert.strictEqual(getEditTracker(cwd).editsSinceLastReview, 2);
    assert.ok(!notifications.some((n) => n.level === "error"));
  });

  it("does not auto-review on agent_settled when autoReviewOnSettle is disabled", async () => {
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { autoReviewOnSettle: false } }));
    getState(cwd).editsSinceLastReview = 2;

    let reviewCalled = false;
    const deps: LifecycleDeps = {
      executeWaiReview: async () => {
        reviewCalled = true;
        return {
          action: "review",
          review: { verdict: "pass", issues: [], suggestions: [], consensus: true },
        } as WaiToolResult;
      },
    };

    const { pi, emitAgentSettled } = createFakePi();
    registerLifecycleHandlers(pi, makeLoopStates(cwd), deps);

    await emitAgentSettled({ type: "agent_settled" } as AgentSettledEvent, makeContext(cwd));
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(reviewCalled, false);
    assert.strictEqual(getEditTracker(cwd).editsSinceLastReview, 2);
  });

  it("appends a session audit entry when flushing with unreviewed edits outstanding", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1"], acceptanceCriteria: [] });
    const state = getState(cwd);
    state.editsSinceLastReview = 3;
    state.unreviewedTurns = 2;

    const { pi, entries, emitSessionBeforeSwitch } = createFakePi();
    setAuditExtensionAPI(pi);
    registerLifecycleHandlers(pi, makeLoopStates(cwd));

    emitSessionBeforeSwitch(
      { type: "session_before_switch", reason: "resume" } as SessionBeforeSwitchEvent,
      makeContext(cwd),
    );

    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].type, "wai");
    const data = entries[0].data as { type: string; issueCount?: number; message?: string };
    assert.strictEqual(data.type, "session-unreviewed");
    assert.strictEqual(data.issueCount, 3);
    assert.ok(data.message?.includes("session ended with 3 unreviewed edit(s)"));
    // The flush also folded the pending edits into the cumulative total.
    assert.strictEqual(getState(cwd).unreviewedEditsTotal, 3);
  });

  it("does not append an audit entry when flushing with no unreviewed edits", () => {
    const { pi, entries, emitSessionBeforeFork } = createFakePi();
    setAuditExtensionAPI(pi);
    registerLifecycleHandlers(pi, makeLoopStates(cwd));

    emitSessionBeforeFork(
      { type: "session_before_fork", entryId: "abc", position: "at" } as SessionBeforeForkEvent,
      makeContext(cwd),
    );

    assert.strictEqual(entries.length, 0);
  });
});
