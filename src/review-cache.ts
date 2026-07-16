import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JudgeResult, ReviewResult, SecurityResult, TestResult, UsageCost, StageProfile } from "./types.js";

export type CachedReview = { review: ReviewResult; model: StageProfile; cost?: UsageCost };
export type CachedTest = { test: TestResult; model: StageProfile; cost?: UsageCost };
export type CachedSecurity = { security: SecurityResult; model: StageProfile; cost?: UsageCost };
export type CachedJudge = { judge: JudgeResult; model: StageProfile; cost?: UsageCost };
export type CacheableResult = CachedReview | CachedTest | CachedSecurity | CachedJudge;

type CacheAction = "review" | "test" | "security" | "judge";

type CacheEntry = {
  key: string;
  action: CacheAction;
  result: CacheableResult;
  createdAt: number;
};

type CacheFile = {
  version: 1;
  entries: CacheEntry[];
};

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 100;

function getCachePath(cwd: string): string {
  const dir = join(cwd, ".pi", "heyyoo");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "review-cache.json");
}

function loadCache(cwd: string): CacheFile {
  const path = getCachePath(cwd);
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
    return parsed;
  } catch {
    return { version: 1, entries: [] };
  }
}

function saveCache(cwd: string, cache: CacheFile): void {
  const path = getCachePath(cwd);
  writeFileSync(path, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function prune(cache: CacheFile): void {
  const now = Date.now();
  cache.entries = cache.entries.filter((e) => now - e.createdAt < CACHE_TTL_MS);
  if (cache.entries.length > MAX_ENTRIES) {
    cache.entries.sort((a, b) => a.createdAt - b.createdAt);
    cache.entries = cache.entries.slice(-MAX_ENTRIES);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",") + "}";
}

export function buildCacheKey(action: string, payload: Record<string, unknown>): string {
  // Recursively sort keys so nested objects (modelProfile, options) serialize
  // deterministically. A plain array replacer would apply only at the top level
  // and serialize nested objects to {}, making the key ignore the model and
  // returning a stale cached verdict after /yoo-model switches models.
  const canonical = stableStringify(payload);
  return createHash("sha256").update(`${action}:${canonical}`).digest("hex").slice(0, 32);
}

export function getCachedReview(cwd: string, key: string): CachedReview | undefined {
  const cache = loadCache(cwd);
  prune(cache);
  const entry = cache.entries.find((e) => e.action === "review" && e.key === key);
  return entry ? (entry.result as CachedReview) : undefined;
}

export function getCachedTest(cwd: string, key: string): CachedTest | undefined {
  const cache = loadCache(cwd);
  prune(cache);
  const entry = cache.entries.find((e) => e.action === "test" && e.key === key);
  return entry ? (entry.result as CachedTest) : undefined;
}

export function getCachedSecurity(cwd: string, key: string): CachedSecurity | undefined {
  const cache = loadCache(cwd);
  prune(cache);
  const entry = cache.entries.find((e) => e.action === "security" && e.key === key);
  return entry ? (entry.result as CachedSecurity) : undefined;
}

export function getCachedJudge(cwd: string, key: string): CachedJudge | undefined {
  const cache = loadCache(cwd);
  prune(cache);
  const entry = cache.entries.find((e) => e.action === "judge" && e.key === key);
  return entry ? (entry.result as CachedJudge) : undefined;
}

export function setCachedResult(cwd: string, action: CacheAction, key: string, result: CacheableResult): void {
  const cache = loadCache(cwd);
  prune(cache);
  cache.entries = cache.entries.filter((e) => !(e.action === action && e.key === key));
  cache.entries.push({ key, action, result, createdAt: Date.now() });
  saveCache(cwd, cache);
}

export function clearReviewCache(cwd: string): void {
  const path = getCachePath(cwd);
  if (existsSync(path)) {
    writeFileSync(path, JSON.stringify({ version: 1, entries: [] }, null, 2), { mode: 0o600 });
  }
}
