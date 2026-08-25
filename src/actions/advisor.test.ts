import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWaiAdvisor } from "./advisor.js";
import { resolveAdvisorTaskModel } from "../config.js";
import { getAgentDir, setAgentDirForTests } from "../pi-paths.js";
import type { YoowaiConfig } from "../types.js";

describe("executeWaiAdvisor (stub-server end-to-end)", () => {
  const tmpDirs: string[] = [];
  const servers: Server[] = [];
  const originalAgentDir = getAgentDir();
  let emptyAgentDir: string;

  before(() => {
    // Isolate from the real ~/.pi/agent/settings.json so the user's global
    // secondary config cannot leak into the probe.
    emptyAgentDir = mkdtempSync(join(tmpdir(), "advisor-agent-"));
    setAgentDirForTests(() => emptyAgentDir);
  });

  after(() => {
    setAgentDirForTests(() => originalAgentDir);
    for (const server of servers) server.close();
    try {
      rmSync(emptyAgentDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  /** OpenAI-compatible stub returning a canned plain-text advice response. */
  async function startStubServer(): Promise<{ url: string; bodies: string[] }> {
    const bodies: string[] = [];
    const server = await new Promise<Server>((resolve) => {
      const s = createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf-8");
        });
        req.on("end", () => {
          bodies.push(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: "Use a Record here — the keys are known and stable.",
                  },
                },
              ],
              usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
            }),
          );
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("stub server has no port");
    return { url: `http://127.0.0.1:${address.port}`, bodies };
  }

  function writeSettings(cwd: string, piYoowai: Record<string, unknown>): void {
    const piDir = join(cwd, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "settings.json"), JSON.stringify({ "pi-yoowai": piYoowai }), "utf-8");
  }

  it("returns plain-text advice in one call without a JSON contract", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "advisor-run-"));
    tmpDirs.push(cwd);
    const { url, bodies } = await startStubServer();
    writeSettings(cwd, {
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });

    const result = await executeWaiAdvisor(cwd, "Map or Record for this cache?", undefined, () => {});

    assert.equal(bodies.length, 1, "expected exactly one model call");
    assert.equal(result.action, "advisor");
    assert.ok(result.advisor, "expected an advisor result");
    assert.equal(result.advisor.advice, "Use a Record here — the keys are known and stable.");
    assert.ok(result.cost, "expected recorded cost");
    assert.equal(result.model?.id, "gpt-4o-mini");
    // Plain-text contract: no structured-output config in the request body.
    const body = JSON.parse(bodies[0]) as { response_format?: unknown };
    assert.equal(body.response_format, undefined, "advisor must not request structured output");
  });

  it("forwards the configured thinking level to the provider", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "advisor-think-"));
    tmpDirs.push(cwd);
    const { url, bodies } = await startStubServer();
    writeSettings(cwd, {
      secondary: {
        provider: "openai",
        id: "gpt-5-mini",
        thinking: "high",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });

    const result = await executeWaiAdvisor(cwd, "Map or Record?", undefined, () => {});
    assert.ok(result.advisor, "expected advice");
    const body = JSON.parse(bodies[0]) as { reasoning_effort?: string };
    assert.ok(body.reasoning_effort, "configured thinking must be forwarded to the provider");
  });

  it("injects advisor.md instructions into the system prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "advisor-inst-"));
    tmpDirs.push(cwd);
    const { url, bodies } = await startStubServer();
    writeSettings(cwd, {
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });
    const instructionsDir = join(cwd, ".pi", "yoowai", "instructions");
    mkdirSync(instructionsDir, { recursive: true });
    writeFileSync(join(instructionsDir, "advisor.md"), "NEVER_SUGGEST_MAPS\n", "utf-8");

    const result = await executeWaiAdvisor(cwd, "Map or Record?", undefined, () => {});
    assert.ok(result.advisor, "expected advice");
    const body = JSON.parse(bodies[0]) as { messages?: Array<{ role: string; content: string }> };
    const system = body.messages?.find((m) => m.role === "system")?.content ?? "";
    assert.ok(system.includes("<user_instructions>"), "advisor.md must be injected");
    assert.ok(system.includes("NEVER_SUGGEST_MAPS"), "advisor.md content must reach the system prompt");
  });

  it("rejects an empty response with a friendly error", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "advisor-empty-"));
    tmpDirs.push(cwd);
    // A stub that returns whitespace-only content.
    const bodies: string[] = [];
    const server = await new Promise<Server>((resolve) => {
      const s = createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf-8");
        });
        req.on("end", () => {
          bodies.push(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: "   \n  " } }],
              usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
            }),
          );
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("stub server has no port");
    writeSettings(cwd, {
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: "test-key",
      },
    });

    const result = await executeWaiAdvisor(cwd, "should I?", undefined, () => {});
    assert.equal(bodies.length, 1);
    assert.ok(result.error, "expected an error for an empty response");
    assert.match(result.error, /empty response/i);
    assert.equal(result.advisor, undefined);
  });

  it("returns a friendly error when the model call fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "advisor-err-"));
    tmpDirs.push(cwd);
    writeSettings(cwd, {
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        backend: "http",
        baseUrl: "http://127.0.0.1:9", // dead port
        apiKey: "test-key",
      },
    });

    const result = await executeWaiAdvisor(cwd, "should I?", undefined, () => {});
    assert.ok(result.error, "expected an error result");
    assert.match(result.error, /Secondary model unavailable/);
    assert.equal(result.model?.id, "gpt-4o-mini");
  });
});

describe("resolveAdvisorTaskModel integration", () => {
  it("prefers advisor over suggest over secondary", () => {
    const config: YoowaiConfig = {
      secondary: { provider: "openai", id: "gpt-4o-mini" },
      taskModels: {
        advisor: { provider: "deepseek", id: "deepseek-v4-flash", thinking: "off" },
        suggest: { provider: "anthropic", id: "claude-sonnet-4" },
      },
    };
    assert.equal(resolveAdvisorTaskModel(config).id, "deepseek-v4-flash");
    const withoutAdvisor: YoowaiConfig = { ...config, taskModels: { suggest: config.taskModels?.suggest } };
    assert.equal(resolveAdvisorTaskModel(withoutAdvisor).id, "claude-sonnet-4");
    assert.equal(resolveAdvisorTaskModel({ secondary: config.secondary }).id, "gpt-4o-mini");
  });
});
