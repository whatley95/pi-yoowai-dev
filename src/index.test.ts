import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchResults } from "duck-duck-scrape";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateWaiToolParams } from "./wai-tool-params.js";
import { handleWaiSearchCommand } from "./wai-search.js";
import { setSearchFnForTests, resetSearchFnForTests } from "./doc-fetcher.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function mockCtx(cwd: string): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

function writeProjectSettings(cwd: string, settings: Record<string, unknown>): void {
  const dir = join(cwd, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ "pi-yoowai": settings }, null, 2) + "\n", "utf-8");
}

describe("validateWaiToolParams", () => {
  it("accepts a regular action with docs", () => {
    const result = validateWaiToolParams({ suggest: "useEffect vs useLayoutEffect", docs: ["react"] });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.action, "suggest");
      assert.deepEqual(result.params.docs, ["react"]);
      assert.equal("search" in result.params, false);
    }
  });

  it("ignores a search parameter if present", () => {
    const result = validateWaiToolParams({ suggest: "Next.js caching", search: "Next.js caching 2024" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.action, "suggest");
      assert.equal("search" in result.params, false);
    }
  });

  it("rejects a call with only a search parameter", () => {
    const result = validateWaiToolParams({ search: "something" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /No action specified/);
    }
  });

  it("passes scanDeep through only for the scan action", () => {
    const scan = validateWaiToolParams({ scan: true, scanDeep: true });
    assert.equal(scan.ok, true);
    if (scan.ok) {
      assert.equal(scan.action, "scan");
      assert.equal(scan.params.scanDeep, true);
    }

    const other = validateWaiToolParams({ suggest: "q", scanDeep: true });
    assert.equal(other.ok, true);
    if (other.ok) {
      assert.equal(other.params.scanDeep, undefined);
    }
  });
});

describe("handleWaiSearchCommand", () => {
  const tmpDirs: string[] = [];

  after(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  afterEach(() => {
    resetSearchFnForTests();
  });

  it("returns usage help when query is empty", async () => {
    const result = await handleWaiSearchCommand("  ", mockCtx(makeTempDir("wai-search-empty-")));
    assert.equal(result.content[0]?.text, "Usage: /wai-search <query>");
  });

  it("reports when web search is disabled", async () => {
    const cwd = makeTempDir("wai-search-disabled-");
    tmpDirs.push(cwd);
    const result = await handleWaiSearchCommand("react hooks", mockCtx(cwd));
    assert.match(
      result.content[0]?.text ?? "",
      /Web search is disabled\. Enable it with pi-yoowai\.docs\.webSearch\.enabled/,
    );
  });

  it("returns formatted web search results when enabled", async () => {
    const cwd = makeTempDir("wai-search-enabled-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      docs: {
        sources: {},
        webSearch: { enabled: true, maxResults: 2, maxCharsPerResult: 200 },
      },
    });

    setSearchFnForTests(
      async () =>
        ({
          noResults: false,
          results: [
            {
              title: "React Hooks",
              url: "https://react.dev/reference/react",
              description: "Official React hooks reference",
            },
          ],
        }) as unknown as SearchResults,
    );

    const result = await handleWaiSearchCommand("react hooks", mockCtx(cwd));
    const text = result.content[0]?.text ?? "";
    assert.match(text, /Web search results for "react hooks"/);
    assert.match(text, /<web_search query="react hooks">/);
    assert.match(text, /React Hooks/);
  });

  it("reports no results when search returns nothing", async () => {
    const cwd = makeTempDir("wai-search-noresults-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      docs: {
        sources: {},
        webSearch: { enabled: true, maxResults: 2, maxCharsPerResult: 200 },
      },
    });

    setSearchFnForTests(
      async () =>
        ({
          noResults: true,
          results: [],
        }) as unknown as SearchResults,
    );

    const result = await handleWaiSearchCommand("xyz123nomatch", mockCtx(cwd));
    assert.equal(result.content[0]?.text, 'No results for "xyz123nomatch".');
  });
});
