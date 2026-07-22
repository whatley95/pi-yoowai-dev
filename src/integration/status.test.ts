import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { updateWaiStatus, clearWaiStatusLines } from "./status.js";
import { setPlan, dropSessionState, recordFileEdit } from "../session-state.js";
import { resetCost, recordCost } from "../cost-tracker.js";

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

describe("updateWaiStatus", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(tmpdir(), `wai-status-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
    resetCost(cwd);
  });

  afterEach(() => {
    dropSessionState(cwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("sets plan status when a plan is active", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1", "Step 2"], acceptanceCriteria: [] });

    const statuses = new Map<string, string | undefined>();
    const ctx = {
      ...makeContext(cwd),
      ui: {
        ...makeContext(cwd).ui,
        setStatus: (key: string, text: string | undefined) => {
          statuses.set(key, text);
        },
      } as unknown as ExtensionContext["ui"],
    };

    updateWaiStatus(ctx);

    assert.ok(statuses.get("wai-plan")?.includes("0/2"));
    assert.ok(statuses.get("wai-plan")?.includes("Step 1"));
  });

  it("clears plan status when no plan is active", () => {
    const statuses = new Map<string, string | undefined>();
    const ctx = {
      ...makeContext(cwd),
      ui: {
        ...makeContext(cwd).ui,
        setStatus: (key: string, text: string | undefined) => {
          statuses.set(key, text);
        },
      } as unknown as ExtensionContext["ui"],
    };

    updateWaiStatus(ctx);

    assert.strictEqual(statuses.get("wai-plan"), undefined);
  });

  it("shows cost and review-pending edits when present", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1"], acceptanceCriteria: [] });
    recordCost(cwd, {
      estimatedInputTokens: 1000,
      estimatedOutputTokens: 500,
      estimatedCostUsd: 0.0123,
      sessionCostUsd: 0,
    });
    recordFileEdit(cwd);
    recordFileEdit(cwd);
    recordFileEdit(cwd);

    const statuses = new Map<string, string | undefined>();
    const ctx = {
      ...makeContext(cwd),
      ui: {
        ...makeContext(cwd).ui,
        setStatus: (key: string, text: string | undefined) => {
          statuses.set(key, text);
        },
      } as unknown as ExtensionContext["ui"],
    };

    updateWaiStatus(ctx);

    assert.ok(statuses.get("wai-cost")?.includes("$0.0123"));
    assert.ok(statuses.get("wai-cost")?.includes("review pending"));
    assert.ok(statuses.get("wai-cost")?.includes("3 edits"));
  });

  it("does not show review-pending below the configured threshold", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1"], acceptanceCriteria: [] });
    recordFileEdit(cwd);

    const statuses = new Map<string, string | undefined>();
    const ctx = {
      ...makeContext(cwd),
      ui: {
        ...makeContext(cwd).ui,
        setStatus: (key: string, text: string | undefined) => {
          statuses.set(key, text);
        },
      } as unknown as ExtensionContext["ui"],
    };

    updateWaiStatus(ctx);

    assert.strictEqual(statuses.get("wai-cost"), undefined);
  });

  it("clears status lines", () => {
    const cleared: string[] = [];
    const ctx = {
      ...makeContext(cwd),
      ui: {
        ...makeContext(cwd).ui,
        setStatus: (key: string, text: string | undefined) => {
          if (text === undefined) cleared.push(key);
        },
      } as unknown as ExtensionContext["ui"],
    };

    clearWaiStatusLines(ctx);

    assert.ok(cleared.includes("wai-plan"));
    assert.ok(cleared.includes("wai-cost"));
  });
});
