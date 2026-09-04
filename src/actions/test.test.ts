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

  it("a capped multi-file diff is rebuilt and reviewed completely", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "wai-test-rebuild-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    // Combined ~12k chars > 10k cap (truncated); per-file diffs ~4k fit; the
    // rebuilt total fits the model budget → complete review in one call. c's
    // marker sits at its TAIL, beyond the ~10k combined slice (a's and b's
    // diffs fill it), so only the per-file rebuild can deliver it.
    const filler = "z".repeat(3900);
    prepareRepo(
      cwd,
      { "a.txt": "a1\n", "b.txt": "b1\n", "c.txt": "c1\n" },
      {
        "a.txt": `TEST_REBUILD_A\n${filler}\n`,
        "b.txt": `TEST_REBUILD_B\n${filler}\n`,
        "c.txt": `${filler}\nTEST_REBUILD_C\n`,
      },
    );
    const { url, bodies, server } = await startStubServer({ payload: TEST_PASS });
    servers.push(server);
    writeSettings(cwd, {
      reviewLevel: "min",
      reviewMaxDiffChars: 10000,
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 16000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });
    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiTest(cwd, "rebuild probe", ctx, {}, undefined, () => {});
    assert.equal(result.test?.verdict, "pass");
    const body = bodyText(bodies, 0);
    assert.ok(
      body.includes("TEST_REBUILD_A") && body.includes("TEST_REBUILD_B") && body.includes("TEST_REBUILD_C"),
      "all markers must reach the model",
    );
  });

  it(
    "an over-budget rebuilt diff fails closed with guidance instead of reviewing a fragment",
    { skip: !hasGit },
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "wai-test-rebuild-fail-"));
      tmpDirs.push(cwd);
      initGitRepo(cwd);
      // Combined ~32k chars > 10k cap; per-file diffs ~8k fit the cap; the
      // rebuilt total (~8k tokens) EXCEEDS the model budget → fail closed.
      const filler = "z".repeat(7900);
      prepareRepo(
        cwd,
        { "a.txt": "a1\n", "b.txt": "b1\n", "c.txt": "c1\n", "d.txt": "d1\n" },
        {
          "a.txt": `FAIL_A\n${filler}\n`,
          "b.txt": `FAIL_B\n${filler}\n`,
          "c.txt": `FAIL_C\n${filler}\n`,
          "d.txt": `FAIL_D\n${filler}\n`,
        },
      );
      const { url, bodies, server } = await startStubServer({ payload: TEST_PASS });
      servers.push(server);
      writeSettings(cwd, {
        reviewLevel: "min",
        reviewMaxDiffChars: 10000,
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
      const result = await executeWaiTest(cwd, "rebuild fail-closed probe", ctx, {}, undefined, () => {});
      assert.ok(result.error, "expected an error result");
      assert.match(result.error, /too large/);
      assert.match(result.error, /files:\[\.\.\.\]/);
      assert.equal(bodies.length, 0, "no model call may happen for an over-budget change");
    },
  );

  it("a per-file cap fails closed before any model call", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "wai-test-perfile-cap-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    const fillerA = "z".repeat(2400);
    const fillerB = "z".repeat(5900);
    prepareRepo(
      cwd,
      { "a.txt": "a1\n", "b.txt": "b1\n" },
      { "a.txt": `PERFILE_A\n${fillerA}\n`, "b.txt": `PERFILE_B\n${fillerB}\n` },
    );
    const { url, bodies, server } = await startStubServer({ payload: TEST_PASS });
    servers.push(server);
    writeSettings(cwd, {
      reviewLevel: "min",
      reviewMaxDiffChars: 4000,
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 16000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });
    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiTest(cwd, "per-file cap probe", ctx, {}, undefined, () => {});
    assert.ok(result.error, "expected an error result");
    assert.match(result.error, /reviewMaxDiffChars/);
    assert.equal(bodies.length, 0, "no model call may happen for a per-file cap");
  });

  it("renamed files are accepted by content in the rebuild", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "wai-test-rename-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "old.txt"), "base\n" + "z".repeat(1500) + "\nbase_tail\n");
    commitAll(cwd);
    // Genuine rename with HIGH similarity (default 50% threshold): old.txt and
    // new.txt share ~99% of their content, so git classifies the delete/add as
    // a rename and reports the NEW path in the diff header. a.txt is BIG (its
    // diff ~3.5k fills most of the 4000-char slab), so new.txt's hunks fall
    // BEYOND the combined slice — and its marker sits at the file's TAIL,
    // which the sliced combined diff can never contain. Only the per-file
    // rebuild (and its content-based acceptance of the renamed path) can
    // deliver it.
    rmSync(join(cwd, "old.txt"));
    writeFileSync(join(cwd, "new.txt"), "base\n" + "z".repeat(1500) + "\nRENAME_MARKER\n");
    writeFileSync(join(cwd, "a.txt"), `RENAME_SIDE\n` + "z".repeat(3400) + "\n");
    commitAll(cwd);
    const { url, bodies, server } = await startStubServer({ payload: TEST_PASS });
    servers.push(server);
    writeSettings(cwd, {
      reviewLevel: "min",
      reviewMaxDiffChars: 4000,
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 16000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });
    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiTest(cwd, "rename rebuild probe", ctx, {}, undefined, () => {});
    assert.equal(result.test?.verdict, "pass");
    const body = bodyText(bodies, 0);
    assert.ok(body.includes("RENAME_MARKER"), "the renamed file's diff must reach the model by content");
    assert.ok(body.includes("RENAME_SIDE"), "the companion change must be in scope");
  });
});
