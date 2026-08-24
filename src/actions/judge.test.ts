import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWaiJudge } from "./judge.js";
import { getAgentDir, setAgentDirForTests } from "../pi-paths.js";
import { gitSpawnEnv } from "../git-env.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

describe("executeWaiJudge fail-closed budget guard + result caching", () => {
  const tmpDirs: string[] = [];
  const originalAgentDir = getAgentDir();
  let emptyAgentDir: string;
  let servers: Server[] = [];

  before(() => {
    // Isolate from the real ~/.pi/agent/settings.json so the user's global
    // secondary/task models cannot leak into these probes.
    emptyAgentDir = mkdtempSync(join(tmpdir(), "judge-guard-agent-"));
    setAgentDirForTests(() => emptyAgentDir);
  });

  after(() => {
    setAgentDirForTests(() => originalAgentDir);
    for (const server of servers) {
      server.close();
    }
    servers = [];
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

  function gitAvailable(): boolean {
    try {
      execFileSync("git", ["--version"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }
  const hasGit = gitAvailable();

  function gitOpts() {
    return { stdio: "pipe" as const, env: gitSpawnEnv() };
  }

  function makeRepoWithChange(change: string): string {
    const cwd = mkdtempSync(join(tmpdir(), "judge-guard-repo-"));
    tmpDirs.push(cwd);
    execFileSync("git", ["init"], { cwd, ...gitOpts() });
    execFileSync("git", ["config", "user.email", "wai-test@example.com"], { cwd, ...gitOpts() });
    execFileSync("git", ["config", "user.name", "wai test"], { cwd, ...gitOpts() });
    writeFileSync(join(cwd, "a.txt"), "hello\n");
    execFileSync("git", ["add", "."], { cwd, ...gitOpts() });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], { cwd, ...gitOpts() });
    writeFileSync(join(cwd, "a.txt"), change);
    const piDir = join(cwd, ".pi");
    mkdirSync(piDir, { recursive: true });
    return cwd;
  }

  /** A locally stubbed OpenAI-compatible endpoint: counts requests and returns
   *  a canned passing judgment. */
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
                    content: JSON.stringify({
                      verdict: "pass",
                      issues: [],
                      suggestions: [],
                      consensus: true,
                      summary: "ok",
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
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
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": piYoowai }), "utf-8");
  }

  it("judge fails closed on an over-budget diff before any model call", { skip: !hasGit }, async () => {
    const bigLine = "x".repeat(200);
    const big = Array.from({ length: 500 }, (_, i) => `${i} ${bigLine}`).join("\n");
    const cwd = makeRepoWithChange(big);
    writeSettings(cwd, {
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        // Dead port proves zero model calls: a regression would surface a
        // connection error instead of the guidance.
        backend: "http",
        baseUrl: "http://127.0.0.1:9",
      },
    });

    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiJudge(cwd, "oversized judge probe", undefined, () => {}, ctx.sessionManager);

    assert.ok(result.error, "expected an error result");
    assert.match(result.error, /too large for a judge review/);
    assert.match(result.error, /files:\[\.\.\.\]/);
    assert.match(result.error, /reviewMaxInputTokens/);
  });

  it(
    "identical double judge run with pre-review commands is served from cache (one model call total)",
    { skip: !hasGit },
    async () => {
      const marker = "JUDGE_CACHE_MARKER_777";
      const small = `hello\n\n${marker}\n` + "z".repeat(500) + "\n";
      const cwd = makeRepoWithChange(small);
      const { url, bodies } = await startStubServer();
      writeSettings(cwd, {
        // Pre-review commands used to disable caching; the key covers the
        // command LIST, so a hit never re-runs them.
        preReviewCommands: ["npm --version"],
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

      const ctx = { cwd } as unknown as ExtensionContext;
      const first = await executeWaiJudge(cwd, "cache probe", undefined, () => {}, ctx.sessionManager);
      const second = await executeWaiJudge(cwd, "cache probe", undefined, () => {}, ctx.sessionManager);

      assert.equal(bodies.length, 1, "second identical judge must hit the cache, not call the model again");
      assert.equal(first.judge?.verdict, "pass");
      assert.equal(second.judge?.verdict, "pass");
    },
  );

  it(
    "council judge with selfVerify runs 4 model calls and verifies without the council field",
    { skip: !hasGit },
    async () => {
      const marker = "JUDGE_COUNCIL_VERIFY_MARKER_991";
      const small = `hello\n\n${marker}\n` + "z".repeat(500) + "\n";
      const cwd = makeRepoWithChange(small);
      const { url, bodies } = await startStubServer();
      writeSettings(cwd, {
        selfVerify: true,
        // Two distinct ids dedupe to two members; both inherit the http
        // backend + baseUrl from `secondary`.
        judgeCouncil: ["openai/gpt-4o-mini", "openai/gpt-4o-mini-2"],
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

      const ctx = { cwd } as unknown as ExtensionContext;
      // NB: the description is embedded in the judge prompt and re-sent inside
      // the verification request, so it must not contain the word "council"
      // for the body assertion below to be meaningful.
      const result = await executeWaiJudge(cwd, "joint verdict verify probe", undefined, () => {}, ctx.sessionManager);

      // 2 council members + 1 synthesis + 1 self-verification call.
      assert.equal(bodies.length, 4, "council judge + selfVerify must make exactly four model requests");
      assert.equal(result.judge?.verdict, "pass");
      assert.equal(
        result.judge?.council?.members.length,
        2,
        "council summary must survive self-verification on the result",
      );
      // The verification request re-sends the original context + result; the
      // runtime-attached council summary must be stripped from the serialized
      // result so the verifier cannot echo it back (which would fail schema
      // validation). Parse the "judge result to verify" section and assert the
      // JSON has no council key.
      const verifyBody = JSON.parse(bodies[3]) as { messages: Array<{ role: string; content: string }> };
      const verifyUser = verifyBody.messages.find((m) => m.role === "user")?.content ?? "";
      const sectionMarker = "judge result to verify:";
      const resultSection = verifyUser.slice(verifyUser.indexOf(sectionMarker) + sectionMarker.length);
      const resultJson = resultSection.slice(0, resultSection.indexOf("\n\n---"));
      const resultToVerify = JSON.parse(resultJson) as Record<string, unknown>;
      assert.ok(
        !("council" in resultToVerify),
        "serialized judge result in the verify prompt must not carry the council field",
      );

      // End-to-end: self-verification must succeed (no invalid-JSON WARN).
      const logPath = join(cwd, ".pi", "yoowai", "wai.log");
      const log = readFileSync(logPath, "utf-8");
      assert.match(log, /Self-verified judge result/);
      assert.doesNotMatch(log, /Self-verification of judge produced invalid JSON/);
    },
  );
});
