import { describe, it } from "node:test";
import assert from "node:assert";
import type { ExtensionAPI, CustomEntry, EntryRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { registerWaiEntryRenderer, type TextConstructor } from "./entry-renderer.js";
import type { WaiAuditEntry } from "./audit.js";

type RendererFn = (entry: CustomEntry<WaiAuditEntry>, options: EntryRenderOptions, theme: Theme) => unknown;

function createFakeText(): { ctor: TextConstructor; instances: unknown[] } {
  const instances: unknown[] = [];
  class FakeText {
    text: string;
    constructor(text?: string) {
      this.text = text ?? "";
      instances.push(this);
    }
    setText(text: string): void {
      this.text = text;
    }
    render(): string[] {
      return this.text.split("\n");
    }
  }
  return { ctor: FakeText as unknown as TextConstructor, instances };
}

function createFakePi(): {
  pi: ExtensionAPI;
  getRenderer: () => RendererFn | undefined;
} {
  let renderer: RendererFn | undefined;
  const pi = {
    registerEntryRenderer: (_customType: string, r: RendererFn) => {
      renderer = r;
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    getRenderer: () => renderer,
  };
}

function callRenderer(renderer: RendererFn, data: WaiAuditEntry): unknown {
  return renderer(
    { type: "custom", customType: "wai", data } as CustomEntry<WaiAuditEntry>,
    { expanded: false },
    {} as Theme,
  );
}

function getRenderedLines(component: unknown, width = 80): string[] {
  assert.ok(component && typeof component === "object");
  assert.ok(typeof (component as { render?: unknown }).render === "function");
  return (component as { render: (width: number) => string[] }).render(width);
}

describe("registerWaiEntryRenderer", () => {
  it("registers a renderer for the wai custom type", async () => {
    const { ctor } = createFakeText();
    const { pi, getRenderer } = createFakePi();
    await registerWaiEntryRenderer(pi, ctor);
    assert.ok(getRenderer());
  });

  it("returns undefined when data is missing", async () => {
    const { ctor } = createFakeText();
    const { pi, getRenderer } = createFakePi();
    await registerWaiEntryRenderer(pi, ctor);
    const renderer = getRenderer();
    if (!renderer) throw new Error("renderer not registered");
    const result = renderer(
      { type: "custom", customType: "wai" } as CustomEntry<WaiAuditEntry>,
      { expanded: false },
      {} as Theme,
    );
    assert.strictEqual(result, undefined);
  });

  it("formats a plan-created entry as a Text component", async () => {
    const { ctor } = createFakeText();
    const { pi, getRenderer } = createFakePi();
    await registerWaiEntryRenderer(pi, ctor);
    const renderer = getRenderer();
    if (!renderer) throw new Error("renderer not registered");
    const result = callRenderer(renderer, {
      type: "plan-created",
      timestamp: new Date().toISOString(),
      cwd: "/tmp",
      summary: "Refactor auth",
      total: 3,
    });

    assert.ok(!Array.isArray(result));
    const lines = getRenderedLines(result);
    assert.ok(lines.some((line) => line.includes("Plan created")));
    assert.ok(lines.some((line) => line.includes("Refactor auth")));
    assert.ok(lines.some((line) => line.includes("(0/3)")));
  });

  it("formats a review-needs-work entry with issue count", async () => {
    const { ctor } = createFakeText();
    const { pi, getRenderer } = createFakePi();
    await registerWaiEntryRenderer(pi, ctor);
    const renderer = getRenderer();
    if (!renderer) throw new Error("renderer not registered");
    const result = callRenderer(renderer, {
      type: "review-needs-work",
      timestamp: new Date().toISOString(),
      cwd: "/tmp",
      issueCount: 5,
    });

    const lines = getRenderedLines(result);
    assert.ok(lines.some((line) => line.includes("Review needs work")));
    assert.ok(lines.some((line) => line.includes("issues: 5")));
  });

  it("returns undefined when entryRenderer config is false", async () => {
    const { ctor } = createFakeText();
    const { pi, getRenderer } = createFakePi();
    await registerWaiEntryRenderer(pi, ctor);
    const renderer = getRenderer();
    if (!renderer) throw new Error("renderer not registered");

    // Simulate a project with entryRenderer disabled.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const cwd = path.join(os.tmpdir(), `wai-entry-renderer-${Date.now()}`);
    fs.mkdirSync(path.join(cwd, ".pi", "yoowai"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { entryRenderer: false } }));

    const result = callRenderer(renderer, {
      type: "plan-created",
      timestamp: new Date().toISOString(),
      cwd,
      summary: "Refactor auth",
      total: 3,
    });
    assert.strictEqual(result, undefined);

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("is a no-op when pi-tui is unavailable and no textClass is provided", async () => {
    const { pi, getRenderer } = createFakePi();
    await registerWaiEntryRenderer(pi);
    assert.strictEqual(getRenderer(), undefined);
  });
});
