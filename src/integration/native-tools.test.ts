import { it } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { createNativeToolRegistrar, reportNativeUsage } from "./native-tools.js";
import { cancelSessionWork } from "./session-work.js";

function fixture(cwd: string) {
  const definitions: ToolDefinition[] = [];
  let onResult: (event: ToolResultEvent) => { isError: boolean } | undefined;
  const pi = {
    registerTool: (definition: ToolDefinition) => definitions.push(definition),
    on: (_name: string, handler: typeof onResult) => {
      onResult = handler;
    },
  } as unknown as ExtensionAPI;
  return {
    register: createNativeToolRegistrar(pi),
    definitions,
    onResult: (event: ToolResultEvent) => onResult(event),
    ctx: { cwd } as ExtensionContext,
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
  assert.equal(result.usage, undefined);
  assert.equal(f.onResult({ toolName: "wai", details: result.details } as ToolResultEvent), undefined);
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
