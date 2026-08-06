import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  renderCall,
  renderResult,
  renderIndexCall,
  renderExplainCall,
  renderLearnCall,
  renderAuxResult,
} from "./render.js";
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

describe("aux tool call titles", () => {
  it("renders the index call with topic and update marker", () => {
    assert.equal(textOf(renderIndexCall({ topic: "plan", update: true }, theme, {})), "wai index: plan (update)");
    assert.equal(textOf(renderIndexCall({}, theme, {})), "wai index: all");
  });

  it("renders the explain call with the target", () => {
    assert.equal(
      textOf(renderExplainCall({ target: "what is a retry loop?" }, theme, {})),
      "wai explain: what is a retry loop?",
    );
    const long = "x".repeat(200);
    const title = textOf(renderExplainCall({ target: long }, theme, {}));
    assert.ok(title.startsWith("wai explain: "));
    assert.ok(title.length < 100, `expected truncation, got ${title.length}`);
  });

  it("renders the learn call for facts and verify paths", () => {
    assert.equal(textOf(renderLearnCall({ fact: "use node: prefix" }, theme, {})), "wai learn: use node: prefix");
    assert.equal(textOf(renderLearnCall({ verify: true, query: "config" }, theme, {})), "wai learn verify: config");
    assert.equal(
      textOf(renderLearnCall({ verify: true, deep: true, query: "config" }, theme, {})),
      "wai learn verify (deep): config",
    );
  });
});

describe("aux tool result rendering", () => {
  function auxResult(
    details: Record<string, unknown>,
    content = "line one\nline two\nline three",
  ): AgentToolResult<unknown> {
    return {
      content: [{ type: "text", text: content }],
      details,
    } as unknown as AgentToolResult<unknown>;
  }

  it("renders an index result with topic, updated marker, and preview", () => {
    const line = textOf(
      renderAuxResult(
        "index",
        auxResult({ topic: "plan", indexUpdated: true }),
        { isPartial: false, expanded: false },
        theme,
        {},
      ),
    );
    assert.ok(line.includes("wai index: plan (updated)"), line);
    assert.ok(line.includes("  line one"), line);
    assert.ok(line.includes("  line three"), line);
  });

  it("renders an explain result with model suffix, cost line, and preview", () => {
    const line = textOf(
      renderAuxResult(
        "explain",
        auxResult(
          {
            action: "explain",
            model: { provider: "kimi-coding", id: "k3-256k" },
            cost: { estimatedInputTokens: 1200, estimatedOutputTokens: 400, estimatedCostUsd: 0.002 },
          },
          "The error means…",
        ),
        { isPartial: false, expanded: false },
        theme,
        {},
      ),
    );
    assert.ok(line.includes("wai explain · kimi-coding:k3-256k"), line);
    assert.ok(line.includes("in ·"), line);
    assert.ok(line.includes("  The error means…"), line);
  });

  it("renders learn results as recorded or verified with a count", () => {
    const recorded = textOf(
      renderAuxResult(
        "learn",
        auxResult({ learned: [] }, "Recorded fact."),
        { isPartial: false, expanded: false },
        theme,
        {},
      ),
    );
    assert.ok(recorded.includes("wai learn ✓ recorded"), recorded);
    const verified = textOf(
      renderAuxResult(
        "learn",
        auxResult({ verify: [{ fact: "a" }, { fact: "b" }] }, "report"),
        { isPartial: false, expanded: false },
        theme,
        {},
      ),
    );
    assert.ok(verified.includes("wai learn verify ✓ · 2 fact(s)"), verified);
  });

  it("truncates long previews with a tail marker", () => {
    const many = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    const line = textOf(
      renderAuxResult("index", auxResult({ topic: "all" }, many), { isPartial: false, expanded: false }, theme, {}),
    );
    assert.ok(line.includes("  line 7"), line);
    assert.ok(!line.includes("line 8"), line);
    assert.ok(line.includes("… and 4 more line(s)"), line);
  });

  it("renders the in-progress line under the registered tool name", () => {
    const line = textOf(
      renderAuxResult(
        "learn",
        auxResult({ action: "explain", inProgress: true, progressMessage: "Verifying fact 1/3…", stage: 1, total: 3 }),
        { isPartial: false, expanded: false },
        theme,
        {},
      ),
    );
    assert.equal(line, "wai learn [1/3] Verifying fact 1/3…");
  });

  it("renders errors in the error color", () => {
    const line = textOf(
      renderAuxResult(
        "explain",
        auxResult({ error: "No model configured." }),
        { isPartial: false, expanded: false },
        theme,
        {},
      ),
    );
    assert.equal(line, "wai explain error: No model configured.");
  });
});
