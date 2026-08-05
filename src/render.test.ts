import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { renderCall, renderResult } from "./render.js";
import { setAgentDirForTests, getAgentDir } from "./pi-paths.js";
import type { WaiToolResult } from "./types.js";

const theme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
};

function textOf(component: Text): string {
  return component.render(200).join("\n").trimEnd();
}

function toolResult(details: WaiToolResult): AgentToolResult<WaiToolResult> {
  return { content: [{ type: "text", text: "x" }], details } as unknown as AgentToolResult<WaiToolResult>;
}

describe("renderCall review level", () => {
  it("shows the explicit level in the review call title", () => {
    const title = textOf(renderCall({ review: "check the retry loop" }, theme, {}, "med"));
    assert.equal(title, "wai review (med): check the retry loop");
  });

  it("omits the level marker when none is available", () => {
    const title = textOf(renderCall({ review: "check the retry loop" }, theme, {}));
    assert.equal(title, "wai review: check the retry loop");
  });
});

describe("renderCall review level from config", () => {
  const tmpDirs: string[] = [];
  const originalAgentDir = getAgentDir();
  const emptyAgentDir = mkdtempSync(join(tmpdir(), "render-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "render-cwd-"));
  tmpDirs.push(cwd);

  before(() => {
    setAgentDirForTests(() => emptyAgentDir);
    const piDir = join(cwd, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "settings.json"),
      JSON.stringify({
        "pi-yoowai": { reviewLevel: "high", secondary: { provider: "openai", id: "gpt-4o-mini" } },
      }),
      "utf-8",
    );
  });

  after(() => {
    setAgentDirForTests(() => originalAgentDir);
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

  it("resolves the effective level from the session cwd for the generic wai tool", () => {
    const title = textOf(renderCall({ review: "check the retry loop" }, theme, { cwd }));
    assert.equal(title, "wai review (high): check the retry loop");
  });
});

describe("renderResult review level", () => {
  it("shows the level in the in-progress line", () => {
    const line = textOf(
      renderResult(
        toolResult({
          action: "review",
          level: "med",
          inProgress: true,
          progressMessage: "Calling kimi-coding:k3-256k…",
          stage: 8,
          total: 10,
        } as WaiToolResult),
        { isPartial: false, expanded: false },
        theme,
        {},
      ),
    );
    assert.equal(line, "wai review (med) [8/10] Calling kimi-coding:k3-256k…");
  });

  it("shows the level in the final verdict line", () => {
    const line = textOf(
      renderResult(
        toolResult({
          action: "review",
          level: "min",
          review: { verdict: "pass", issues: [], suggestions: [], consensus: true },
          model: { provider: "kimi-coding", id: "k3-256k" },
        }),
        { isPartial: false, expanded: false },
        theme,
        {},
      ),
    );
    assert.ok(line.includes("wai review (min) ✓ pass · kimi-coding:k3-256k"), line);
  });

  it("omits the level marker when the result has none", () => {
    const line = textOf(
      renderResult(
        toolResult({
          action: "review",
          review: { verdict: "pass", issues: [], suggestions: [], consensus: true },
        }),
        { isPartial: false, expanded: false },
        theme,
        {},
      ),
    );
    assert.ok(line.includes("wai review ✓ pass"), line);
    assert.ok(!line.includes("("), line);
  });
});
