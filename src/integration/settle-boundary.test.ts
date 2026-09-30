import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { ExtensionRunner, createExtensionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { registerLifecycleHandlers, type LifecycleDeps } from "./lifecycle.js";
import { setAuditExtensionAPI } from "./audit.js";
import { cancelSessionWork } from "./session-work.js";
import { dropSessionState, getState, setPlan } from "../session-state.js";
import type { WaiToolResult } from "../types.js";

function fixture(deps: LifecycleDeps) {
  const cwd = mkdtempSync(join(tmpdir(), "wai-settle-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ "pi-yoowai": { autoReviewOnSettle: true, autoJudge: true } }),
  );
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
  const steers: unknown[] = [];
  const entries: unknown[] = [];
  const notifications: string[] = [];
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) =>
      handlers.set(name, handler),
    sendUserMessage: (...args: unknown[]) => steers.push(args),
    appendEntry: (...args: unknown[]) => entries.push(args),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    ui: { notify: (text: string) => notifications.push(text), setStatus: () => {}, setWidget: () => {} },
    sessionManager: {},
  } as unknown as ExtensionContext;
  setAuditExtensionAPI(pi);
  registerLifecycleHandlers(pi, new Map(), { actionableBoundaries: true, ...deps });
  return {
    cwd,
    steers,
    entries,
    notifications,
    handlers,
    ctx,
    emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
    cleanup: () => {
      cancelSessionWork(cwd);
      dropSessionState(cwd);
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}
const result = (verdict: "pass" | "needs-work"): WaiToolResult => ({
  action: "review",
  review: {
    verdict,
    issues:
      verdict === "pass"
        ? []
        : [{ severity: "high", issue: "Fix the incorrect result", suggestion: "Correct the result" }],
    suggestions: [],
    consensus: verdict === "pass",
  },
});

it("dispatches wai drafts through the latest Pi ExtensionRunner boundary API", async (t) => {
  if (!("emitBoundary" in ExtensionRunner.prototype)) {
    t.skip("Actionable boundaries require Pi 0.87+");
    return;
  }
  const f = fixture({ executeWaiReview: async () => result("needs-work") });
  try {
    getState(f.cwd).editsSinceLastReview = 1;
    const handlers = new Map(
      [...f.handlers].map(([name, handler]) => [name, [(event: unknown) => handler(event, f.ctx)]]),
    );
    const extension = { path: "wai-probe", resolvedPath: "wai-probe", handlers } as unknown as ConstructorParameters<
      typeof ExtensionRunner
    >[0][number];
    const runner = new ExtensionRunner(
      [extension],
      createExtensionRuntime(),
      f.cwd,
      SessionManager.inMemory(f.cwd),
      {} as ConstructorParameters<typeof ExtensionRunner>[4],
    );
    const dispatch = runner as unknown as {
      emitBoundary: (
        event: unknown,
        buildContext: (entries: unknown[]) => unknown,
      ) => Promise<{ entries: unknown[]; continue: boolean; valid: boolean }>;
    };
    const response = await dispatch.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, (entries) => ({
      contextEntries: entries,
      contextMessages: [],
      llmMessages: [],
      pendingMessages: [],
      canContinue: true,
    }));
    assert.equal(response.valid, true);
    assert.equal(response.continue, true);
    assert.equal(response.entries.length, 1);
    assert.equal((response.entries[0] as { type: string }).type, "custom_message");
  } finally {
    f.cleanup();
  }
});

it("runs nested edits, reminders, reviews, corrections, and judge through Pi's in-memory dispatcher", async (t) => {
  if (!("emitBoundary" in ExtensionRunner.prototype)) {
    t.skip("Actionable boundaries require Pi 0.87+");
    return;
  }
  let reviews = 0;
  let judges = 0;
  const f = fixture({
    executeWaiReview: async () => result(++reviews === 1 ? "needs-work" : "pass"),
    executeWaiJudge: async () => {
      judges++;
      return {
        action: "judge",
        judge: { verdict: "pass", issues: [], suggestions: [], consensus: true, summary: "complete" },
      };
    },
  });
  try {
    setPlan(f.cwd, { summary: "finish", todo: ["one"], acceptanceCriteria: [] });
    getState(f.cwd).completedSteps = 1;
    const handlers = new Map(
      [...f.handlers].map(([name, handler]) => [name, [(event: unknown) => handler(event, f.ctx)]]),
    );
    const extension = { path: "wai-flow", resolvedPath: "wai-flow", handlers } as unknown as ConstructorParameters<
      typeof ExtensionRunner
    >[0][number];
    const runner = new ExtensionRunner(
      [extension],
      createExtensionRuntime(),
      f.cwd,
      SessionManager.inMemory(f.cwd),
      {} as ConstructorParameters<typeof ExtensionRunner>[4],
    );
    const nestedResult = (toolName: string, isError = false) =>
      ({
        type: "tool_result",
        toolName,
        toolCallId: `codemode/${toolName}`,
        parentToolCallId: "codemode",
        input: { path: "a.ts" },
        content: [],
        isError,
      }) as unknown as ToolResultEvent;
    await runner.emitToolResult(nestedResult("write"));
    await runner.emitToolResult(nestedResult("edit", true));
    assert.equal(getState(f.cwd).editsSinceLastReview, 1, "only successful nested mutations count");
    const dispatch = runner as unknown as {
      emitBoundary: (
        event: unknown,
        buildContext: (entries: unknown[]) => unknown,
      ) => Promise<{
        entries: Array<{ content?: string }>;
        continue: boolean;
        valid: boolean;
      }>;
    };
    const context = (entries: unknown[]) => ({
      contextEntries: entries,
      contextMessages: [],
      llmMessages: [],
      pendingMessages: [],
      canContinue: true,
    });
    const reminder = await dispatch.emitBoundary(
      {
        type: "turn_end",
        toolResults: [
          {
            toolName: "codemode",
            isError: true,
            nestedCalls: {
              calls: [
                { name: "write", status: "ok" },
                { name: "edit", status: "error" },
              ],
              complete: true,
            },
          },
        ],
      },
      context,
    );
    assert.equal(reminder.valid, true);
    assert.equal(reminder.continue, true);
    assert.match(reminder.entries[0].content ?? "", /WORKFLOW REMINDER/);
    const first = await dispatch.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, context);
    assert.equal(first.continue, true);
    assert.equal(reviews, 1);
    assert.equal(judges, 0, "unresolved review findings must block the final judge");
    await runner.emitToolResult(nestedResult("edit"));
    const second = await dispatch.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, context);
    assert.equal(second.valid, true);
    assert.equal(second.continue, false);
    assert.equal(second.entries.length, 2);
    assert.equal(reviews, 2);
    assert.equal(judges, 1);
    assert.equal(getState(f.cwd).editsSinceLastReview, 0);
  } finally {
    f.cleanup();
  }
});
const boundary = (canContinue = true) => ({
  entries: [{ type: "custom", customType: "other", data: 1 }],
  context: { canContinue },
  outcome: "completed",
});

it("delivers workflow reminders as boundary drafts without starting a new user turn", async () => {
  const f = fixture({});
  try {
    getState(f.cwd).editsSinceLastReview = 1;
    const original = { type: "custom", customType: "other", data: 1 };
    const response = (await f.emit("turn_end", {
      toolResults: [{ toolName: "write", isError: false }],
      entries: [original],
      context: { canContinue: true },
    })) as { entries: Array<{ content?: string }>; continue?: boolean };
    assert.equal(response.continue, true);
    assert.deepEqual(response.entries[0], original);
    assert.match(response.entries[1].content ?? "", /WORKFLOW REMINDER/);
    assert.equal(f.steers.length, 0);
  } finally {
    f.cleanup();
  }
});

it("keeps the steer when Pi has no runnable turn_end context", async () => {
  const f = fixture({});
  try {
    getState(f.cwd).editsSinceLastReview = 1;
    const response = await f.emit("turn_end", {
      toolResults: [{ toolName: "write", isError: false }],
      entries: [],
      context: { canContinue: false },
    });
    assert.equal(response, undefined);
    assert.equal(f.steers.length, 1);
  } finally {
    f.cleanup();
  }
});

it("requests one continuation for findings, preserves other drafts, and never repeats the same workspace", async () => {
  let calls = 0;
  const f = fixture({
    executeWaiReview: async () => {
      calls++;
      return result("needs-work");
    },
  });
  try {
    getState(f.cwd).editsSinceLastReview = 1;
    const response = (await f.emit("agent_before_settle", boundary())) as { entries: unknown[]; continue?: boolean };
    assert.equal(response.continue, true);
    assert.equal(response.entries.length, 2);
    assert.deepEqual(response.entries[0], boundary().entries[0]);
    await f.emit("agent_settled");
    await f.emit("agent_before_settle", boundary());
    assert.equal(calls, 1);
    assert.equal(f.steers.length, 0);
    await f.emit("input", { source: "extension" });
    await f.emit("agent_before_settle", boundary());
    assert.equal(calls, 1, "extension-generated messages must not reset the retry guard");
    await f.emit("input", { source: "interactive" });
    await f.emit("agent_before_settle", boundary());
    assert.equal(calls, 2, "a new user prompt can retry the same workspace");
  } finally {
    f.cleanup();
  }
});

it("records a clean pass without forcing another turn and respects a disabled continuation", async () => {
  for (const [verdict, canContinue] of [
    ["pass", true],
    ["needs-work", false],
  ] as const) {
    const f = fixture({ executeWaiReview: async () => result(verdict) });
    try {
      getState(f.cwd).editsSinceLastReview = 1;
      const response = (await f.emit("agent_before_settle", boundary(canContinue))) as {
        entries: unknown[];
        continue?: boolean;
      };
      assert.equal(response.continue, undefined);
      assert.equal(response.entries.length, 2);
    } finally {
      f.cleanup();
    }
  }
});

it("preserves a failing judge embedded in a passing final-step review", async () => {
  const f = fixture({
    executeWaiReview: async () => ({
      ...result("pass"),
      judge: {
        verdict: "needs-work",
        issues: [{ severity: "high", issue: "Missing acceptance criterion", suggestion: "Implement it" }],
        suggestions: [],
        consensus: false,
        summary: "Incomplete work",
      },
    }),
  });
  try {
    getState(f.cwd).editsSinceLastReview = 1;
    const response = (await f.emit("agent_before_settle", boundary())) as {
      entries: { content?: string }[];
      continue?: boolean;
    };
    assert.equal(response.continue, true);
    assert.match(response.entries[1].content ?? "", /Missing acceptance criterion/);
  } finally {
    f.cleanup();
  }
});

it("cancels an automatic review on switching and rejects its late result before starting judge", async () => {
  let resolveReview!: (value: WaiToolResult) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let capturedSignal: AbortSignal | undefined;
  let judges = 0;
  const f = fixture({
    executeWaiReview: async (_cwd, _description, _ctx, signal) => {
      capturedSignal = signal;
      entered();
      return new Promise<WaiToolResult>((resolve) => {
        resolveReview = resolve;
      });
    },
    executeWaiJudge: async () => {
      judges++;
      return { action: "judge" };
    },
  });
  try {
    setPlan(f.cwd, { summary: "outgoing", todo: ["one"], acceptanceCriteria: [] });
    getState(f.cwd).editsSinceLastReview = 1;
    getState(f.cwd).completedSteps = 1;
    const pending = f.emit("agent_before_settle", boundary());
    await started;
    await f.emit("session_before_switch");
    assert.equal(capturedSignal?.aborted, true);
    setPlan(f.cwd, { summary: "incoming", todo: ["different"], acceptanceCriteria: [] });
    const count = f.entries.length;
    resolveReview(result("pass"));
    assert.equal(await pending, undefined);
    assert.equal(getState(f.cwd).plan?.summary, "incoming");
    assert.equal(getState(f.cwd).editsSinceLastReview, 1);
    assert.equal(f.entries.length, count);
    assert.equal(f.notifications.length, 0);
    assert.equal(judges, 0);
  } finally {
    f.cleanup();
  }
});

it("cancels an automatic judge on fork and prevents a late verdict from completing the replacement plan", async () => {
  let finish!: (value: WaiToolResult) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let signal: AbortSignal | undefined;
  const f = fixture({
    executeWaiJudge: async (_cwd, _description, activeSignal) => {
      signal = activeSignal;
      entered();
      return new Promise<WaiToolResult>((resolve) => {
        finish = resolve;
      });
    },
  });
  try {
    setPlan(f.cwd, { summary: "outgoing", todo: ["one"], acceptanceCriteria: [] });
    getState(f.cwd).completedSteps = 1;
    const pending = f.emit("agent_before_settle", boundary());
    await started;
    await f.emit("session_before_fork");
    assert.equal(signal?.aborted, true);
    setPlan(f.cwd, { summary: "replacement", todo: ["two"], acceptanceCriteria: [] });
    finish({
      action: "judge",
      judge: { verdict: "pass", issues: [], suggestions: [], consensus: true, summary: "pass" },
    });
    assert.equal(await pending, undefined);
    assert.equal(getState(f.cwd).judgeCompleted, false);
    assert.equal(f.notifications.length, 0);
  } finally {
    f.cleanup();
  }
});
