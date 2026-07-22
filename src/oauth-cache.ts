import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OAuthCacheEntry {
  provider: string;
  credentialHash: string;
  apiKey: string;
  expiresAt?: number;
  createdAt: number;
}

const DEFAULT_TTL_MS = 55 * 60 * 1000; // 55 minutes
const CACHE_FILE = "oauth-cache.json";

function getCachePath(cwd: string): string {
  const dir = join(cwd, ".pi", "yoowai");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, CACHE_FILE);
}

function loadCache(cwd: string): OAuthCacheEntry[] {
  const path = getCachePath(cwd);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as OAuthCacheEntry[];
    return [];
  } catch {
    return [];
  }
}

function saveCache(cwd: string, entries: OAuthCacheEntry[]): void {
  const path = getCachePath(cwd);
  writeFileSync(path, JSON.stringify(entries, null, 2), { mode: 0o600 });
}

function prune(entries: OAuthCacheEntry[]): OAuthCacheEntry[] {
  const now = Date.now();
  return entries.filter((e) => (e.expiresAt ?? now + DEFAULT_TTL_MS) > now);
}

function hashCredential(credential: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(credential, Object.keys(credential).sort()))
    .digest("hex");
}

export function getCachedOAuthApiKey(
  cwd: string,
  provider: string,
  credential: Record<string, unknown>,
): string | undefined {
  const entries = prune(loadCache(cwd));
  const credentialHash = hashCredential(credential);
  const match = entries.find((e) => e.provider === provider && e.credentialHash === credentialHash);
  if (match && entries.length !== loadCache(cwd).length) {
    saveCache(cwd, entries);
  }
  return match?.apiKey;
}

export function setCachedOAuthApiKey(
  cwd: string,
  provider: string,
  credential: Record<string, unknown>,
  apiKey: string,
  expiresAt?: number,
): void {
  const entries = prune(loadCache(cwd));
  const credentialHash = hashCredential(credential);
  const idx = entries.findIndex((e) => e.provider === provider && e.credentialHash === credentialHash);
  const entry: OAuthCacheEntry = {
    provider,
    credentialHash,
    apiKey,
    expiresAt: expiresAt ?? Date.now() + DEFAULT_TTL_MS,
    createdAt: Date.now(),
  };
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  saveCache(cwd, entries);
}

export function clearOAuthCache(cwd: string): void {
  const path = getCachePath(cwd);
  if (existsSync(path)) {
    writeFileSync(path, JSON.stringify([], null, 2), { mode: 0o600 });
  }
}
