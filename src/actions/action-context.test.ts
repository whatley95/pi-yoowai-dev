import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeWaiJudge } from "./judge.js";
import { executeWaiSecurity } from "./security.js";
import { executeWaiTest } from "./test.js";
import { prepareActionContext } from "./context-shared.js";
import {
  gitAvailable,
  initGitRepo,
  prepareRepo,
  writeSettings,
  closeStubServer,
  bodyText,
} from "./integration-harness.js";
import { getAgentDir, setAgentDirForTests } from "../pi-paths.js";
import { estimateTokens, type ReviewBudget } from "../token-budget.js";
import type { WaiToolResult, YoowaiConfig } from "../types.js";

const tmpDirs: string[] = [];
const servers: Server[] = [];
const originalAgentDir = getAgentDir();
const agentDir = mkdtempSync(join(tmpdir(), "wai-action-context-agent-"));
setAgentDirForTests(() => agentDir);
after(() => {
  setAgentDirForTests(() => originalAgentDir);
  for (const server of servers) closeStubServer(server);
  for (const dir of [...tmpDirs, agentDir]) rmSync(dir, { recursive: true, force: true });
});

const actions = ["judge", "security", "test"] as const;
type Action = (typeof actions)[number];
const pass = {
  verdict: "pass",
  issues: [],
  findings: [],
  missingTests: [],
  suggestions: [],
  consensus: true,
  summary: "ok",
};
const budget: ReviewBudget = {
  contextWindow: 64_000,
  reservedOutputTokens: 2048,
  safetyMarginTokens: 6400,
  availableInputTokens: 54_000,
};

async function execute(action: Action, cwd: string): Promise<WaiToolResult> {
  const ctx = { cwd } as unknown as ExtensionContext;
  return action === "judge"
    ? executeWaiJudge(cwd, "context probe", undefined, () => {})
    : action === "security"
      ? executeWaiSecurity(cwd, "context probe", ctx, {}, undefined, () => {})
      : executeWaiTest(cwd, "context probe", ctx, {}, undefined, () => {});
}

function repo(initial: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), "wai-action-context-"));
  tmpDirs.push(cwd);
  initGitRepo(cwd);
  prepareRepo(cwd, initial, { "a.ts": "export const a = 2;\n" });
  return cwd;
}

async function serverFor(response: (bodies: string[]) => unknown) {
  const bodies: string[] = [];
  const server = createServer((request, responseStream) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      bodies.push(body);
      responseStream.writeHead(200, { "Content-Type": "application/json" });
      responseStream.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(response(bodies)) } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { bodies, url: `http://127.0.0.1:${address.port}` };
}

function settings(cwd: string, url: string, extra: Record<string, unknown> = {}) {
  writeSettings(cwd, {
    secondary: {
      provider: "openai",
      id: "gpt-4o-mini",
      thinking: "off",
      backend: "http",
      baseUrl: url,
      apiKey: "test-key",
      contextWindow: budget.contextWindow,
      maxOutputTokens: budget.reservedOutputTokens,
    },
    reviewMaxDiffChars: 100_000,
    ...extra,
  });
}

describe("complete context across judgment, security and test analysis", () => {
  for (const action of actions) {
    it(
      `${action} reads the same complete 55 KB source in one request and two model rounds`,
      { skip: !gitAvailable() },
      async () => {
        const source = Array.from({ length: 230 }, (_, index) => `ROW_${index}_${"x".repeat(235)}`).join("\n");
        assert.ok(source.length > 55_000 && source.length < 64_000);
        const cwd = repo({ "a.ts": "export const a = 1;\n", "context.txt": source });
        const { bodies, url } = await serverFor((requests) =>
          requests.length === 1 ? { tool: "read_file", path: "context.txt" } : pass,
        );
        settings(cwd, url, { toolUseLoop: 1 });
        const result = await execute(action, cwd);
        assert.equal(result.error, undefined);
        assert.equal(result[action]?.verdict, "pass");
        assert.equal(bodies.length, 2);
        assert.ok(bodyText(bodies, 1).includes(source), "the entire identical source reaches the final call");
        assert.ok(!bodyText(bodies, 1).includes("next page:"));
        const first = JSON.parse(bodies[0]) as { messages: Array<{ content: string }> };
        assert.match(first.messages[0].content, /up to 1 new-evidence request/);
        for (const body of bodies) {
          const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
          const prompt = parsed.messages.map((message) => message.content).join("");
          assert.ok(estimateTokens(prompt) <= 55_552);
        }
      },
    );

    it(
      `${action} includes exact new-file source once and keeps modified-file contents`,
      { skip: !gitAvailable() },
      async () => {
        const cwd = repo({ "a.ts": "export const a = 1;\n" });
        writeFileSync(join(cwd, "a.ts"), "export const a = 3;\n");
        writeFileSync(join(cwd, "new.ts"), "export const ONLY_ONCE_918 = 1;\n");
        const { bodies, url } = await serverFor(() => pass);
        settings(cwd, url);
        const result = await execute(action, cwd);
        assert.equal(result.error, undefined);
        assert.equal(bodies.length, 1);
        const prompt = bodyText(bodies, 0);
        assert.equal(prompt.split("export const ONLY_ONCE_918 = 1;").length - 1, 1);
        assert.ok(prompt.includes("+++ b/new.ts"));
        assert.ok(prompt.split("export const a = 3;").length - 1 >= 2);
      },
    );

    it(
      `${action} rejects an impossible complete input cap before spending a model call`,
      { skip: !gitAvailable() },
      async () => {
        const cwd = repo({ "a.ts": "export const a = 1;\n" });
        const { bodies, url } = await serverFor(() => pass);
        settings(cwd, url, { reviewMaxInputTokens: 20 });
        const result = await execute(action, cwd);
        assert.match(result.error ?? "", /complete prompt is too large/);
        assert.equal(bodies.length, 0);
      },
    );
  }

  it("preserves disabled loops, true's five-request default and numeric caps", () => {
    const input = { cwd: agentDir, paths: ["a.ts"], files: [], budget, system: "system", user: "diff" };
    for (const action of actions) {
      for (const toolUseLoop of [undefined, false, true, 1, 7]) {
        const config: YoowaiConfig = { secondary: { provider: "openai", id: "gpt-4o-mini" }, toolUseLoop };
        const context = prepareActionContext(action, config, input);
        assert.ok(context.ok);
        assert.equal(context.options.enableToolLoop, !!toolUseLoop);
        if (toolUseLoop) {
          assert.equal(context.options.maxToolIterations, toolUseLoop === true ? 5 : toolUseLoop);
          assert.equal(context.options.readPageChars, 64_000);
        } else assert.equal(context.options.readPageChars, undefined);
      }
    }
  });

  it("bounds larger pages by remaining prompt capacity and includes the language directive", () => {
    const config: YoowaiConfig = {
      secondary: { provider: "openai", id: "gpt-4o-mini" },
      toolUseLoop: 1,
      language: "English",
    };
    const input = {
      cwd: agentDir,
      paths: [],
      files: [],
      budget: { ...budget, hardInputCap: 3600 },
      system: "system",
      user: "e".repeat(8000),
    };
    const context = prepareActionContext("judge", config, input);
    assert.ok(context.ok);
    assert.ok(context.options.readPageChars! < 1600);
    assert.equal(context.options.maxInputTokens, 3600);
    assert.equal(context.options.maxToolIterations, 1);
    assert.ok(!prepareActionContext("judge", config, { ...input, user: "e".repeat(15_000) }).ok);
  });
});
