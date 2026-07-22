import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchResults, SearchResult } from "duck-duck-scrape";
import {
  loadDocContext,
  setSearchFnForTests,
  resetSearchFnForTests,
  setBraveSearchFnForTests,
  resetBraveSearchFnForTests,
} from "./doc-fetcher.js";
import type { DocsConfig } from "./types.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeConfig(override: Partial<DocsConfig> = {}): DocsConfig {
  return {
    sources: { react: "https://react.dev/reference/react", pi: "https://pi.dev/docs/latest" },
    maxCharsPerSource: 100,
    webSearch: { enabled: true, maxResults: 2, maxCharsPerResult: 200 },
    ...override,
  };
}

describe("doc-fetcher", () => {
  const originalFetch = global.fetch;
  let tmpDirs: string[] = [];

  before(() => {
    global.fetch = originalFetch;
  });

  after(() => {
    global.fetch = originalFetch;
    resetSearchFnForTests();
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetSearchFnForTests();
    resetBraveSearchFnForTests();
  });

  it("returns empty string when no docs or search are requested", async () => {
    const cwd = makeTempDir("doc-fetcher-none-");
    tmpDirs.push(cwd);
    const result = await loadDocContext(cwd, makeConfig(), {});
    assert.equal(result, "");
  });

  it("fetches and extracts text from a configured source", async () => {
    const cwd = makeTempDir("doc-fetcher-source-");
    tmpDirs.push(cwd);

    global.fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Map([["content-length", "200"]]),
        text: async () =>
          "<html><head><style>.x{}</style></head><body><nav>skip</nav><h1>Hello</h1><script>alert(1)</script><p>World &amp; beyond.</p></body></html>",
      }) as unknown as Response;

    const result = await loadDocContext(cwd, makeConfig({ maxCharsPerSource: 1000 }), { docs: ["react"] });
    assert.match(result, /<external_docs>/);
    assert.match(result, /<doc_source name="react">/);
    assert.match(result, /Hello World & beyond/);
    assert.doesNotMatch(result, /<script>/);
    assert.doesNotMatch(result, /<style>/);
    assert.doesNotMatch(result, /<nav>/);
  });

  it("ignores unknown source names", async () => {
    const cwd = makeTempDir("doc-fetcher-unknown-");
    tmpDirs.push(cwd);

    global.fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => "<p>docs</p>",
      }) as unknown as Response;

    const result = await loadDocContext(cwd, makeConfig(), { docs: ["unknown"] });
    assert.equal(result, "");
  });

  it("truncates source content to maxCharsPerSource", async () => {
    const cwd = makeTempDir("doc-fetcher-truncate-");
    tmpDirs.push(cwd);

    global.fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => `<p>${"a".repeat(500)}</p>`,
      }) as unknown as Response;

    const result = await loadDocContext(cwd, makeConfig({ maxCharsPerSource: 50 }), { docs: ["react"] });
    const match = result.match(/<doc_source name="react">\n(.*?)\n<\/doc_source>/s);
    assert.ok(match);
    assert.equal(match[1].length, 50);
  });

  it("rejects responses over the raw size limit", async () => {
    const cwd = makeTempDir("doc-fetcher-oversize-");
    tmpDirs.push(cwd);

    global.fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Map([["content-length", String(600 * 1024)]]),
        text: async () => "ignored",
      }) as unknown as Response;

    const result = await loadDocContext(cwd, makeConfig(), { docs: ["react"] });
    assert.equal(result, "");
  });

  it("caches source fetches and reuses them within TTL", async () => {
    const cwd = makeTempDir("doc-fetcher-cache-");
    tmpDirs.push(cwd);

    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => `<p>cached content ${fetchCount}</p>`,
      } as unknown as Response;
    };

    const config = makeConfig({ maxCharsPerSource: 1000 });
    const first = await loadDocContext(cwd, config, { docs: ["react"] });
    const second = await loadDocContext(cwd, config, { docs: ["react"] });
    assert.equal(fetchCount, 1);
    assert.equal(first, second);
    assert.match(second, /cached content 1/);

    const cachePath = join(cwd, ".pi", "yoowai", "docs", "react.txt");
    assert.ok(statSync(cachePath).isFile());
  });

  it("writes cache files with mode 0o600", async () => {
    const cwd = makeTempDir("doc-fetcher-mode-");
    tmpDirs.push(cwd);

    global.fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => "<p>docs</p>",
      }) as unknown as Response;

    await loadDocContext(cwd, makeConfig({ maxCharsPerSource: 1000 }), { docs: ["react"] });
    const cachePath = join(cwd, ".pi", "yoowai", "docs", "react.txt");
    const stats = statSync(cachePath);
    // Windows does not support Unix permissions, so mode checks are skipped there.
    if (process.platform !== "win32") {
      assert.equal(stats.mode & 0o777, 0o600);
    }
  });

  it("expires stale cache entries", async () => {
    const cwd = makeTempDir("doc-fetcher-expire-");
    tmpDirs.push(cwd);

    global.fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => "<p>fresh</p>",
      }) as unknown as Response;

    const config = makeConfig({ maxCharsPerSource: 1000 });
    await loadDocContext(cwd, config, { docs: ["react"] });

    const cachePath = join(cwd, ".pi", "yoowai", "docs", "react.txt");
    const stats = statSync(cachePath);
    // Set mtime to 25 hours ago so the cache is treated as stale.
    const staleTime = new Date(stats.mtimeMs - 25 * 60 * 60 * 1000);
    const { utimesSync } = await import("node:fs");
    utimesSync(cachePath, staleTime, staleTime);

    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => "<p>refetched</p>",
      } as unknown as Response;
    };

    const result = await loadDocContext(cwd, config, { docs: ["react"] });
    assert.match(result, /refetched/);
    assert.equal(fetchCount, 1);
  });

  it("formats web search results", async () => {
    const cwd = makeTempDir("doc-fetcher-search-");
    tmpDirs.push(cwd);

    const fakeResults: SearchResult[] = [
      {
        title: "Result A",
        url: "https://example.com/a",
        description: "About <b>A</b>",
        rawDescription: "About A",
        hostname: "example.com",
        icon: "",
      },
      {
        title: "Result B",
        url: "https://example.com/b",
        description: "About B",
        rawDescription: "About B",
        hostname: "example.com",
        icon: "",
      },
      {
        title: "Result C",
        url: "https://example.com/c",
        description: "About C",
        rawDescription: "About C",
        hostname: "example.com",
        icon: "",
      },
    ];
    setSearchFnForTests(
      async () => ({ results: fakeResults, noResults: false, vqd: "vqd" }) as unknown as SearchResults,
    );

    const result = await loadDocContext(
      cwd,
      makeConfig({ webSearch: { enabled: true, maxResults: 2, maxCharsPerResult: 100 } }),
      { search: "test query" },
    );
    assert.match(result, /<external_docs>/);
    assert.match(result, /<web_search query="test query">/);
    assert.match(result, /Result A/);
    assert.match(result, /Result B/);
    assert.doesNotMatch(result, /Result C/);
    assert.match(result, /https:\/\/example.com\/a/);
  });

  it("skips web search when disabled", async () => {
    const cwd = makeTempDir("doc-fetcher-search-off-");
    tmpDirs.push(cwd);

    let searched = false;
    setSearchFnForTests(async () => {
      searched = true;
      return { results: [], noResults: true, vqd: "" } as unknown as SearchResults;
    });

    const result = await loadDocContext(
      cwd,
      makeConfig({ webSearch: { enabled: false, maxResults: 2, maxCharsPerResult: 100 } }),
      { search: "test query" },
    );
    assert.equal(result, "");
    assert.equal(searched, false);
  });

  it("caches web search results", async () => {
    const cwd = makeTempDir("doc-fetcher-search-cache-");
    tmpDirs.push(cwd);

    let searchCount = 0;
    setSearchFnForTests(async () => {
      searchCount++;
      return {
        results: [
          {
            title: "Hit",
            url: "https://x",
            description: `desc ${searchCount}`,
            rawDescription: "",
            hostname: "x",
            icon: "",
          },
        ],
        noResults: false,
        vqd: "vqd",
      } as unknown as SearchResults;
    });

    const config = makeConfig({ webSearch: { enabled: true, maxResults: 1, maxCharsPerResult: 100 } });
    const first = await loadDocContext(cwd, config, { search: "same query" });
    const second = await loadDocContext(cwd, config, { search: "same query" });
    assert.equal(searchCount, 1);
    assert.equal(first, second);
    assert.match(second, /desc 1/);
  });

  it("combines docs and search blocks", async () => {
    const cwd = makeTempDir("doc-fetcher-combo-");
    tmpDirs.push(cwd);

    global.fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => "<p>react docs</p>",
      }) as unknown as Response;

    setSearchFnForTests(
      async () =>
        ({
          results: [
            {
              title: "Web",
              url: "https://web",
              description: "web result",
              rawDescription: "",
              hostname: "web",
              icon: "",
            },
          ],
          noResults: false,
          vqd: "vqd",
        }) as unknown as SearchResults,
    );

    const result = await loadDocContext(cwd, makeConfig(), { docs: ["react"], search: "react hooks" });
    assert.match(result, /<doc_source name="react">/);
    assert.match(result, /<web_search query="react hooks">/);
  });

  it("uses Brave search when provider is brave and API key is configured", async () => {
    const cwd = makeTempDir("doc-fetcher-brave-");
    tmpDirs.push(cwd);

    let braveCalled = false;
    setBraveSearchFnForTests(async (query, apiKey, maxResults) => {
      braveCalled = true;
      assert.equal(query, "brave query");
      assert.equal(apiKey, "brave-key");
      assert.equal(maxResults, 2);
      return [{ title: "Brave Result", url: "https://brave.example.com", description: "Brave <b>snippet</b>" }];
    });

    const result = await loadDocContext(
      cwd,
      makeConfig({
        webSearch: { enabled: true, maxResults: 2, maxCharsPerResult: 100, provider: "brave", apiKey: "brave-key" },
      }),
      { search: "brave query" },
    );

    assert.ok(braveCalled);
    assert.match(result, /Brave Result/);
    assert.match(result, /https:\/\/brave.example.com/);
    assert.match(result, /Brave snippet/);
    assert.doesNotMatch(result, /<b>/);
  });

  it("auto-detects Brave search when apiKey is set without explicit provider", async () => {
    const cwd = makeTempDir("doc-fetcher-brave-auto-");
    tmpDirs.push(cwd);

    let braveCalled = false;
    setBraveSearchFnForTests(async () => {
      braveCalled = true;
      return [{ title: "Auto Brave", url: "https://auto.example.com", description: "auto" }];
    });

    const result = await loadDocContext(
      cwd,
      makeConfig({ webSearch: { enabled: true, maxResults: 1, maxCharsPerResult: 100, apiKey: "brave-key" } }),
      { search: "auto brave" },
    );

    assert.ok(braveCalled);
    assert.match(result, /Auto Brave/);
  });

  it("falls back to DuckDuckGo when Brave is selected but no API key is available", async () => {
    const cwd = makeTempDir("doc-fetcher-brave-nokey-");
    tmpDirs.push(cwd);

    let duckCalled = false;
    setSearchFnForTests(async () => {
      duckCalled = true;
      return {
        results: [
          {
            title: "Duck Result",
            url: "https://duck.example.com",
            description: "duck",
            rawDescription: "duck",
            hostname: "duck",
            icon: "",
          },
        ],
        noResults: false,
        vqd: "vqd",
      } as unknown as SearchResults;
    });

    const result = await loadDocContext(
      cwd,
      makeConfig({ webSearch: { enabled: true, maxResults: 1, maxCharsPerResult: 100, provider: "brave" } }),
      { search: "no key" },
    );

    assert.ok(duckCalled);
    assert.match(result, /Duck Result/);
  });
});
