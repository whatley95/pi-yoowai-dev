import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeWaiSecurity } from "./security.js";
import {
  gitAvailable,
  initGitRepo,
  prepareRepo,
  startStubServer,
  closeStubServer,
  writeSettings,
  bodyText,
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

const SECURITY_PASS = { verdict: "pass", findings: [], summary: "ok" };

function writeSecuritySettings(cwd: string, url: string): void {
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

describe("executeWaiSecurity range selection", () => {
  it("audits committed work on a clean tree (commit-per-round workflow)", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "wai-security-range-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    // Round 1 committed; clean tree — previously an empty diff.
    prepareRepo(cwd, { "a.ts": "export const a = 1;\n" }, { "a.ts": "export const SECURITY_MARKER_222 = 2;\n" });
    const { url, bodies, server } = await startStubServer({ payload: SECURITY_PASS });
    servers.push(server);
    writeSecuritySettings(cwd, url);

    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiSecurity(cwd, "clean tree probe", ctx, {}, undefined, () => {});
    assert.equal(result.security?.verdict, "pass");
    const body = bodyText(bodies, 0);
    assert.ok(body.includes("SECURITY_MARKER_222"), "committed round-1 changes must reach the model");
  });

  it("a capped multi-file diff is rebuilt and audited completely", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "wai-security-rebuild-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    const filler = "z".repeat(3900);
    prepareRepo(
      cwd,
      { "a.txt": "a1\n", "b.txt": "b1\n", "c.txt": "c1\n" },
      {
        "a.txt": `SEC_REBUILD_A\n${filler}\n`,
        "b.txt": `SEC_REBUILD_B\n${filler}\n`,
        "c.txt": `${filler}\nSEC_REBUILD_C\n`,
      },
    );
    const { url, bodies, server } = await startStubServer({ payload: SECURITY_PASS });
    servers.push(server);
    writeSecuritySettings(cwd, url);
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
    const result = await executeWaiSecurity(cwd, "security rebuild probe", ctx, {}, undefined, () => {});
    assert.equal(result.security?.verdict, "pass");
    const body = bodyText(bodies, 0);
    assert.ok(
      body.includes("SEC_REBUILD_A") && body.includes("SEC_REBUILD_B") && body.includes("SEC_REBUILD_C"),
      "all markers must reach the model",
    );
  });

  it("an over-budget rebuilt diff fails closed instead of auditing a fragment", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "wai-security-rebuild-fail-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    const filler = "z".repeat(8900);
    prepareRepo(
      cwd,
      { "a.txt": "a1\n", "b.txt": "b1\n", "c.txt": "c1\n", "d.txt": "d1\n", "e.txt": "e1\n" },
      {
        "a.txt": `SEC_FAIL_A\n${filler}\n`,
        "b.txt": `SEC_FAIL_B\n${filler}\n`,
        "c.txt": `SEC_FAIL_C\n${filler}\n`,
        "d.txt": `SEC_FAIL_D\n${filler}\n`,
        "e.txt": `SEC_FAIL_E\n${filler}\n`,
      },
    );
    const { url, bodies, server } = await startStubServer({ payload: SECURITY_PASS });
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
    const result = await executeWaiSecurity(cwd, "security rebuild fail-closed probe", ctx, {}, undefined, () => {});
    assert.ok(result.error, "expected an error result");
    assert.match(result.error, /too large/);
    assert.match(result.error, /files:\[\.\.\.\]/);
    assert.equal(bodies.length, 0, "no model call may happen for an over-budget change");
  });
});
