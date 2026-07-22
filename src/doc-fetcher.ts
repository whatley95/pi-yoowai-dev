import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as dds from "duck-duck-scrape";
import { resolveApiKey } from "./auth-reader.js";
import { getProjectConfigPath } from "./pi-paths.js";
import { logEvent } from "./logger.js";
import type { DocsConfig, WebSearchConfig, WebSearchProvider } from "./types.js";

export interface DocContextRequest {
  docs?: string[];
  search?: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RAW_BYTES = 500 * 1024; // 500 KB
const FILE_MODE = 0o600;

type SearchFn = typeof dds.search;

/**
 * Default DuckDuckGo search, imported lazily on first use. A broken or
 * outdated duck-duck-scrape install then degrades /wai-search with a logged
 * warning instead of breaking extension startup at import time.
 */
const defaultSearchFn: SearchFn = async (query, options) => {
  const dds = await import("duck-duck-scrape");
  return dds.search(query, options);
};

let searchFn: SearchFn = defaultSearchFn;

/** Replace the DuckDuckGo search function for tests. */
export function setSearchFnForTests(fn: SearchFn): void {
  searchFn = fn;
}

/** Restore the real DuckDuckGo search function. */
export function resetSearchFnForTests(): void {
  searchFn = defaultSearchFn;
}

type BraveSearchResult = {
  title: string;
  url: string;
  description?: string;
};

let braveSearchFn: ((query: string, apiKey: string, maxResults: number) => Promise<BraveSearchResult[]>) | null = null;

/** Replace the Brave search function for tests. */
export function setBraveSearchFnForTests(
  fn: (query: string, apiKey: string, maxResults: number) => Promise<BraveSearchResult[]>,
): void {
  braveSearchFn = fn;
}

/** Restore the real Brave search function. */
export function resetBraveSearchFnForTests(): void {
  braveSearchFn = null;
}

function resolveBraveApiKey(config?: { apiKey?: string }): string | undefined {
  return config?.apiKey ?? resolveApiKey("brave");
}

function detectWebSearchProvider(config: WebSearchConfig): WebSearchProvider {
  if (config.provider) return config.provider;
  return resolveBraveApiKey(config) ? "brave" : "duckduckgo";
}

function getDocsCacheDir(cwd: string): string {
  return getProjectConfigPath(cwd, "yoowai", "docs");
}

function ensureCacheDir(cwd: string): void {
  const dir = getDocsCacheDir(cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "source";
}

function hashQuery(query: string): string {
  return createHash("sha256").update(query).digest("hex").slice(0, 16);
}

function cacheHit(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const stats = statSync(path);
    if (Date.now() - stats.mtimeMs > CACHE_TTL_MS) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function writeCache(cwd: string, fileName: string, content: string): void {
  try {
    ensureCacheDir(cwd);
    writeFileSync(join(getDocsCacheDir(cwd), fileName), content, { encoding: "utf-8", mode: FILE_MODE });
  } catch (err) {
    logEvent(cwd, "warn", "Failed to write doc cache", {
      file: fileName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function stripHtml(raw: string): string {
  // Remove script, style, and nav blocks first.
  let text = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ");
  // Strip remaining tags.
  text = text.replace(/<[^>]+>/g, " ");
  // Decode a few common HTML entities.
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&hellip;/g, "…");
  // Collapse whitespace.
  return text.replace(/\s+/g, " ").trim();
}

async function fetchDocSource(
  cwd: string,
  name: string,
  url: string,
  maxChars: number,
): Promise<{ name: string; content: string } | null> {
  const cacheFile = `${safeFileName(name)}.txt`;
  const cached = cacheHit(join(getDocsCacheDir(cwd), cacheFile));
  if (cached !== null) {
    logEvent(cwd, "info", "Doc source cache hit", { name, url });
    return { name, content: cached.slice(0, maxChars) };
  }

  logEvent(cwd, "info", "Fetching doc source", { name, url });
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "omit",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": `pi-yoowai/${process.version}` },
    });
    if (!response.ok) {
      logEvent(cwd, "warn", "Doc source fetch failed", { name, url, status: response.status });
      return null;
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_RAW_BYTES) {
      logEvent(cwd, "warn", "Doc source response too large", { name, url, contentLength });
      return null;
    }
    const raw = await response.text();
    if (raw.length > MAX_RAW_BYTES) {
      logEvent(cwd, "warn", "Doc source response too large", { name, url, size: raw.length });
      return null;
    }
    const cleaned = stripHtml(raw);
    const truncated = cleaned.slice(0, maxChars);
    writeCache(cwd, cacheFile, cleaned);
    logEvent(cwd, "info", "Doc source fetched", { name, url, chars: truncated.length });
    return { name, content: truncated };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logEvent(cwd, "warn", "Doc source fetch error", { name, url, error });
    return null;
  }
}

async function searchBrave(query: string, apiKey: string, maxResults: number): Promise<BraveSearchResult[]> {
  const testFn = braveSearchFn;
  if (testFn) return testFn(query, apiKey, maxResults);

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(Math.max(maxResults, 1), 20)));
  url.searchParams.set("offset", "0");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Brave search failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const web = data.web as Record<string, unknown> | undefined;
  const results = Array.isArray(web?.results) ? (web.results as BraveSearchResult[]) : [];
  return results;
}

async function searchDuckDuckGo(
  cwd: string,
  query: string,
  maxResults: number,
  maxCharsPerResult: number,
): Promise<string | null> {
  logEvent(cwd, "info", "Performing DuckDuckGo web search", { query });
  // SafeSearchType.STRICT from duck-duck-scrape, inlined so the package stays lazy-loaded.
  const results = await searchFn(query, { safeSearch: 0 as dds.SafeSearchType });
  if (!results.results || results.results.length === 0) {
    logEvent(cwd, "info", "DuckDuckGo web search returned no results", { query });
    return null;
  }
  const parts: string[] = [];
  for (const result of results.results.slice(0, maxResults)) {
    const snippet = stripHtml(result.description || result.rawDescription || "").slice(0, maxCharsPerResult);
    parts.push(`Title: ${result.title}\nURL: ${result.url}\n${snippet}`);
  }
  return parts.join("\n\n");
}

async function searchWeb(cwd: string, query: string, config: WebSearchConfig): Promise<string | null> {
  const maxResults = config.maxResults;
  const maxCharsPerResult = config.maxCharsPerResult;
  const requestedProvider = detectWebSearchProvider(config);
  const braveApiKey = requestedProvider === "brave" ? resolveBraveApiKey(config) : undefined;
  const provider = requestedProvider === "brave" && !braveApiKey ? "duckduckgo" : requestedProvider;

  const cacheFile = `search-${provider}-${hashQuery(query)}.txt`;
  const cached = cacheHit(join(getDocsCacheDir(cwd), cacheFile));
  if (cached !== null) {
    logEvent(cwd, "info", "Web search cache hit", { query, provider });
    return cached;
  }

  logEvent(cwd, "info", "Performing web search", { query, provider });
  try {
    let formatted: string | null = null;
    if (provider === "brave") {
      const results = await searchBrave(query, braveApiKey!, maxResults);
      if (results.length === 0) {
        logEvent(cwd, "info", "Brave web search returned no results", { query });
        return null;
      }
      const parts: string[] = [];
      for (const result of results.slice(0, maxResults)) {
        const snippet = stripHtml(result.description ?? "").slice(0, maxCharsPerResult);
        parts.push(`Title: ${result.title}\nURL: ${result.url}\n${snippet}`);
      }
      formatted = parts.join("\n\n");
    } else {
      formatted = await searchDuckDuckGo(cwd, query, maxResults, maxCharsPerResult);
    }

    if (formatted) {
      writeCache(cwd, cacheFile, formatted);
      logEvent(cwd, "info", "Web search completed", { query, provider, results: formatted.split("\n\n").length });
    }
    return formatted;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logEvent(cwd, "warn", "Web search failed", { query, provider, error });
    return null;
  }
}

export async function loadDocContext(
  cwd: string,
  config: DocsConfig | undefined,
  request: DocContextRequest,
): Promise<string> {
  if (!config) return "";
  if ((!request.docs || request.docs.length === 0) && !request.search) return "";

  const blocks: string[] = [];

  if (request.docs && request.docs.length > 0) {
    const sourcePromises = request.docs.map(async (name) => {
      const url = config.sources[name];
      if (!url) {
        logEvent(cwd, "info", "Ignoring unknown doc source", { name });
        return null;
      }
      return fetchDocSource(cwd, name, url, config.maxCharsPerSource);
    });
    const sources = (await Promise.all(sourcePromises)).filter(
      (s): s is { name: string; content: string } => s !== null,
    );
    for (const source of sources) {
      blocks.push(`<doc_source name="${source.name}">\n${source.content}\n</doc_source>`);
    }
  }

  if (request.search && config.webSearch.enabled) {
    const searchResult = await searchWeb(cwd, request.search, config.webSearch);
    if (searchResult) {
      blocks.push(`<web_search query="${request.search}">\n${searchResult}\n</web_search>`);
    }
  }

  if (blocks.length === 0) return "";
  return `<external_docs>\n${blocks.join("\n\n")}\n</external_docs>`;
}
