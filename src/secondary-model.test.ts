import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import {
  callSecondaryModel,
  providerSupportsJsonObject,
  setPiSpawnResolver,
  setPiSessionId,
  clearPiSessionId,
  getProviderApiInfo,
  setSdkGetModelOverride,
  setSdkStreamSimpleOverride,
} from "./secondary-model.js";
import { setSdkOAuthResolverOverride } from "./backends/sdk-backend.js";
import { setAgentDirForTests, getAgentDir } from "./pi-paths.js";

const originalAgentDir = getAgentDir();
let tempAgentDirs: string[] = [];

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSettings(cwd: string, secondary: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  const piDir = join(cwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "settings.json"),
    JSON.stringify({ "pi-heyyoo": { secondary, ...extra } }, null, 2),
    "utf-8",
  );
}

function writeAuthJson(agentDir: string, auth: Record<string, unknown>): void {
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth, null, 2), "utf-8");
}

after(() => {
  for (const dir of tempAgentDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  tempAgentDirs = [];
  setAgentDirForTests(() => originalAgentDir);
});

describe("secondary-model backends", () => {
  const originalFetch = global.fetch;
  let tmpDirs: string[] = [];

  after(() => {
    global.fetch = originalFetch;
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs = [];
  });

  afterEach(() => {
    setPiSpawnResolver(null);
    setSdkGetModelOverride(null);
    setSdkStreamSimpleOverride(null);
    setSdkOAuthResolverOverride(null);
    global.fetch = originalFetch;
    setAgentDirForTests(() => originalAgentDir);
  });

  it("uses pi backend when backend: pi is configured", async () => {
    const cwd = makeTempDir("pi-heyyoo-pi-default-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", backend: "pi" });

    const script = join(cwd, "fake-pi.js");
    writeFileSync(
      script,
      `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"pi backend ok"}],usage:{input:10,output:5,cost:0.0001}}}));`,
      "utf-8",
    );
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script] }));

    const { content, usage } = await callSecondaryModel("openai", "gpt-4o-mini", "system", "user", {
      thinking: "off",
      cwd,
    });

    assert.equal(content, "pi backend ok");
    assert.equal(usage.estimatedInputTokens, 10);
    assert.equal(usage.estimatedOutputTokens, 5);
    assert.ok(usage.estimatedCostUsd > 0);
  });

  it("uses http backend when configured and returns fetch response", async () => {
    const cwd = makeTempDir("pi-heyyoo-http-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", backend: "http", apiKey: "sk-test" });

    global.fetch = async (url, init) => {
      assert.ok(String(url).includes("/chat/completions"));
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      assert.equal(body.model, "gpt-4o-mini");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "http backend ok" } }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
        text: async () => "",
      } as Response;
    };

    const { content, usage } = await callSecondaryModel("openai", "gpt-4o-mini", "system", "user", {
      thinking: "off",
      cwd,
    });

    assert.equal(content, "http backend ok");
    assert.equal(usage.estimatedInputTokens, 20);
    assert.equal(usage.estimatedOutputTokens, 10);
  });

  it("throws when pi backend exits with no assistant text", async () => {
    const cwd = makeTempDir("pi-heyyoo-pi-fail-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", backend: "pi" });

    const script = join(cwd, "fake-pi-fail.js");
    writeFileSync(script, `process.stderr.write("something went wrong"); process.exit(1);`, "utf-8");
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script] }));

    await assert.rejects(
      () => callSecondaryModel("openai", "gpt-4o-mini", "system", "user", { thinking: "off", cwd }),
      /something went wrong/,
    );
  });

  it("retries pi backend on empty output then succeeds", async () => {
    const cwd = makeTempDir("pi-heyyoo-pi-retry-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", backend: "pi" });

    // First call: exit 0 with no output. Second call: produce assistant text.
    const script = join(cwd, "fake-pi-retry.js");
    writeFileSync(
      script,
      `
const fs = require("node:fs");
const counterFile = ${JSON.stringify(join(cwd, ".retry-count"))};
let count = 0;
try { count = parseInt(fs.readFileSync(counterFile, "utf-8"), 10) || 0; } catch {}
count++;
fs.writeFileSync(counterFile, String(count), "utf-8");
if (count === 1) { process.exit(0); }
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"recovered on retry"}],usage:{input:5,output:3,cost:0.0001}}}));
`,
      "utf-8",
    );
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script] }));

    const { content } = await callSecondaryModel("openai", "gpt-4o-mini", "system", "user", {
      thinking: "off",
      cwd,
    });
    assert.equal(content, "recovered on retry");
  });

  it("throws with attempt count after exhausting pi backend retries", async () => {
    const cwd = makeTempDir("pi-heyyoo-pi-retry-exhaust-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", backend: "pi" });

    // Always exit 0 with no output.
    const script = join(cwd, "fake-pi-empty.js");
    writeFileSync(script, `process.exit(0);`, "utf-8");
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script] }));

    await assert.rejects(
      () => callSecondaryModel("openai", "gpt-4o-mini", "system", "user", { thinking: "off", cwd }),
      /no assistant text after 3 attempts/,
    );
  });

  it("pi backend inherits a sanitized session snapshot when sessionManager is provided", async () => {
    const cwd = makeTempDir("pi-heyyoo-pi-session-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", backend: "pi" });

    const script = join(cwd, "fake-pi-session.js");
    writeFileSync(
      script,
      `
const fs = require("node:fs");
const sessionPath = process.argv.find(a => !a.startsWith("-") && a.endsWith(".jsonl"));
const lines = fs.readFileSync(sessionPath, "utf-8").trim().split("\\n");
const hasInherited = lines.some(l => l.includes('"inherited":true'));
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:hasInherited ? "saw inherited session" : "no inherited session"}],usage:{input:5,output:3,cost:0.0001}}}));
`,
      "utf-8",
    );
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script] }));

    const sessionManager = {
      getHeader: () => ({ type: "header", inherited: true }),
      getBranch: () => [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "parent user" }], inherited: true },
        },
      ],
    };

    const { content } = await callSecondaryModel("openai", "gpt-4o-mini", "system", "user", {
      thinking: "off",
      cwd,
      sessionManager,
    });

    assert.equal(content, "saw inherited session");
  });

  it("filters inherited branch to conversation messages and excludes noise", async () => {
    const cwd = makeTempDir("pi-heyyoo-pi-filter-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", backend: "pi" });

    const script = join(cwd, "fake-pi-echo.js");
    writeFileSync(
      script,
      `
const fs = require("node:fs");
const sessionPath = process.argv.find(a => !a.startsWith("-") && a.endsWith(".jsonl"));
const jsonl = fs.readFileSync(sessionPath, "utf-8");
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:jsonl}],usage:{input:5,output:3,cost:0.0001}}}));
`,
      "utf-8",
    );
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script] }));

    const messages: unknown[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push({
        type: "message",
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: `msg-${i}` }],
        },
      });
      if (i % 3 === 0) messages.push({ type: "progress", message: `progress-${i}` });
    }

    const sessionManager = {
      getHeader: () => ({ type: "header" }),
      getBranch: () => messages,
    };

    const { content } = await callSecondaryModel("openai", "gpt-4o-mini", "system", "user", {
      thinking: "off",
      cwd,
      sessionManager,
    });

    const lines = content.split("\n").filter((l) => l.trim());
    const entries = lines.map((l) => JSON.parse(l));
    const header = entries.shift();
    const taskUser = entries.pop();
    const taskSystem = entries.pop();
    assert.equal(header?.type, "header");
    assert.equal(taskSystem?.message?.role, "system");
    assert.equal(taskUser?.message?.role, "user");

    const inheritedMessages = entries.filter(
      (e) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"),
    );
    assert.equal(inheritedMessages.length, 10);
    assert.ok(!entries.some((e) => e.type === "progress"));
    assert.ok(!inheritedMessages.some((e) => e.message?.content?.[0]?.text === "msg-0"));
    assert.ok(inheritedMessages.some((e) => e.message?.content?.[0]?.text === "msg-2"));
    assert.ok(inheritedMessages.some((e) => e.message?.content?.[0]?.text === "msg-11"));
  });

  it("prioritizes relevant paths when selecting inherited branch entries", async () => {
    const cwd = makeTempDir("pi-heyyoo-pi-relevant-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", backend: "pi" });

    const script = join(cwd, "fake-pi-echo.js");
    writeFileSync(
      script,
      `
const fs = require("node:fs");
const sessionPath = process.argv.find(a => !a.startsWith("-") && a.endsWith(".jsonl"));
const jsonl = fs.readFileSync(sessionPath, "utf-8");
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:jsonl}],usage:{input:5,output:3,cost:0.0001}}}));
`,
      "utf-8",
    );
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script] }));

    const messages: unknown[] = [];
    for (let i = 0; i < 12; i++) {
      const text = i === 2 ? "discussing src/utils.ts behavior" : `msg-${i}`;
      messages.push({
        type: "message",
        message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text }] },
      });
    }

    const sessionManager = {
      getHeader: () => ({ type: "header" }),
      getBranch: () => messages,
    };

    const { content } = await callSecondaryModel("openai", "gpt-4o-mini", "system", "user", {
      thinking: "off",
      cwd,
      sessionManager,
      relevantPaths: ["src/utils.ts"],
    });

    const lines = content.split("\n").filter((l) => l.trim());
    const entries = lines.map((l) => JSON.parse(l));
    const taskUser = entries.pop();
    const taskSystem = entries.pop();
    entries.shift(); // header
    assert.equal(taskSystem?.message?.role, "system");
    assert.equal(taskUser?.message?.role, "user");

    const inheritedMessages = entries.filter(
      (e) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"),
    );
    assert.equal(inheritedMessages.length, 10);
    assert.ok(inheritedMessages.some((e) => e.message?.content?.[0]?.text === "discussing src/utils.ts behavior"));
    assert.ok(!inheritedMessages.some((e) => e.message?.content?.[0]?.text === "msg-0"));
    assert.ok(!inheritedMessages.some((e) => e.message?.content?.[0]?.text === "msg-1"));
    assert.ok(inheritedMessages.some((e) => e.message?.content?.[0]?.text === "msg-11"));
  });

  it("skips malformed session entries with undefined message objects", async () => {
    const cwd = makeTempDir("pi-heyyoo-pi-malformed-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", backend: "pi" });

    const script = join(cwd, "fake-pi-echo.js");
    writeFileSync(
      script,
      `
const fs = require("node:fs");
const sessionPath = process.argv.find(a => !a.startsWith("-") && a.endsWith(".jsonl"));
const jsonl = fs.readFileSync(sessionPath, "utf-8");
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:jsonl}],usage:{input:5,output:3,cost:0.0001}}}));
`,
      "utf-8",
    );
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script] }));

    const sessionManager = {
      getHeader: () => ({ type: "header" }),
      getBranch: () => [
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "valid assistant" }] } },
        { type: "message", message: undefined },
        { type: "message" },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "valid user" }] } },
        { type: "progress", message: "progress" },
      ],
    };

    const { content } = await callSecondaryModel("openai", "gpt-4o-mini", "system", "user", {
      thinking: "off",
      cwd,
      sessionManager,
    });

    const lines = content.split("\n").filter((l) => l.trim());
    const entries = lines.map((l) => JSON.parse(l));
    entries.shift(); // header
    entries.pop(); // task system
    entries.pop(); // task user

    const validEntries = entries.filter(
      (e) => e.type === "message" && e.message && (e.message.role === "user" || e.message.role === "assistant"),
    );
    assert.equal(validEntries.length, 2);
    assert.ok(validEntries.some((e) => e.message.content?.[0]?.text === "valid assistant"));
    assert.ok(validEntries.some((e) => e.message.content?.[0]?.text === "valid user"));
  });

  it("uses task model override when task option is provided", async () => {
    const cwd = makeTempDir("pi-heyyoo-pi-task-");
    tmpDirs.push(cwd);
    writeSettings(
      cwd,
      { provider: "openai", id: "gpt-4o-mini", backend: "pi" },
      { taskModels: { review: { provider: "anthropic", id: "claude-3-5-sonnet" } } },
    );

    const script = join(cwd, "fake-pi-args.js");
    writeFileSync(
      script,
      `
const args = process.argv;
const provider = args[args.indexOf("--provider") + 1];
const model = args[args.indexOf("--model") + 1];
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:provider + ":" + model}],usage:{input:5,output:3,cost:0.0001}}}));
`,
      "utf-8",
    );
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script] }));

    const { content } = await callSecondaryModel("openai", "gpt-4o-mini", "system", "user", {
      thinking: "off",
      cwd,
      task: "review",
    });

    assert.equal(content, "anthropic:claude-3-5-sonnet");
  });

  it("adds response_format json_object for supported providers when structuredOutput is true", async () => {
    const cwd = makeTempDir("pi-heyyoo-http-json-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", backend: "http", apiKey: "sk-test" });

    let body: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        text: async () => "",
      } as Response;
    };

    await callSecondaryModel("openai", "gpt-4o-mini", "system", "user", {
      thinking: "off",
      cwd,
      structuredOutput: true,
    });

    assert.deepEqual(body.response_format, { type: "json_object" });
  });

  it("uses full model max_tokens for structured output when thinking is off", async () => {
    const cwd = makeTempDir("pi-heyyoo-http-struct-tokens-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", backend: "http", apiKey: "sk-test" });

    let body: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        text: async () => "",
      } as Response;
    };

    await callSecondaryModel("openai", "gpt-4o-mini", "system", "user", {
      thinking: "off",
      cwd,
      structuredOutput: true,
    });

    // gpt-4o-mini catalog maxOutputTokens is 16_384, so structured output should not be capped at 2048.
    assert.equal(body.max_tokens, 16_384);
  });

  it("omits response_format for unsupported providers even when structuredOutput is true", async () => {
    const cwd = makeTempDir("pi-heyyoo-http-no-json-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "anthropic", id: "claude-3-5-sonnet", backend: "http", apiKey: "sk-test" });

    let body: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "{}" }], usage: { input_tokens: 10, output_tokens: 5 } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    await callSecondaryModel("anthropic", "claude-3-5-sonnet", "system", "user", {
      thinking: "off",
      cwd,
      structuredOutput: true,
    });

    assert.equal("response_format" in body, false);
    assert.equal(body.stream, true);
  });

  it("streams Anthropic-style SSE responses and accumulates text deltas", async () => {
    const cwd = makeTempDir("pi-heyyoo-http-anthropic-sse-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "anthropic", id: "claude-3-5-sonnet", backend: "http", apiKey: "sk-test" });

    const sseLines = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","type":"message","role":"assistant","model":"claude-3-5-sonnet","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"streamed"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" text"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":2}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ];
    const sseBody = sseLines.map((line) => `${line}\n\n`).join("");

    global.fetch = async () =>
      new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const { content, usage } = await callSecondaryModel("anthropic", "claude-3-5-sonnet", "system", "user", {
      thinking: "off",
      cwd,
    });

    assert.equal(content, "streamed text");
    assert.equal(usage.estimatedInputTokens, 10);
    assert.equal(usage.estimatedOutputTokens, 2);
  });

  it("omits response_format when structuredOutput is false", async () => {
    const cwd = makeTempDir("pi-heyyoo-http-no-struct-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", backend: "http", apiKey: "sk-test" });

    let body: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "hi" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        text: async () => "",
      } as Response;
    };

    await callSecondaryModel("openai", "gpt-4o-mini", "system", "user", {
      thinking: "off",
      cwd,
      structuredOutput: false,
    });

    assert.equal("response_format" in body, false);
  });
});

describe("providerSupportsJsonObject", () => {
  it("returns true for known OpenAI-compatible providers", () => {
    assert.equal(providerSupportsJsonObject("openai"), true);
    assert.equal(providerSupportsJsonObject("deepseek"), true);
    assert.equal(providerSupportsJsonObject("openrouter"), true);
  });

  it("returns false for Anthropic", () => {
    assert.equal(providerSupportsJsonObject("anthropic"), false);
  });

  it("returns true for custom OpenAI-compatible baseUrl", () => {
    assert.equal(
      providerSupportsJsonObject("custom", "x", {
        provider: "custom",
        id: "x",
        baseUrl: "https://example.com/v1",
        style: "openai-compatible",
      }),
      true,
    );
  });

  it("returns false for custom Anthropic-compatible baseUrl", () => {
    assert.equal(
      providerSupportsJsonObject("custom", "x", {
        provider: "custom",
        id: "x",
        baseUrl: "https://example.com/v1",
        style: "anthropic",
      }),
      false,
    );
  });
});

describe("PROVIDER_API_MAP coverage", () => {
  it("includes all providers from Pi's built-in list", () => {
    // These are the providers pi-heyyoo can call directly via HTTP.
    // Complex providers (bedrock, vertex, azure, github-copilot, cloudflare) are
    // intentionally excluded — they fall back to the pi process backend.
    const expected = [
      "anthropic",
      "openai",
      "deepseek",
      "openrouter",
      "groq",
      "mistral",
      "xai",
      "together",
      "fireworks",
      "cerebras",
      "google",
      "ant-ling",
      "nvidia",
      "huggingface",
      "moonshotai",
      "moonshotai-cn",
      "xiaomi",
      "xiaomi-token-plan-ams",
      "xiaomi-token-plan-cn",
      "xiaomi-token-plan-sgp",
      "zai",
      "zai-coding-cn",
      "kimi-coding",
      "minimax",
      "minimax-cn",
      "vercel-ai-gateway",
    ];
    for (const p of expected) {
      assert.ok(providerSupportsJsonObject(p) !== undefined, `Provider ${p} should be in PROVIDER_API_MAP`);
    }
  });

  it("uses correct baseUrl for together (not .xyz)", () => {
    // Pi uses api.together.ai, not api.together.xyz
    const info = getProviderApiInfo("together");
    assert.ok(info);
    assert.equal(info!.baseUrl, "https://api.together.ai/v1");
  });

  it("anthropic-style providers have anthropic style", () => {
    for (const p of ["kimi-coding", "minimax", "minimax-cn", "vercel-ai-gateway"]) {
      const info = getProviderApiInfo(p);
      assert.ok(info, `Provider ${p} should exist`);
      assert.equal(info!.style, "anthropic", `Provider ${p} should be anthropic style`);
    }
  });

  it("new OpenAI-compatible providers support json_object", () => {
    for (const p of ["ant-ling", "nvidia", "huggingface", "moonshotai", "zai", "xiaomi"]) {
      assert.equal(providerSupportsJsonObject(p), true, `Provider ${p} should support json_object`);
    }
  });
});

describe("per-model API overrides", () => {
  it("opencode-go/opencode models are excluded from direct HTTP API map", () => {
    assert.equal(getProviderApiInfo("opencode-go", "kimi-k2.7-code"), undefined);
    assert.equal(getProviderApiInfo("opencode-go", "deepseek-v4-pro"), undefined);
    assert.equal(getProviderApiInfo("opencode-go", "qwen3.7-max"), undefined);
    assert.equal(getProviderApiInfo("opencode-go", "minimax-m3"), undefined);
    assert.equal(getProviderApiInfo("opencode", "claude-opus-4-5"), undefined);
    assert.equal(getProviderApiInfo("opencode"), undefined);
  });
});

describe("auto-detect backend", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("defaults to sdk backend for known provider without explicit backend config", async () => {
    const cwd = makeTempDir("yoo-auto-sdk-known-");
    writeSettings(cwd, { provider: "deepseek", id: "deepseek-chat", apiKey: "sk-test" });
    let sdkCalled = false;
    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride(() => {
      sdkCalled = true;
      return fakeSdkStream(fakeSdkAssistantMessage("sdk default ok"));
    });
    try {
      const { content } = await callSecondaryModel("deepseek", "deepseek-chat", "sys", "usr", { cwd });
      assert.equal(content, "sdk default ok");
      assert.ok(sdkCalled, "Should have used SDK backend for known provider");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("defaults to sdk backend for unknown provider without explicit backend config", async () => {
    const cwd = makeTempDir("yoo-auto-sdk-unknown-");
    writeSettings(cwd, { provider: "some-unknown-provider", id: "x", apiKey: "sk-test" });
    let sdkCalled = false;
    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride(() => {
      sdkCalled = true;
      return fakeSdkStream(fakeSdkAssistantMessage("sdk default ok"));
    });
    try {
      const { content } = await callSecondaryModel("some-unknown-provider", "x", "sys", "usr", { cwd });
      assert.equal(content, "sdk default ok");
      assert.ok(sdkCalled, "Should have used SDK backend for unknown provider");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses http backend when baseUrl is set even for unknown provider", async () => {
    const cwd = makeTempDir("yoo-auto-url-");
    writeSettings(cwd, {
      provider: "custom-provider",
      id: "x",
      baseUrl: "https://custom.example.com/v1",
      apiKey: "sk-test",
    });
    let fetchCalled = false;
    global.fetch = (async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await callSecondaryModel("custom-provider", "x", "sys", "usr", { cwd });
      assert.ok(fetchCalled, "Should have used HTTP when baseUrl is set");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function fakeSdkModel(provider: string, modelId: string, api: string = "openai-completions"): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl: "https://example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
    contextWindow: 128000,
    maxTokens: 4096,
  } as Model<Api>;
}

function fakeSdkAssistantMessage(text: string, usage?: Partial<Usage>, stopReason = "stop"): AssistantMessage {
  const inputTokens = usage?.input ?? 10;
  const outputTokens = usage?.output ?? 5;
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "opencode-go",
    model: "qwen3.7-max",
    usage: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  } as AssistantMessage;
}

function fakeSdkStream(message: AssistantMessage): import("@earendil-works/pi-ai").AssistantMessageEventStream {
  return {
    result: async () => message,
    [Symbol.asyncIterator]: async function* () {
      yield { type: "done", reason: "stop", message };
    },
  } as unknown as import("@earendil-works/pi-ai").AssistantMessageEventStream;
}

function fakeSdkStreamingStream(
  deltas: string[],
  finalMessage: AssistantMessage,
): import("@earendil-works/pi-ai").AssistantMessageEventStream {
  return {
    result: async () => finalMessage,
    [Symbol.asyncIterator]: async function* () {
      for (const delta of deltas) {
        yield { type: "text_delta", contentIndex: 0, delta, partial: finalMessage };
      }
      yield { type: "done", reason: "stop", message: finalMessage };
    },
  } as unknown as import("@earendil-works/pi-ai").AssistantMessageEventStream;
}

describe("sdk backend", () => {
  let tmpDirs: string[] = [];

  after(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs = [];
  });

  afterEach(() => {
    setSdkGetModelOverride(null);
    setSdkStreamSimpleOverride(null);
    setSdkOAuthResolverOverride(null);
    setAgentDirForTests(() => originalAgentDir);
  });

  after(() => {
    for (const dir of tmpDirs) {
      try {
        clearPiSessionId(dir);
      } catch {
        // ignore
      }
    }
  });

  it("opencode-go defaults to sdk backend", async () => {
    const cwd = makeTempDir("yoo-sdk-default-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "opencode-go", id: "qwen3.7-max", apiKey: "opencode-test" });

    let sdkCalled = false;
    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId, "anthropic-messages"));
    setSdkStreamSimpleOverride((_model, context) => {
      sdkCalled = true;
      assert.ok(context.systemPrompt === "system");
      const userMsg = context.messages.find((m) => m.role === "user");
      assert.ok(userMsg);
      const textParts = Array.isArray(userMsg.content)
        ? userMsg.content.filter((c) => typeof c === "object" && c !== null && "text" in c)
        : [];
      assert.ok(textParts.some((c) => (c as { text: string }).text === "user"));
      return fakeSdkStream(fakeSdkAssistantMessage("sdk backend ok", { input: 10, output: 5 }));
    });

    const { content, usage } = await callSecondaryModel("opencode-go", "qwen3.7-max", "system", "user", { cwd });
    assert.equal(content, "sdk backend ok");
    assert.ok(sdkCalled);
    assert.equal(usage.estimatedInputTokens, 10);
    assert.equal(usage.estimatedOutputTokens, 5);
  });

  it("sdk backend returns text and usage", async () => {
    const cwd = makeTempDir("yoo-sdk-usage-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "opencode-go", id: "qwen3.7-max", apiKey: "opencode-test" });

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride(() =>
      fakeSdkStream(fakeSdkAssistantMessage("hello from sdk", { input: 20, output: 8 })),
    );

    const { content, usage } = await callSecondaryModel("opencode-go", "qwen3.7-max", "system", "user", { cwd });
    assert.equal(content, "hello from sdk");
    assert.equal(usage.estimatedInputTokens, 20);
    assert.equal(usage.estimatedOutputTokens, 8);
  });

  it("sdk backend throws with clear message on stopReason error", async () => {
    const cwd = makeTempDir("yoo-sdk-error-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "opencode-go", id: "qwen3.7-max", apiKey: "opencode-test" });

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride(() =>
      fakeSdkStream({
        ...fakeSdkAssistantMessage("", { input: 0, output: 0 }, "error"),
        errorMessage: "Inference is temporarily unavailable",
      } as AssistantMessage),
    );

    await assert.rejects(
      () => callSecondaryModel("opencode-go", "qwen3.7-max", "system", "user", { cwd }),
      /Inference is temporarily unavailable/,
    );
  });

  it("backend: pi overrides sdk default for opencode-go", async () => {
    const cwd = makeTempDir("yoo-sdk-pi-override-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "opencode-go", id: "qwen3.7-max", backend: "pi", apiKey: "opencode-test" });

    let sdkCalled = false;
    setSdkStreamSimpleOverride(() => {
      sdkCalled = true;
      return fakeSdkStream(fakeSdkAssistantMessage("should not happen"));
    });

    const script = join(cwd, "fake-pi-override.js");
    writeFileSync(
      script,
      `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"pi backend ok"}],usage:{input:10,output:5,cost:0.0001}}}));`,
      "utf-8",
    );
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script] }));

    const { content } = await callSecondaryModel("opencode-go", "qwen3.7-max", "system", "user", { cwd });
    assert.equal(content, "pi backend ok");
    assert.equal(sdkCalled, false);
  });

  it("backend: sdk works for non-opencode provider", async () => {
    const cwd = makeTempDir("yoo-sdk-explicit-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", backend: "sdk", apiKey: "sk-test" });

    let sdkCalled = false;
    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride(() => {
      sdkCalled = true;
      return fakeSdkStream(fakeSdkAssistantMessage("sdk explicit ok"));
    });

    const { content } = await callSecondaryModel("openai", "gpt-4o-mini", "system", "user", { cwd });
    assert.equal(content, "sdk explicit ok");
    assert.ok(sdkCalled);
  });

  it("sdk backend resolves OAuth API key for openai-codex", async () => {
    const cwd = makeTempDir("yoo-sdk-oauth-");
    const agentDir = makeTempDir("yoo-sdk-oauth-agent-");
    tmpDirs.push(cwd);
    tempAgentDirs.push(agentDir);
    mkdirSync(agentDir, { recursive: true });
    writeAuthJson(agentDir, { "openai-codex": { type: "oauth", accessToken: "old-token" } });
    setAgentDirForTests(() => agentDir);
    writeSettings(cwd, { provider: "openai-codex", id: "gpt-5.6-terra", backend: "sdk" });

    let receivedApiKey: string | undefined;
    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkOAuthResolverOverride(async () => ({
      apiKey: "refreshed-oauth-key",
      newCredentials: { accessToken: "new-token", expiresAt: 1234567890 },
    }));
    setSdkStreamSimpleOverride((_model, _context, options) => {
      receivedApiKey = options?.apiKey;
      return fakeSdkStream(fakeSdkAssistantMessage("codex ok"));
    });

    const { content } = await callSecondaryModel("openai-codex", "gpt-5.6-terra", "system", "user", { cwd });
    assert.equal(content, "codex ok");
    assert.equal(receivedApiKey, "refreshed-oauth-key");
  });

  it("sdk backend throws when model is not in Pi catalog", async () => {
    const cwd = makeTempDir("yoo-sdk-no-catalog-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "opencode-go", id: "unknown-model", apiKey: "opencode-test" });

    setSdkGetModelOverride(() => undefined);

    await assert.rejects(
      () => callSecondaryModel("opencode-go", "unknown-model", "system", "user", { cwd }),
      /not in Pi's built-in catalog/,
    );
  });

  it("sdk backend passes reasoning option when thinking is enabled", async () => {
    const cwd = makeTempDir("yoo-sdk-reasoning-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "opencode-go", id: "qwen3.7-max", apiKey: "opencode-test" });

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    let receivedOptions: SimpleStreamOptions | undefined;
    setSdkStreamSimpleOverride((_model, _context, options) => {
      receivedOptions = options;
      return fakeSdkStream(fakeSdkAssistantMessage("ok"));
    });

    await callSecondaryModel("opencode-go", "qwen3.7-max", "system", "user", { cwd, thinking: "high" });
    assert.equal(receivedOptions?.reasoning, "high");
  });

  it("sdk backend uses catalog maxTokens for non-thinking calls", async () => {
    const cwd = makeTempDir("yoo-sdk-catalog-tokens-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "opencode-go", id: "qwen3.7-max", apiKey: "opencode-test" });

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    let receivedOptions: SimpleStreamOptions | undefined;
    setSdkStreamSimpleOverride((_model, _context, options) => {
      receivedOptions = options;
      return fakeSdkStream(fakeSdkAssistantMessage("ok"));
    });

    await callSecondaryModel("opencode-go", "qwen3.7-max", "system", "user", { cwd, thinking: "off" });
    assert.equal(receivedOptions?.maxTokens, 2048);
  });

  it("sdk backend uses full catalog maxTokens for structured output when thinking is off", async () => {
    const cwd = makeTempDir("yoo-sdk-struct-tokens-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "opencode-go", id: "qwen3.7-max", apiKey: "opencode-test" });

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    let receivedOptions: SimpleStreamOptions | undefined;
    setSdkStreamSimpleOverride((_model, _context, options) => {
      receivedOptions = options;
      return fakeSdkStream(fakeSdkAssistantMessage("ok"));
    });

    await callSecondaryModel("opencode-go", "qwen3.7-max", "system", "user", {
      cwd,
      thinking: "off",
      structuredOutput: true,
    });
    assert.equal(receivedOptions?.maxTokens, 4096);
  });

  it("sdk backend passes cacheRetention, transport, and retry options", async () => {
    const cwd = makeTempDir("yoo-sdk-options-");
    tmpDirs.push(cwd);
    writeSettings(cwd, {
      provider: "opencode-go",
      id: "qwen3.7-max",
      apiKey: "opencode-test",
      cacheRetention: "long",
      transport: "websocket-cached",
      maxRetries: 5,
      maxRetryDelayMs: 2000,
      timeoutMs: 30000,
    });

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    let receivedOptions: SimpleStreamOptions | undefined;
    setSdkStreamSimpleOverride((_model, _context, options) => {
      receivedOptions = options;
      return fakeSdkStream(fakeSdkAssistantMessage("ok"));
    });

    await callSecondaryModel("opencode-go", "qwen3.7-max", "system", "user", { cwd });
    assert.equal(receivedOptions?.cacheRetention, "long");
    assert.equal(receivedOptions?.transport, "websocket-cached");
    assert.equal(receivedOptions?.maxRetries, 5);
    assert.equal(receivedOptions?.maxRetryDelayMs, 2000);
    assert.equal(receivedOptions?.timeoutMs, 30000);
  });

  it("sdk backend applies Pi agent default options when not configured", async () => {
    const cwd = makeTempDir("yoo-sdk-defaults-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "opencode-go", id: "qwen3.7-max", apiKey: "opencode-test" });

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    let receivedOptions: SimpleStreamOptions | undefined;
    setSdkStreamSimpleOverride((_model, _context, options) => {
      receivedOptions = options;
      return fakeSdkStream(fakeSdkAssistantMessage("ok"));
    });

    await callSecondaryModel("opencode-go", "qwen3.7-max", "system", "user", { cwd });
    assert.equal(receivedOptions?.cacheRetention, "short");
    assert.equal(receivedOptions?.maxRetries, 3);
    assert.equal(receivedOptions?.timeoutMs, 300_000);
  });

  it("sdk backend sends opencode attribution headers when sessionId is set", async () => {
    const cwd = makeTempDir("yoo-sdk-opencode-headers-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "opencode-go", id: "qwen3.7-max", apiKey: "opencode-test" });
    setPiSessionId(cwd, "yoo-session-123");

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId, "anthropic-messages"));
    let receivedOptions: SimpleStreamOptions | undefined;
    setSdkStreamSimpleOverride((_model, _context, options) => {
      receivedOptions = options;
      return fakeSdkStream(fakeSdkAssistantMessage("ok"));
    });

    await callSecondaryModel("opencode-go", "qwen3.7-max", "system", "user", { cwd });
    assert.equal(receivedOptions?.headers?.["x-opencode-session"], "yoo-session-123");
    assert.equal(receivedOptions?.headers?.["x-opencode-client"], "pi");
  });

  it("sdk backend omits opencode headers for non-opencode providers", async () => {
    const cwd = makeTempDir("yoo-sdk-no-opencode-headers-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", backend: "sdk", apiKey: "sk-test" });
    setPiSessionId(cwd, "yoo-session-456");

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    let receivedOptions: SimpleStreamOptions | undefined;
    setSdkStreamSimpleOverride((_model, _context, options) => {
      receivedOptions = options;
      return fakeSdkStream(fakeSdkAssistantMessage("ok"));
    });

    await callSecondaryModel("openai", "gpt-4o-mini", "system", "user", { cwd });
    assert.equal(receivedOptions?.headers?.["x-opencode-session"], undefined);
    assert.equal(receivedOptions?.headers?.["x-opencode-client"], undefined);
  });

  it("sdk backend invokes onStreamProgress with accumulated text", async () => {
    const cwd = makeTempDir("yoo-sdk-stream-progress-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "opencode-go", id: "qwen3.7-max", apiKey: "opencode-test" });

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride(() =>
      fakeSdkStreamingStream(["hello", " ", "world"], fakeSdkAssistantMessage("hello world")),
    );

    const progressTexts: string[] = [];
    const { content } = await callSecondaryModel("opencode-go", "qwen3.7-max", "system", "user", {
      cwd,
      onStreamProgress: (text) => progressTexts.push(text),
    });

    assert.equal(content, "hello world");
    assert.ok(progressTexts.length > 0);
    assert.equal(progressTexts[progressTexts.length - 1], "hello world");
  });

  it("sdk backend maps cacheRetention auto to short", async () => {
    const cwd = makeTempDir("yoo-sdk-auto-cache-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "opencode-go", id: "qwen3.7-max", apiKey: "opencode-test", cacheRetention: "auto" });

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    let receivedOptions: SimpleStreamOptions | undefined;
    setSdkStreamSimpleOverride((_model, _context, options) => {
      receivedOptions = options;
      return fakeSdkStream(fakeSdkAssistantMessage("ok"));
    });

    await callSecondaryModel("opencode-go", "qwen3.7-max", "system", "user", { cwd });
    assert.equal(receivedOptions?.cacheRetention, "short");
  });

  it("sdk backend falls back to SDK credential resolution when no explicit key is configured", async () => {
    const cwd = makeTempDir("yoo-sdk-credential-store-");
    tmpDirs.push(cwd);
    // Use a provider name with no env var mapping so pi-heyyoo's auth-reader
    // returns undefined, forcing reliance on the SDK's own credential lookup.
    writeSettings(cwd, { provider: "no-env-provider", id: "model-x" });

    let sdkCalled = false;
    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride((_model, _context, options) => {
      sdkCalled = true;
      assert.equal(options?.apiKey, undefined);
      return fakeSdkStream(fakeSdkAssistantMessage("sdk credential ok"));
    });

    const { content } = await callSecondaryModel("no-env-provider", "model-x", "system", "user", { cwd });
    assert.equal(content, "sdk credential ok");
    assert.ok(sdkCalled);
  });

  it("sdk backend falls back to pi backend on retryable SDK error", async () => {
    const cwd = makeTempDir("yoo-sdk-fallback-pi-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "opencode-go", id: "qwen3.7-max", apiKey: "opencode-test" });

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride(() => {
      throw new Error("503 Inference is temporarily unavailable");
    });

    const script = join(cwd, "fake-pi-fallback.js");
    writeFileSync(
      script,
      `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"pi fallback ok"}],usage:{input:10,output:5,cost:0.0001}}}));`,
      "utf-8",
    );
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script] }));

    const { content } = await callSecondaryModel("opencode-go", "qwen3.7-max", "system", "user", { cwd });
    assert.equal(content, "pi fallback ok");
  });

  it("sdk fallback surfaces both errors when pi backend also fails", async () => {
    const cwd = makeTempDir("yoo-sdk-fallback-pi-fail-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "opencode-go", id: "qwen3.7-max", apiKey: "opencode-test" });

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride(() => {
      throw new Error("503 Inference is temporarily unavailable");
    });

    const script = join(cwd, "fake-pi-fallback-fail.js");
    writeFileSync(script, `process.stderr.write("pi also down"); process.exit(1);`, "utf-8");
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script] }));

    await assert.rejects(
      () => callSecondaryModel("opencode-go", "qwen3.7-max", "system", "user", { cwd }),
      /SDK backend failed: 503 Inference is temporarily unavailable; pi fallback also failed:.*pi also down/,
    );
  });
});
