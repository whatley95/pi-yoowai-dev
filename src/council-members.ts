import type { SecondaryModelConfig } from "./types.js";

/** A raw judgeCouncil entry as stored in settings.json: either a
 *  "provider/model-id" string or a partial secondary config object. */
export type CouncilMemberEntry = string | Partial<SecondaryModelConfig>;

/** Stable identity for a council member, used for dedup. Strings split on the
 *  first "/" (bare strings are treated as model ids, mirroring config.ts);
 *  objects key on provider/id. Returns undefined for malformed entries. */
export function councilMemberKey(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    return trimmed ? trimmed.toLowerCase() : undefined;
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const o = entry as Record<string, unknown>;
    if (typeof o.provider === "string" && typeof o.id === "string" && o.provider && o.id) {
      return `${o.provider}/${o.id}`.toLowerCase();
    }
  }
  return undefined;
}

/** Display form for a council member entry: "provider:id". */
export function formatCouncilMember(entry: unknown): string {
  if (typeof entry === "string") return entry.trim() || "(invalid entry)";
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const o = entry as Record<string, unknown>;
    const provider = typeof o.provider === "string" ? o.provider : "";
    const id = typeof o.id === "string" ? o.id : "";
    if (provider && id) return `${provider}:${id}`;
  }
  return "(invalid entry)";
}

/** Append a member unless an entry with the same key already exists.
 *  Returns the new list and whether the entry was added. */
export function addCouncilMember(list: unknown[], entry: CouncilMemberEntry): { list: unknown[]; added: boolean } {
  const key = councilMemberKey(entry);
  if (!key) return { list, added: false };
  const duplicate = list.some((existing) => {
    const existingKey = councilMemberKey(existing);
    // A bare-id string ("gpt-5-mini") and a keyed entry ("openai/gpt-5-mini")
    // are different keys; only exact key matches count as duplicates.
    return existingKey !== undefined && existingKey === key;
  });
  if (duplicate) return { list, added: false };
  return { list: [...list, entry], added: true };
}
