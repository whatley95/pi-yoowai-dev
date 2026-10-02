import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewBatch, type ReviewBatchInput } from "./review-helpers.js";
import { getAgentDir, setAgentDirForTests } from "../pi-paths.js";
import { getSessionCost, recordCost } from "../cost-tracker.js";
import type { SecondaryModelConfig } from "../types.js";

const originalFetch = global.fetch;
const originalAgentDir = getAgentDir();
const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
before(() => setAgentDirForTests(() => agentDir));
const agentDir = temp("wai-batch-agent-");
afterEach(() => {
  global.fetch = originalFetch;
});
after(() => {
  setAgentDirForTests(() => originalAgentDir);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const model: SecondaryModelConfig = {
  provider: "openai",
  id: "gpt-4o-mini",
  thinking: "off",
  backend: "http",
  apiKey: "test-key",
  baseUrl: "https://wai.test/api",
  maxRetries: 0,
  contextWindow: 64_000,
  maxOutputTokens: 2048,
};
function setup(): ReviewBatchInput {
  const cwd = temp("wai-context-batch-");
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      "pi-yoowai": { secondary: model, secondaryFallback: [{ ...model, id: "fallback-must-not-run" }] },
    }),
  );
  return {
    cwd,
    description: "Review all six files in the task",
    diff: "diff --git a/pubspec.lock b/pubspec.lock\n@@ -1 +1 @@\n-old\n+new\n",
    files: [],
    truncated: false,
    droppedFiles: [],
    sessionContext: "",
    conventionsText: "",
    preReviewOutput: "",
    memoryContext: "",
    modelConfig: model,
    relevantPaths: ["pubspec.lock"],
    enableToolLoop: true,
    maxToolIterations: 3,
    allowAdaptiveToolContext: true,
    evidencePackMaxTokens: 0,
    assignment: { files: ["pubspec.lock"], batchIndex: 2, batchCount: 6 },
    budget: {
      contextWindow: 64_000,
      availableInputTokens: 54_000,
      reservedOutputTokens: 2048,
      safetyMarginTokens: 6400,
    },
  };
}
function mockModel(answer: (system: string, user: string) => unknown): void {
  global.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> };
    assert.equal(body.model, "gpt-4o-mini", "a local evidence limit must not restart work through a fallback provider");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(answer(body.messages[0].content, body.messages[1].content)) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

describe("review batch evidence recovery", () => {
  it("reads a 55 KB missing file in complete pages while the 8 KB captured diff is already free", async () => {
    const input = setup();
    const source = "LOCK_START_" + "x".repeat(55_290) + "_LOCK_END";
    writeFileSync(join(input.cwd, "pubspec.lock"), source);
    input.diff += "+" + "d".repeat(8000);
    input.files = [{ file: "pubspec.lock", content: "file outline", mode: "outline", lineCount: 1, tokenEstimate: 3 }];
    let calls = 0;
    const pages: string[] = [];
    mockModel((system, user) => {
      calls++;
      assert.match(user, /Batch 2 of 6/);
      assert.match(user, /Assigned files: \["pubspec.lock"\]/);
      assert.match(user, /other batches review the remaining/);
      assert.match(system, /Other assigned batches are reviewed separately/);
      assert.ok(user.includes(input.diff), "complete captured diff is present from the first call");
      if (calls === 1) return { tool: "read_file", path: "pubspec.lock" };
      const result = user.slice(user.lastIndexOf("## Tool result:"));
      pages.push(
        result
          .slice(result.indexOf("]\n") + 2)
          .split("\n… (truncated")[0]
          .split("\n\nRemaining context requests:")[0],
      );
      const hint = result.match(/next page: (\{[^\n]+\})/);
      return hint ? JSON.parse(hint[1]) : { verdict: "pass", issues: [], suggestions: [], consensus: true };
    });
    const result = await runReviewBatch(input);
    assert.equal(
      pages.join(""),
      source,
      "all source characters including the tail were supplied without gaps or repeats",
    );
    assert.equal(pages.length, 4);
    assert.equal(calls, 5);
    assert.equal(result.review.verdict, "pass");
    recordCost(input.cwd, result.usage);
    assert.equal(getSessionCost(input.cwd).calls, calls);
  });

  it("returns a structured coverage gap for an explicit cap and records provider usage once", async () => {
    const input = setup();
    writeFileSync(join(input.cwd, "pubspec.lock"), "FIRST_EVIDENCE");
    input.maxToolIterations = 1;
    input.allowAdaptiveToolContext = false;
    let calls = 0;
    mockModel((_system, user) => {
      calls++;
      if (calls === 2) assert.match(user, /FIRST_EVIDENCE/);
      return { tool: "read_file", path: calls === 1 ? "pubspec.lock" : "pubspec.yaml" };
    });
    const result = await runReviewBatch(input);
    assert.equal(result.review.verdict, "needs-work");
    assert.equal(result.review.contextLimited, true);
    assert.equal(result.review.consensus, false);
    assert.equal(result.review.stepComplete, false);
    assert.deepEqual(result.review.coverageGaps, ["pubspec.yaml"]);
    assert.deepEqual(result.review.issues, []);
    assert.match(result.review.suggestions[0], /allowance exhausted/);
    recordCost(input.cwd, result.usage);
    assert.equal(getSessionCost(input.cwd).calls, 2);
    assert.equal(getSessionCost(input.cwd).inputTokens, 200);
  });

  it("preserves the missing path when additional evidence cannot fit the configured input cap", async () => {
    const input = setup();
    input.budget.hardInputCap = 1200;
    let calls = 0;
    mockModel(() => {
      calls++;
      return { tool: "read_file", path: "pubspec.yaml" };
    });
    const result = await runReviewBatch(input);
    assert.equal(calls, 1);
    assert.equal(result.review.contextLimited, true);
    assert.deepEqual(result.review.coverageGaps, ["pubspec.yaml"]);
    assert.match(result.review.suggestions[0], /input allowance exhausted/);
    recordCost(input.cwd, result.usage);
    assert.equal(getSessionCost(input.cwd).calls, 1);
  });
});
