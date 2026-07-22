import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerWaiShortcuts } from "./shortcuts.js";

type ShortcutRegistration = {
  shortcut: string;
  description?: string;
  handler: (ctx: ExtensionContext) => void;
};

function createFakePi(): {
  pi: ExtensionAPI;
  shortcuts: ShortcutRegistration[];
  userMessages: { content: string; options?: Record<string, unknown> }[];
  notifications: string[];
} {
  const shortcuts: ShortcutRegistration[] = [];
  const userMessages: { content: string; options?: Record<string, unknown> }[] = [];
  const notifications: string[] = [];

  const pi = {
    registerShortcut: (
      shortcut: string,
      options: { description?: string; handler: (ctx: ExtensionContext) => void },
    ) => {
      shortcuts.push({ shortcut, description: options.description, handler: options.handler });
    },
    sendUserMessage: (content: string, options?: Record<string, unknown>) => {
      userMessages.push({ content, options });
    },
  } as unknown as ExtensionAPI;

  return { pi, shortcuts, userMessages, notifications };
}

function makeContext(cwd: string, notifications: string[]): ExtensionContext {
  return {
    cwd,
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
      setWidget: () => {},
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

describe("registerWaiShortcuts", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(tmpdir(), `wai-shortcuts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("registers ctrl+shift+r, ctrl+shift+d, and ctrl+shift+s", () => {
    const { pi, shortcuts } = createFakePi();
    registerWaiShortcuts(pi);

    const names = shortcuts.map((s) => s.shortcut).sort();
    assert.deepStrictEqual(names, ["ctrl+shift+d", "ctrl+shift+r", "ctrl+shift+s"]);
  });

  it("ctrl+shift+r sends a review request", () => {
    const { pi, shortcuts, userMessages, notifications } = createFakePi();
    registerWaiShortcuts(pi);

    const reviewShortcut = shortcuts.find((s) => s.shortcut === "ctrl+shift+r");
    assert.ok(reviewShortcut);
    reviewShortcut!.handler(makeContext(cwd, notifications));

    assert.ok(userMessages.some((m) => m.content.includes("wai.review")));
    assert.ok(userMessages.some((m) => m.options?.deliverAs === "steer"));
    assert.ok(notifications.some((n) => n.includes("review")));
  });

  it("ctrl+shift+d sends a done request", () => {
    const { pi, shortcuts, userMessages, notifications } = createFakePi();
    registerWaiShortcuts(pi);

    const doneShortcut = shortcuts.find((s) => s.shortcut === "ctrl+shift+d");
    assert.ok(doneShortcut);
    doneShortcut!.handler(makeContext(cwd, notifications));

    assert.ok(userMessages.some((m) => m.content.includes("wai.done")));
    assert.ok(userMessages.some((m) => m.options?.deliverAs === "steer"));
  });

  it("ctrl+shift+s sends a status request", () => {
    const { pi, shortcuts, userMessages, notifications } = createFakePi();
    registerWaiShortcuts(pi);

    const statusShortcut = shortcuts.find((s) => s.shortcut === "ctrl+shift+s");
    assert.ok(statusShortcut);
    statusShortcut!.handler(makeContext(cwd, notifications));

    assert.ok(userMessages.some((m) => m.content.includes("wai status")));
    assert.ok(userMessages.some((m) => m.options?.deliverAs === "steer"));
  });

  it("respects shortcuts: false config", () => {
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": { shortcuts: false } }));

    const { pi, shortcuts, userMessages, notifications } = createFakePi();
    registerWaiShortcuts(pi);

    const reviewShortcut = shortcuts.find((s) => s.shortcut === "ctrl+shift+r");
    assert.ok(reviewShortcut);
    reviewShortcut!.handler(makeContext(cwd, notifications));

    assert.strictEqual(userMessages.length, 0);
    assert.strictEqual(notifications.length, 0);
  });
});
