import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeWaiTest } from "./test.js";
import { setLastReviewedCommit } from "../session-state.js";
import {
  gitAvailable,
  initGitRepo,
  prepareRepo,
  startStubServer,
  closeStubServer,
  writeSettings,
  bodyText,
  commitAll,
} from "./integration-harness.js";
import type { Server } from "node:http";

const hasGit = gitAvailable();
const tmpDirs: string[] = [];
const servers: Server[] = [];
after(() => {
  for (const server of servers) {
    closeStubServer(server);
  }
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

const TEST_PASS = { verdict: "pass", findings: [], missingTests: [], summary: "ok" };

function writeTestSettings(cwd: string, url: string): void {
  writeSettings(cwd, {
    reviewLevel: "min",
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
}

describe("executeWaiTest range selection", () => {
  it("analyzes committed work on a clean tree (commit-per-round workflow)", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "wai-test-range-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    // Round 1 committed; the tree is CLEAN — previously this produced an
    // empty diff ("no changes detected").
    prepareRepo(cwd, { "a.ts": "export const a = 1;\n" }, { "a.ts": "export const TEST_MARKER_111 = 2;\n" });
    const { url, bodies, server } = await startStubServer({ payload: TEST_PASS });
    servers.push(server);
    writeTestSettings(cwd, url);

    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiTest(cwd, "clean tree probe", ctx, {}, undefined, () => {});
    assert.equal(result.test?.verdict, "pass");
    const body = bodyText(bodies, 0);
    assert.ok(body.includes("TEST_MARKER_111"), "committed round-1 changes must reach the model");
  });

  it("keeps the accepted baseline span in scope once a review baseline exists", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "wai-test-baseline-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    prepareRepo(cwd, { "a.ts": "export const a = 1;\n" }, { "a.ts": "export const BASELINE_MARKER = 2;\n" });
    // Simulate an accepted review baseline after round 1.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe" }).toString().trim();
    setLastReviewedCommit(cwd, head);
    // Round 2 committed.
    writeFileSync(join(cwd, "b.ts"), "export const ROUND2_MARKER = 3;\n");
    commitAll(cwd);

    const { url, bodies, server } = await startStubServer({ payload: TEST_PASS });
    servers.push(server);
    writeTestSettings(cwd, url);

    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiTest(cwd, "baseline probe", ctx, {}, undefined, () => {});
    assert.equal(result.test?.verdict, "pass");
    const body = bodyText(bodies, 0);
    assert.ok(body.includes("ROUND2_MARKER"), "round-2 changes must be in scope");
  });
});
