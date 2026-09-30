import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const MAX_ENTRIES = 128;
const entries = new Map<string, { stamp: string; value: unknown }>();

function fileStamp(path: string): string {
  const stats = statSync(path);
  return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${stats.ino}`;
}

/** Cache parsing, not freshness decisions. Callers receive independent copies;
 * missing/replaced files and same-size writes invalidate the stored value. */
export function readCachedJson(path: string): unknown {
  const key = resolve(path);
  try {
    const stamp = fileStamp(key);
    const cached = entries.get(key);
    if (cached?.stamp === stamp) {
      entries.delete(key);
      entries.set(key, cached);
      return structuredClone(cached.value);
    }
    const value: unknown = JSON.parse(readFileSync(key, "utf-8"));
    entries.delete(key);
    // A concurrent writer must not associate the new metadata with old bytes.
    if (fileStamp(key) === stamp) {
      entries.set(key, { stamp, value });
      if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    }
    return structuredClone(value);
  } catch (error) {
    entries.delete(key);
    throw error;
  }
}

export function invalidateJsonReadCache(path: string): void {
  entries.delete(resolve(path));
}
