import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callSecondaryModel,
  providerSupportsJsonObject,
  setPiSpawnResolver,
  getProviderApiInfo,
} from "./secondary-model.js";

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
    global.fetch = originalFetch;
  });

  it("defaults to pi backend when no backend is configured", async () => {
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

  it("omits response_format for unsupported providers even when structuredOutput is true", async () => {
    const cwd = makeTempDir("pi-heyyoo-http-no-json-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "anthropic", id: "claude-3-5-sonnet", backend: "http", apiKey: "sk-test" });

    let body: Record<string, unknown> = {};
    global.fetch = async (_url, init) => {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "{}" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        text: async () => "",
      } as Response;
    };

    await callSecondaryModel("anthropic", "claude-3-5-sonnet", "system", "user", {
      thinking: "off",
      cwd,
      structuredOutput: true,
    });

    assert.equal("response_format" in body, false);
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
      providerSupportsJsonObject("custom", {
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
      providerSupportsJsonObject("custom", {
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

describe("auto-detect backend", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("uses http backend for known provider without explicit backend config", async () => {
    const cwd = makeTempDir("yoo-auto-http-");
    writeSettings(cwd, { provider: "deepseek", id: "deepseek-chat", apiKey: "sk-test" });
    let fetchCalled = false;
    global.fetch = (async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await callSecondaryModel("deepseek", "deepseek-chat", "sys", "usr", { cwd });
      assert.ok(fetchCalled, "Should have used direct HTTP fetch for known provider");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses pi backend for unknown provider without explicit backend config", async () => {
    const cwd = makeTempDir("yoo-auto-pi-");
    writeSettings(cwd, { provider: "some-unknown-provider", id: "x" });
    const script = join(cwd, "fake-pi-auto.js");
    writeFileSync(
      script,
      `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"ok"}],usage:{input:1,output:1,cost:0}}}));`,
      "utf-8",
    );
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script] }));
    try {
      const result = await callSecondaryModel("some-unknown-provider", "x", "sys", "usr", { thinking: "off", cwd });
      assert.equal(result.content, "ok", "Should have used pi backend for unknown provider");
    } finally {
      setPiSpawnResolver(null);
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
