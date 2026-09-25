import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { setSdkGetModelOverride, setSdkStreamSimpleOverride } from "./backends/sdk-backend.js";
import initWai from "./index.js";
import { cleanupProgressReporter, createProgressReporter } from "./progress.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeProjectSettings(cwd: string): void {
  const piDir = join(cwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "settings.json"),
    JSON.stringify({ "pi-yoowai": { secondary: { provider: "openai", id: "gpt-4o", apiKey: "sk-test" } } }),
    "utf-8",
  );
}

function fakeVisionModel(): Model<Api> {
  return {
    id: "gpt-4o",
    name: "gpt-4o",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  } as Model<Api>;
}

function successfulStream(text: string): import("@earendil-works/pi-ai").AssistantMessageEventStream {
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
  return {
    result: async () => message,
    [Symbol.asyncIterator]: async function* () {
      yield { type: "done", reason: "stop", message };
    },
  } as unknown as import("@earendil-works/pi-ai").AssistantMessageEventStream;
}

function rejectedStream(): import("@earendil-works/pi-ai").AssistantMessageEventStream {
  return {
    result: async () => {
      throw new Error("stream rejected");
    },
    [Symbol.asyncIterator]: async function* () {
      yield { type: "text_delta", delta: "partial" };
    },
  } as unknown as import("@earendil-works/pi-ai").AssistantMessageEventStream;
}

function createMockPi(): { pi: ExtensionAPI; toolDefs: Array<{ name: string } & Record<string, unknown>> } {
  const toolDefs: Array<{ name: string } & Record<string, unknown>> = [];
  const pi = {
    on: () => {},
    registerTool: (tool: { name: string } & Record<string, unknown>) => toolDefs.push(tool),
    registerCommand: () => {},
    registerShortcut: () => {},
    registerEntryRenderer: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      select: async () => undefined,
      notify: () => {},
      input: async () => undefined,
    },
  } as unknown as ExtensionAPI;
  return { pi, toolDefs };
}

describe("wai_vision progress cleanup", () => {
  it("stops the Loading input ticker when image loading fails before the model call", async () => {
    const cwd = makeTempDir("wai-vision-progress-error-");
    writeProjectSettings(cwd);
    const { pi, toolDefs } = createMockPi();
    const statuses: Array<string | undefined> = [];
    let modelCalls = 0;
    let unrelated: ReturnType<typeof createProgressReporter> | undefined;

    try {
      mock.timers.enable({ apis: ["setInterval"] });
      setSdkStreamSimpleOverride((() => {
        modelCalls++;
        throw new Error("the model must not run for a missing image");
      }) as never);
      await initWai(pi);
      const def = toolDefs.find((tool) => tool.name === "wai_vision");
      assert.ok(def, "wai_vision must be registered");
      const execute = (def as { execute?: (...args: unknown[]) => Promise<unknown> }).execute;
      assert.ok(execute, "wai_vision must have an executor");
      const ctx = {
        cwd,
        ui: {
          setStatus: (_id: string, text: string | undefined) => statuses.push(text),
        },
      } as unknown as ExtensionContext;
      unrelated = createProgressReporter("review", ctx);
      unrelated(1, 3, "Unrelated action…");
      statuses.length = 0;

      const result = (await execute("t", { path: "missing.png" }, undefined, undefined, ctx)) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", /Image not found: missing\.png/);
      assert.equal(modelCalls, 0, "input validation must fail before the model is called");
      assert.ok(
        statuses.some((status) => status?.includes("Loading input…")),
        "input loading must have started",
      );
      assert.ok(
        statuses.at(-1)?.includes("Unrelated action…"),
        "vision cleanup must immediately restore the unrelated reporter's status",
      );

      statuses.length = 0;
      mock.timers.tick(5000);
      assert.ok(statuses.length > 0, "an unrelated reporter must survive vision cleanup");
      assert.ok(
        statuses.every((status) => status?.includes("Unrelated action…")),
        `only the unrelated reporter may tick, got ${JSON.stringify(statuses)}`,
      );
      cleanupProgressReporter(unrelated);
      assert.equal(statuses.at(-1), undefined, "cleanup must clear the final shared status");
      statuses.length = 0;
      mock.timers.tick(5000);
      assert.deepEqual(statuses, [], "a failed input load must not leave a ticking status reporter");

      writeFileSync(
        join(cwd, "shot.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JEsYAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      setSdkGetModelOverride(() => fakeVisionModel());
      setSdkStreamSimpleOverride((() => {
        modelCalls++;
        return successfulStream("vision complete");
      }) as never);
      statuses.length = 0;
      const success = (await execute("t", { path: "shot.png" }, undefined, undefined, ctx)) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };
      assert.equal(success.isError, false);
      assert.equal(success.content[0]?.text, "vision complete");
      assert.equal(modelCalls, 1, "the successful valid image must reach the model");
      assert.equal(statuses.at(-1), undefined, "the successful call must clear its status immediately");
      statuses.length = 0;
      mock.timers.tick(5000);
      assert.deepEqual(statuses, [], "a successful vision call must not leave a ticker");

      setSdkStreamSimpleOverride((() => {
        modelCalls++;
        return rejectedStream();
      }) as never);
      statuses.length = 0;
      await assert.rejects(execute("t", { path: "shot.png" }, undefined, undefined, ctx), /stream rejected/);
      assert.equal(modelCalls, 2, "the rejected valid image must reach the model");
      assert.equal(statuses.at(-1), undefined, "the rejected call must clear its status immediately");
      statuses.length = 0;
      mock.timers.tick(5000);
      assert.deepEqual(statuses, [], "a rejected vision call must not leave a ticker");
    } finally {
      if (unrelated) cleanupProgressReporter(unrelated);
      setSdkGetModelOverride(null);
      setSdkStreamSimpleOverride(null);
      mock.timers.reset();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
