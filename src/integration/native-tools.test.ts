import { it } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { createNativeToolRegistrar, reportNativeUsage } from "./native-tools.js";
import { cancelSessionWork } from "./session-work.js";
import { executeWaiIndex } from "../wai-index.js";
import { dispatchNativeReadTool } from "./read-tools.js";

function fixture(cwd: string, compactGuidance = false) {
  const definitions: ToolDefinition[] = [];
  let onResult: (event: ToolResultEvent) => { isError: boolean } | undefined;
  const pi = {
    registerTool: (definition: ToolDefinition) => definitions.push(definition),
    getAllTools: () => definitions,
    getSettings: () => ({}),
    appendEntry: () => {},
    on: (_name: string, handler: typeof onResult) => {
      onResult = handler;
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    register: createNativeToolRegistrar(pi, { compactGuidance }),
    definitions,
    onResult: (event: ToolResultEvent) => onResult(event),
    ctx: { cwd } as Parameters<ToolDefinition["execute"]>[4],
  };
}
const usage = (): Usage => ({
  input: 10,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  totalTokens: 19,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
});

it("scopes native reviewer reads to the registered wai invocation and releases the context afterward", async () => {
  const f = fixture("native-read-scope");
  const ctx = {
    ...f.ctx,
    tools: [{ name: "read" }],
    executeTool: async (name: string) => {
      assert.equal(name, "read");
      return { isError: false, result: { content: [{ type: "text", text: "host context" }] } };
    },
  } as unknown as typeof f.ctx;
  f.register({
    name: "wai",
    label: "wai",
    description: "read scope",
    parameters: Type.Object({}),
    execute: async () => {
      const result = await dispatchNativeReadTool(f.ctx.cwd, "read", { path: "src/file.ts" });
      assert.equal(result?.output, "host context");
      return { content: [], details: { action: "review" } };
    },
  });
  try {
    await f.definitions[0].execute("scope", {}, undefined, undefined, ctx);
    assert.equal(await dispatchNativeReadTool(f.ctx.cwd, "read", {}), undefined);
  } finally {
    cancelSessionWork(f.ctx.cwd);
  }
});

it("reads verdicts and errors through Pi's real codemode sandbox", { timeout: 30000 }, async (t) => {
  const host = (await import("@earendil-works/pi-coding-agent")) as unknown as {
    createCodemodeExtension?: (options: { models: boolean }) => (pi: ExtensionAPI) => void;
  };
  if (!host.createCodemodeExtension) {
    t.skip("Codemode requires Pi 0.99+");
    return;
  }
  const f = fixture("native-codemode-probe", true);
  let calls = 0;
  f.register({
    name: "wai",
    label: "wai",
    description: "probe",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "Human-readable report" }],
      details: ++calls === 1 ? { review: { verdict: "needs-work" } } : { error: "provider unavailable" },
    }),
  });
  f.register({
    name: "wai_index",
    label: "context",
    description: "context",
    parameters: Type.Object({ topic: Type.String() }),
    execute: async (_id, params) => ({
      content: [],
      details: executeWaiIndex(f.ctx.cwd, { topic: params.topic as "guidance" }),
    }),
  });
  host.createCodemodeExtension({ models: false })(f.pi);
  const codemode = f.definitions.find((tool) => tool.name === "codemode")!;
  const ctx = {
    ...f.ctx,
    sessionManager: { getBranch: () => [] },
    tools: f.definitions.filter((tool) => tool.name !== "codemode"),
    executeTool: async (name: string, args: unknown) => {
      const tool = f.definitions.find((tool) => tool.name === name)!;
      const result = await tool.execute(`codemode/${name}`, args, undefined, undefined, f.ctx);
      return {
        toolCall: { id: "codemode/wai", name, arguments: args },
        result,
        isError: !!f.onResult({ toolName: name, details: result.details } as ToolResultEvent)?.isError,
      };
    },
  } as unknown as Parameters<ToolDefinition["execute"]>[4];
  try {
    const result = await codemode.execute(
      "codemode",
      {
        code: "text((await tools.wai({})).review.verdict); text((await tools.wai({})).error); text((await describeNamespace('wai')).instructions.includes('models.generateImages')); text((await tools.wai_index({topic:'guidance'})).guidance.includes('base64'));",
      },
      undefined,
      undefined,
      ctx,
    );
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    assert.match(text, /Script completed/);
    assert.match(text, /needs-work/);
    assert.match(text, /provider unavailable/);
    assert.match(text, /true[\s\S]*true/);
    assert.equal(calls, 2);
  } finally {
    cancelSessionWork(f.ctx.cwd);
  }
});

it("keeps full guidance on legacy hosts and core rules plus a discoverable namespace on modern hosts", () => {
  for (const compact of [false, true]) {
    const f = fixture(`native-metadata-${compact}`, compact);
    f.register({
      name: "wai",
      label: "wai",
      description: "original",
      promptGuidelines: ["original rule"],
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    });
    const definition = f.definitions[0] as ToolDefinition & {
      namespace?: { name: string; instructions: string };
      outputSchema?: { properties: Record<string, unknown> };
    };
    if (compact) {
      assert.equal(definition.namespace?.name, "wai");
      assert.match(definition.namespace?.instructions ?? "", /Scoped|scoped/);
      assert.match(definition.promptGuidelines?.join("\n") ?? "", /Commit only when authorized/);
    } else {
      assert.equal(definition.namespace, undefined);
      assert.deepEqual(definition.promptGuidelines, ["original rule"]);
      assert.equal(definition.description, "original");
    }
    assert.ok(definition.outputSchema?.properties.review);
  }
});

it("marks structured failures through Pi's actual agent tool-result path and preserves details and usage", async () => {
  const f = fixture("native-runtime-probe");
  f.register({
    name: "wai",
    label: "wai",
    description: "probe",
    parameters: Type.Object({}),
    execute: async () => {
      reportNativeUsage(usage());
      await Promise.all([
        Promise.resolve().then(() => reportNativeUsage(usage())),
        Promise.resolve().then(() => reportNativeUsage(usage())),
      ]);
      return {
        content: [{ type: "text", text: "configuration failed" }],
        details: { error: "configuration failed", action: "review" },
      };
    },
  });
  const tool = f.definitions[0];
  assert.equal(tool.executionMode, "sequential");
  let requests = 0;
  const streamFn: AgentOptions["streamFn"] = () => {
    const first = requests++ === 0;
    const message: AssistantMessage = {
      role: "assistant",
      api: "anthropic-messages",
      provider: "probe",
      model: "probe",
      timestamp: Date.now(),
      usage: usage(),
      content: first
        ? [{ type: "toolCall", id: "probe", name: "wai", arguments: {} }]
        : [{ type: "text", text: "done" }],
      stopReason: first ? "toolUse" : "stop",
    };
    return {
      [Symbol.asyncIterator]: async function* () {
        yield { type: "done", reason: message.stopReason, message };
      },
      result: async () => message,
    } as ReturnType<AgentOptions["streamFn"]>;
  };
  const agent = new Agent({
    streamFn,
    initialState: {
      tools: [{ ...tool, execute: (id, params, signal, update) => tool.execute(id, params, signal, update, f.ctx) }],
    },
    afterToolCall: async ({ toolCall, args, result, isError }) =>
      f.onResult({
        type: "tool_result",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        input: args,
        ...result,
        isError,
      } as ToolResultEvent),
  });
  await agent.prompt("exercise the tool");
  const result = agent.state.messages.find((message) => message.role === "toolResult");
  assert.ok(result && result.role === "toolResult");
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, { error: "configuration failed", action: "review" });
  assert.equal(result.usage?.input, 30);
  assert.equal(result.usage?.cost.total, 30);
  cancelSessionWork(f.ctx.cwd);
});

it("keeps findings successful and omits usage on a cache-only result", async () => {
  const f = fixture("native-cache-probe");
  f.register({
    name: "wai",
    label: "wai",
    description: "probe",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: { review: { verdict: "needs-work" } } }),
  });
  const result = await f.definitions[0].execute("cache", {}, undefined, undefined, f.ctx);
  assert.deepEqual((result as typeof result & { structuredContent: unknown }).structuredContent, {
    review: { verdict: "needs-work" },
  });
  assert.equal((f.definitions[0] as ToolDefinition & { outputSchema: { type: string } }).outputSchema.type, "object");
  assert.equal(result.usage, undefined);
  assert.equal(f.onResult({ toolName: "wai", details: result.details } as ToolResultEvent), undefined);
  cancelSessionWork(f.ctx.cwd);
});

it("returns JSON structured errors and omits undefined details without changing rendered content", async () => {
  const f = fixture("native-structured-error");
  f.register({
    name: "wai",
    label: "wai",
    description: "probe",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "provider failed" }],
      details: { action: "review", error: "provider failed", review: undefined },
    }),
  });
  const result = await f.definitions[0].execute("error", {}, undefined, undefined, f.ctx);
  assert.deepEqual((result as typeof result & { structuredContent: unknown }).structuredContent, {
    action: "review",
    error: "provider failed",
  });
  assert.deepEqual(result.content, [{ type: "text", text: "provider failed" }]);
  assert.deepEqual(f.onResult({ toolName: "wai", details: result.details } as ToolResultEvent), { isError: true });
  cancelSessionWork(f.ctx.cwd);
});

it("serializes mutations and aborts outgoing queued calls before they execute", async () => {
  const f = fixture("native-queue-probe");
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  f.register({
    name: "wai",
    label: "wai",
    description: "probe",
    parameters: Type.Object({}),
    execute: async () => {
      calls++;
      entered();
      if (calls === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return { content: [], details: {} };
    },
  });
  const execute = () => f.definitions[0].execute("queue", {}, undefined, undefined, f.ctx);
  const first = execute();
  await started;
  const second = execute();
  const rejected = Promise.all([assert.rejects(first, /cancelled/), assert.rejects(second, /cancelled/)]);
  cancelSessionWork(f.ctx.cwd);
  // A provider ignoring abort must not hold the replacement session's queue.
  await execute();
  finish();
  await rejected;
  assert.equal(calls, 2);
  cancelSessionWork(f.ctx.cwd);
});
