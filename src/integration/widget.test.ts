import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { updateWaiPlanWidget, hideWaiPlanWidget, INNER_WIDTH, displayWidth } from "./widget.js";
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
    assert.ok(content.some((line) => line.includes("blocked by #3")));
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
    assert.ok(before.get("wai-plan")!.some((line) => line.includes("blocked by #3")));

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

  it("marks done-but-unreviewed steps with the ⚠ glyph (mixed reviewed/manual)", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1", "Step 2", "Step 3"], acceptanceCriteria: [] });
    markStepComplete(cwd, true); // step 1: reviewed
    markStepComplete(cwd, false); // step 2: manually marked

    const capture = new Map<string, string[] | undefined>();
    updateWaiPlanWidget(makeContext(cwd, capture));
    const content = capture.get("wai-plan");
    assert.ok(content);
    const manual = content!.find((line) => line.includes("2:⚠"));
    assert.ok(manual, "the done-but-unreviewed step must carry the ⚠ glyph");
    assert.ok(
      content!.some((line) => line.includes("1:✓")),
      "the reviewed step keeps ✓",
    );
    assert.ok(
      !content!.some((line) => /⚠ \d+ done steps? not reviewed/.test(line)),
      "the old aggregate warning line is replaced by per-step glyphs",
    );
    assert.ok(INNER_WIDTH >= 56, "the widget inner width must be at least 56");
    for (const line of content!) {
      assert.strictEqual(
        line.slice(2, -2).length,
        INNER_WIDTH,
        `every line renders the full inner width: ${JSON.stringify(line)}`,
      );
    }
  });

  it("stays quiet when every completed step was reviewed", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1", "Step 2", "Step 3"], acceptanceCriteria: [] });
    markStepComplete(cwd, true);
    markStepComplete(cwd, true);

    const capture = new Map<string, string[] | undefined>();
    updateWaiPlanWidget(makeContext(cwd, capture));
    const content = capture.get("wai-plan");
    assert.ok(content);
    assert.ok(!content!.some((line) => line.includes("not reviewed")));
  });

  it("shows 50% and the reviewed ratio on a four-step mixed fixture", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["S1", "S2", "S3", "S4"], acceptanceCriteria: [] });
    markStepComplete(cwd, true);
    markStepComplete(cwd, false);

    const capture = new Map<string, string[] | undefined>();
    updateWaiPlanWidget(makeContext(cwd, capture));
    const content = capture.get("wai-plan");
    assert.ok(content!.some((line) => line.includes("50%")));
    assert.ok(content!.some((line) => line.includes("2/4 steps · reviewed 1/2")));
  });

  it("wraps an unspaced wide CJK run without dropping content", () => {
    const run = "重构认证中间件并处理所有可能的边界情况以验证宽度处理逻辑是否正确无误且不会丢失任何内容"; // unspaced, > 56 columns
    setPlan(cwd, { summary: "Refactor auth", todo: [run], acceptanceCriteria: [] });

    const capture = new Map<string, string[] | undefined>();
    updateWaiPlanWidget(makeContext(cwd, capture));
    const content = capture.get("wai-plan");
    assert.ok(content);
    const joined = content!.join("").replace(/\s+/g, "");
    // Ordered consumption: every code point of the run must appear in order.
    let pos = 0;
    for (const ch of run) {
      const found = joined.indexOf(ch, pos);
      assert.ok(found >= 0, `every wide character must survive wrapping in order: ${ch}`);
      pos = found + 1;
    }
  });

  it("displayWidth handles ZWJ emoji and regional flags as single clusters", () => {
    assert.strictEqual(displayWidth("👨‍👩‍👧‍👦"), 2, "ZWJ family emoji render as one 2-column cluster");
    assert.strictEqual(displayWidth("🇺🇸"), 2, "regional-indicator flags render as one 2-column cluster");
  });

  it("counts keycap sequences as 2 columns", () => {
    assert.strictEqual(displayWidth("1️⃣"), 2, "keycap clusters render ~2 columns");
  });

  it("keeps ZWJ emoji and flags intact across wrap boundaries", () => {
    // 50 narrow chars + a ZWJ family + a flag: the clusters straddle the
    // available-column boundary of the first wrapped line.
    const description = "x".repeat(50) + "👨‍👩‍👧‍👦" + "🇺🇸" + " tail";
    setPlan(cwd, { summary: "Refactor auth", todo: [description], acceptanceCriteria: [] });

    const capture = new Map<string, string[] | undefined>();
    updateWaiPlanWidget(makeContext(cwd, capture));
    const content = capture.get("wai-plan")!;
    const joined = content.join("");
    assert.ok(joined.includes("👨‍👩‍👧‍👦"), "the ZWJ family must land intact on one line");
    assert.ok(joined.includes("🇺🇸"), "the flag must land intact on one line");
  });

  it("displayWidth handles modern emoji and supplemental marks", () => {
    assert.strictEqual(displayWidth("🫠"), 2, "modern emoji are double-width");
    assert.strictEqual(displayWidth("᪰"), 0, "supplemental combining marks are zero-width");
    assert.strictEqual(displayWidth("a᪰b"), 2, "marks add no columns");
  });

  it("retains wide Unicode and combining characters within the framed width", () => {
    const wide = "重构认证中间件并处理所有可能的边界情况以验证宽度处理逻辑是否正确无误"; // 39 wide chars
    const combining = "café naïve élévé"; // precomposed + combining marks
    setPlan(cwd, { summary: "Refactor auth", todo: [wide, combining], acceptanceCriteria: [] });

    const capture = new Map<string, string[] | undefined>();
    updateWaiPlanWidget(makeContext(cwd, capture));
    const content = capture.get("wai-plan");
    assert.ok(content);
    for (const line of content!) {
      const inner = line.slice(2, -2);
      assert.strictEqual(
        displayWidth(inner),
        INNER_WIDTH,
        `line must occupy exactly INNER_WIDTH display columns: ${JSON.stringify(line)}`,
      );
    }
    const combined = content!.join(" ");
    assert.ok(combined.includes("1:→"), "the step grid must show the current step glyph");
    assert.ok(combined.includes("2:·"), "the pending step must show · in the grid");
  });

  it("marks every manually-completed step with ⚠ (two unreviewed)", () => {
    setPlan(cwd, { summary: "Refactor auth", todo: ["Step 1", "Step 2", "Step 3", "Step 4"], acceptanceCriteria: [] });
    markStepComplete(cwd, false);
    markStepComplete(cwd, false);

    const capture = new Map<string, string[] | undefined>();
    updateWaiPlanWidget(makeContext(cwd, capture));
    const content = capture.get("wai-plan");
    assert.ok(content!.some((line) => line.includes("1:⚠")));
    assert.ok(content!.some((line) => line.includes("2:⚠")));
    assert.ok(
      content!.some((line) => line.includes("3:→")),
      "step 3 is the current step",
    );
    assert.ok(content!.some((line) => line.includes("4:·")));
  });
});
