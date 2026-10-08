import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_ENTRIES = 128;
const entries = new Map<string, { source: string; value: unknown }>();

/** Cache parsing, not freshness decisions. Callers receive independent copies;
 * Compare current contents: Windows can preserve every stat field across
 * same-size writes. Missing/replaced files must never return stale data. */
export function readCachedJson(path: string): unknown {
  const key = resolve(path);
  try {
    const source = readFileSync(key, "utf-8");
    const cached = entries.get(key);
    if (cached?.source === source) {
      entries.delete(key);
      entries.set(key, cached);
      return structuredClone(cached.value);
    }
    const value: unknown = JSON.parse(source);
    entries.delete(key);
    entries.set(key, { source, value });
    if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    return structuredClone(value);
  } catch (error) {
    entries.delete(key);
    throw error;
  }
}

export function invalidateJsonReadCache(path: string): void {
  entries.delete(resolve(path));
}
