import { statSync } from "node:fs";
import {
  buildProjectIndex,
  loadProjectIndex,
  saveProjectIndex,
  isIndexableFile,
  type ProjectIndex,
} from "./project-index.js";
import { buildRelatedContext, findRelatedFiles } from "./context-retrieval.js";
import { estimateTokens } from "./token-budget.js";
import { logEvent } from "./logger.js";
import { resolveProjectPath } from "./path-security.js";

const TRUNCATION_NOTE = "… (symbol map truncated)";

/** Build a compact "project symbol map" for review/judge prompts: one line per
 *  exported or top-level symbol in each changed file and its direct import
 *  neighbors (`file.ts:12 — function foo(a, b): void`). Uses the persisted
 *  TypeScript AST index (building it incrementally when missing) and falls
 *  back to regex-based related-file outlines when the index is unavailable or
 *  the project is not TypeScript. Never throws: any failure is logged and
 *  yields an empty string. `maxTokens <= 0` disables the codemap. */
export function buildCodemap(cwd: string, changedFiles: string[], maxTokens: number): string {
  if (maxTokens <= 0 || changedFiles.length === 0) return "";
  try {
    const neighborFiles = findRelatedFiles(cwd, changedFiles);
    const { index: loadedIndex, justBuilt } = getOrBuildIndex(cwd);
    let index = loadedIndex;
    if (
      index &&
      index.files.length > 0 &&
      !justBuilt &&
      !isIndexFresh(cwd, index, [...changedFiles, ...neighborFiles])
    ) {
      // The persisted index predates edits to files we are about to render
      // (the edit→review flow is the common case). Rebuild incrementally:
      // unchanged files are reused by mtime, so only edited files re-extract.
      const rebuilt = buildProjectIndex(cwd);
      if (rebuilt.files.length > 0) {
        saveProjectIndex(cwd, rebuilt);
        index = rebuilt;
      } else {
        // Nothing indexable remains (e.g. typescript currently unavailable or
        // all files deleted). Accepted tradeoff: the stale on-disk index is
        // retained, so a fully-deleted project re-attempts a rebuild per call
        // — cheap there (only statSync of the deleted files), and it keeps
        // new-file indexing working if files reappear.
        index = null;
      }
    }
    if (index && index.files.length > 0) {
      const codemap = buildFromIndex(index, changedFiles, neighborFiles, maxTokens);
      if (codemap) return codemap;
    }
    // Fallback: no usable index (non-TypeScript project, missing typescript,
    // empty index) — reuse the related-file outlines instead.
    const related = buildRelatedContext(cwd, changedFiles);
    if (!related.context) return "";
    return truncateLines(related.context, maxTokens);
  } catch (err) {
    logEvent(cwd, "warn", "Failed to build codemap; skipping", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

/** True when the persisted index's mtimes still match disk for every file
 *  that will be rendered. Three staleness cases: an indexed file whose disk
 *  mtime differs, an indexed file that no longer exists (deleted), and an
 *  indexable file that was never indexed (created after the last build).
 *  Files outside the index scope (non-indexable, e.g. .md docs) are skipped —
 *  they are rendered from disk by the fallback path and must not trigger
 *  rebuilds. Never throws: for indexed files, unreadable/unresolvable paths
 *  are treated as stale (a rebuild self-corrects); for never-indexed
 *  indexable files they are treated as covered (a rebuild cannot cover a
 *  file that cannot be read). */
function isIndexFresh(cwd: string, index: ProjectIndex, files: string[]): boolean {
  const byFile = new Map(index.files.map((f) => [f.file, f]));
  for (const file of new Set(files)) {
    const cached = byFile.get(file);
    const safePath = resolveProjectPath(cwd, file);
    if (cached) {
      if (!safePath) return false;
      try {
        const stats = statSync(safePath);
        // mtime + size: an edit preserving both (same content length written
        // within the filesystem's mtime granularity) remains undetectable —
        // the residual racy-clean limitation of mtime-based freshness.
        if (cached.mtime !== stats.mtimeMs || cached.size !== stats.size) return false;
      } catch {
        return false; // deleted since indexing
      }
    } else if (isIndexableFile(file)) {
      // Indexable but absent: either created after the last build (stale — a
      // rebuild will cover it: buildProjectIndex indexes tracked + untracked
      // files, and gitignored files never reach changedFiles because the
      // diff path uses the same --exclude-standard scope), zero-symbol (also
      // covered — buildProjectIndex persists every indexable file with an
      // empty symbols array, so it would have an entry), or deleted since
      // (the index correctly lacks it — a rebuild cannot help, so treat it
      // as covered, otherwise a deleted file lingering in the diff would
      // trigger a rebuild on every call).
      if (!safePath) continue;
      try {
        statSync(safePath);
        return false; // exists on disk but never indexed → stale
      } catch {
        continue; // deleted → covered by its absence
      }
    }
  }
  return true;
}

function getOrBuildIndex(cwd: string): { index: ProjectIndex | null; justBuilt: boolean } {
  const existing = loadProjectIndex(cwd);
  if (existing && existing.files.length > 0) return { index: existing, justBuilt: false };
  const built = buildProjectIndex(cwd);
  if (built.files.length > 0) {
    saveProjectIndex(cwd, built);
    return { index: built, justBuilt: true };
  }
  return { index: null, justBuilt: true };
}

function buildFromIndex(
  index: ProjectIndex,
  changedFiles: string[],
  neighborFiles: string[],
  maxTokens: number,
): string {
  const byFile = new Map(index.files.map((f) => [f.file, f]));
  // Changed files first (most relevant), then import neighbors.
  const ordered = [...changedFiles, ...neighborFiles.filter((f) => !changedFiles.includes(f))];

  const lines: string[] = [];
  let tokens = 0;
  let truncated = false;
  for (const file of ordered) {
    const fileIndex = byFile.get(file);
    if (!fileIndex) continue;
    for (const symbol of fileIndex.symbols) {
      const line = `${file}:${symbol.line} — ${symbol.signature ?? `${symbol.kind} ${symbol.name}`}`;
      const lineTokens = estimateTokens(line);
      if (tokens + lineTokens > maxTokens) {
        truncated = true;
        break;
      }
      lines.push(line);
      tokens += lineTokens;
    }
    if (truncated) break;
  }

  if (lines.length === 0) return "";
  return lines.join("\n") + (truncated ? `\n${TRUNCATION_NOTE}` : "");
}

/** Truncate text to a token budget on whole-line boundaries. */
function truncateLines(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let tokens = 0;
  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (tokens + lineTokens > maxTokens) break;
    kept.push(line);
    tokens += lineTokens;
  }
  return kept.length > 0 ? `${kept.join("\n")}\n${TRUNCATION_NOTE}` : "";
}
