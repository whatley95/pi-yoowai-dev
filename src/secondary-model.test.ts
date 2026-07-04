import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callSecondaryModel, setPiSpawnResolver } from "./secondary-model.js";

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
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini" });

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
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini" });

    const script = join(cwd, "fake-pi-fail.js");
    writeFileSync(script, `process.stderr.write("something went wrong"); process.exit(1);`, "utf-8");
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script] }));

    await assert.rejects(
      () => callSecondaryModel("openai", "gpt-4o-mini", "system", "user", { thinking: "off", cwd }),
      /something went wrong/,
    );
  });

  it("pi backend inherits a sanitized session snapshot when sessionManager is provided", async () => {
    const cwd = makeTempDir("pi-heyyoo-pi-session-");
    tmpDirs.push(cwd);
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini" });

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
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini" });

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
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini" });

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
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini" });

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
      { provider: "openai", id: "gpt-4o-mini" },
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
});
