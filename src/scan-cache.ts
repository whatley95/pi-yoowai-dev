import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConventions } from "./conventions.js";
import { readCachedJson, invalidateJsonReadCache } from "./json-read-cache.js";
import { getProjectConfigPath } from "./pi-paths.js";
import { logEvent } from "./logger.js";
import type { Conventions } from "./types.js";

const TTL_MS = 24 * 60 * 60 * 1000;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

export function scanFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function cachePath(cwd: string): string {
  return getProjectConfigPath(cwd, "yoowai", "scan-cache.json");
}

export function getCachedScan(cwd: string, key: string): Conventions | null {
  try {
    const entry = readCachedJson(cachePath(cwd)) as Record<string, unknown>;
    const created = typeof entry.createdAt === "string" ? Date.parse(entry.createdAt) : NaN;
    const age = Date.now() - created;
    if (entry.key !== key || !Number.isFinite(age) || age < 0 || age >= TTL_MS) return null;
    const conventions = loadConventions(cwd);
    // Clearing or manually editing conventions must not silently restore an
    // old generated result. The saved output is part of the cache contract.
    return conventions && scanFingerprint(conventions) === entry.conventionsHash ? conventions : null;
  } catch {
    return null;
  }
}

export function saveScanCache(cwd: string, key: string, conventions: Conventions, preserveAge = false): void {
  try {
    const saved = loadConventions(cwd);
    if (!saved || scanFingerprint(saved) !== scanFingerprint(conventions)) return;
    const path = cachePath(cwd);
    let createdAt = new Date().toISOString();
    if (preserveAge) {
      const previous = readCachedJson(path) as Record<string, unknown>;
      if (previous.key !== key || typeof previous.createdAt !== "string") return;
      createdAt = previous.createdAt;
    }
    mkdirSync(dirname(path), { recursive: true });
    invalidateJsonReadCache(path);
    writeFileSync(path, JSON.stringify({ key, createdAt, conventionsHash: scanFingerprint(saved) }), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (error) {
    logEvent(cwd, "warn", "Failed to save scan cache", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
