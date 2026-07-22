import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { publishWaiResult } from "./publish.js";
import { setAuditExtensionAPI } from "./audit.js";
import { setPlan, dropSessionState } from "../session-state.js";
import { resetCost } from "../cost-tracker.js";
import type { WaiToolResult } from "../types.js";

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

function makeFakePi(): {
  pi: ExtensionAPI;
  entries: { customType: string; data: unknown }[];
} {
  const entries: { customType: string; data: unknown }[] = [];
  const pi = {
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, entries };
}

describe("publishWaiResult", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(tmpdir(), `wai-publish-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
    resetCost(cwd);
  });

  afterEach(() => {
    dropSessionState(cwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("audits a created plan and updates status", () => {
    const { pi, entries } = makeFakePi();
    setAuditExtensionAPI(pi);

    publishWaiResult(makeContext(cwd), {
      action: "plan",
      plan: { summary: "Refactor auth", todo: ["Step 1"], acceptanceCriteria: [] },
    });

    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].customType, "wai");
    assert.strictEqual((entries[0].data as { type: string }).type, "plan-created");
  });

  it("audits a review pass", () => {
    const { pi, entries } = makeFakePi();
    setAuditExtensionAPI(pi);

    publishWaiResult(makeContext(cwd), {
      action: "review",
      review: { verdict: "pass", issues: [], suggestions: [], consensus: true },
    } as WaiToolResult);

    assert.strictEqual(entries.length, 1);
    assert.strictEqual((entries[0].data as { type: string }).type, "review-pass");
  });

  it("audits a review needs-work with issue count", () => {
    const { pi, entries } = makeFakePi();
    setAuditExtensionAPI(pi);

    publishWaiResult(makeContext(cwd), {
      action: "review",
      review: {
        verdict: "needs-work",
        issues: [{ severity: "high", issue: "bug", suggestion: "fix" }],
        suggestions: [],
        consensus: false,
      },
    } as WaiToolResult);

    assert.strictEqual(entries.length, 1);
    const data = entries[0].data as { type: string; issueCount: number };
    assert.strictEqual(data.type, "review-needs-work");
    assert.strictEqual(data.issueCount, 1);
  });

  it("audits a done result with step details", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1"], acceptanceCriteria: [] });
    const { pi, entries } = makeFakePi();
    setAuditExtensionAPI(pi);

    publishWaiResult(makeContext(cwd), {
      action: "done",
      done: { completedStep: 1, totalSteps: 1, allDone: true, message: "ok", verified: true },
    });

    assert.strictEqual(entries.length, 1);
    const data = entries[0].data as { type: string; completed: number; total: number; message?: string };
    assert.strictEqual(data.type, "step-done");
    assert.strictEqual(data.completed, 1);
    assert.strictEqual(data.total, 1);
    assert.strictEqual(data.message, "verified");
  });

  it("audits a plan update with completed progress", () => {
    const { pi, entries } = makeFakePi();
    setAuditExtensionAPI(pi);

    publishWaiResult(makeContext(cwd), {
      action: "planUpdate",
      done: { completedStep: 2, totalSteps: 5, allDone: false, message: "Plan updated: 2/5 steps already completed." },
    });

    assert.strictEqual(entries.length, 1);
    const data = entries[0].data as { type: string; completed: number; total: number };
    assert.strictEqual(data.type, "plan-updated");
    assert.strictEqual(data.completed, 2);
    assert.strictEqual(data.total, 5);
  });

  it("does not audit errors", () => {
    const { pi, entries } = makeFakePi();
    setAuditExtensionAPI(pi);

    publishWaiResult(makeContext(cwd), {
      action: "plan",
      error: "model unavailable",
    });

    assert.strictEqual(entries.length, 0);
  });
});
