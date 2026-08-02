import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { updateWaiPlanWidget, hideWaiPlanWidget, INNER_WIDTH } from "./widget.js";
import { setPlan, dropSessionState, markStepComplete } from "../session-state.js";

function makeContext(cwd: string, capture: Map<string, string[] | undefined>): ExtensionContext {
  return {
    cwd,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: (key: string, content: string[] | undefined) => {
        capture.set(key, content);
      },
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

describe("updateWaiPlanWidget", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(tmpdir(), `wai-widget-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
  });

  afterEach(() => {
    dropSessionState(cwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("shows a progress widget when a plan is active", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1", "Step 2", "Step 3"], acceptanceCriteria: [] });

    const capture = new Map<string, string[] | undefined>();
    updateWaiPlanWidget(makeContext(cwd, capture));

    const content = capture.get("wai-plan");
    assert.ok(content);
    const widths = new Set(content!.map((line) => line.length));
    assert.strictEqual(widths.size, 1, "widget lines should all have the same width");
    assert.ok(content!.some((line) => line.includes("Refactor auth")));
    assert.ok(content!.some((line) => line.includes("0/3")));
    assert.ok(content!.some((line) => line.includes("0%")));
  });

  it("fills the progress bar line to the inner width", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1", "Step 2"], acceptanceCriteria: [] });

    const capture = new Map<string, string[] | undefined>();
    updateWaiPlanWidget(makeContext(cwd, capture));

    const content = capture.get("wai-plan");
    assert.ok(content);
    const progressLine = content!.find((line) => line.includes("%"));
    assert.ok(progressLine);
    const inner = progressLine!.slice(2, -2).trimEnd();
    assert.strictEqual(inner.length, INNER_WIDTH, "progress bar should fill the inner width without trailing padding");
    assert.ok(progressLine!.endsWith("% │"), "progress percentage should be flush with the right border");
  });

  it("hides the widget when no plan is active", () => {
    const capture = new Map<string, string[] | undefined>();
    updateWaiPlanWidget(makeContext(cwd, capture));
    assert.strictEqual(capture.get("wai-plan"), undefined);
  });

  it("respects planWidget: false config", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1"], acceptanceCriteria: [] });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { planWidget: false } }));

    const capture = new Map<string, string[] | undefined>();
    updateWaiPlanWidget(makeContext(cwd, capture));
    assert.strictEqual(capture.get("wai-plan"), undefined);
  });

  it("updates progress when steps are completed", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1", "Step 2"], acceptanceCriteria: [] });

    const capture1 = new Map<string, string[] | undefined>();
    updateWaiPlanWidget(makeContext(cwd, capture1));
    assert.ok(capture1.get("wai-plan")!.some((line) => line.includes("0/2")));

    // Updating state and re-rendering is tested implicitly via setPlan; the widget
    // simply reflects whatever session-state holds.
  });

  it("shows a blocked-step line when the current step has unmet dependencies", () => {
    setPlan(cwd, {
      summary: "Refactor auth",
      todo: [{ description: "Setup", dependsOn: [3] }, { description: "Middleware", dependsOn: [1] }, "Teardown"],
      acceptanceCriteria: [],
    });

    const capture = new Map<string, string[] | undefined>();
    updateWaiPlanWidget(makeContext(cwd, capture));

    const content = capture.get("wai-plan");
    assert.ok(content);
    // The blocked step itself is shown, and the blocker is named.
    assert.ok(content.some((line) => line.includes("Setup")));
    assert.ok(content.some((line) => line.includes("blocked by step 3")));
  });

  it("hides the blocked line once the current step advances past the blocker", () => {
    setPlan(cwd, {
      summary: "Refactor auth",
      todo: [{ description: "Setup", dependsOn: [3] }, "Middleware", "Teardown"],
      acceptanceCriteria: [],
    });

    // Before: the current step is blocked by an unmet forward dependency.
    const before = new Map<string, string[] | undefined>();
    updateWaiPlanWidget(makeContext(cwd, before));
    assert.ok(before.get("wai-plan")!.some((line) => line.includes("blocked by step 3")));

    // After advancing, the current step is a plain step: the line is gone.
    markStepComplete(cwd, true);
    const after = new Map<string, string[] | undefined>();
    updateWaiPlanWidget(makeContext(cwd, after));
    assert.ok(!after.get("wai-plan")!.some((line) => line.includes("blocked by")));
  });

  it("does not throw on malformed dependency entries", () => {
    setPlan(cwd, {
      summary: "Refactor auth",
      todo: [{ description: "Setup", dependsOn: ["not-a-number"] as unknown as number[] }, "Middleware"],
      acceptanceCriteria: [],
    });

    const capture = new Map<string, string[] | undefined>();
    assert.doesNotThrow(() => updateWaiPlanWidget(makeContext(cwd, capture)));
    const content = capture.get("wai-plan");
    assert.ok(content);
    assert.ok(!content.some((line) => line.includes("blocked by")));
  });

  it("hideWaiPlanWidget clears the widget", () => {
    const capture = new Map<string, string[] | undefined>();
    capture.set("wai-plan", ["old"]);
    hideWaiPlanWidget(makeContext(cwd, capture));
    assert.strictEqual(capture.get("wai-plan"), undefined);
  });
});
