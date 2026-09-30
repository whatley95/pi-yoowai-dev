import { loadFreshProjectIndex, findImportSite, normalizeRel, type ProjectIndex } from "./project-index.js";
import { isSafeRelativePath } from "./path-security.js";
import { buildRelatedContext, findRelatedFiles } from "./context-retrieval.js";
import { estimateTokens } from "./token-budget.js";
import { logEvent } from "./logger.js";

const TRUNCATION_NOTE = "… (symbol map truncated)";

/** Build a compact "project symbol map" for review/judge prompts: one line per
 *  exported or top-level symbol in each changed file and its direct import
 *  neighbors (`file.ts:12 — function foo(a, b): void`). Uses the persisted
 *  TypeScript AST index (building it incrementally when missing) and falls
 *  back to regex-based related-file outlines when the index is unavailable or
 *  the project is not TypeScript. Never throws: any failure is logged and
 *  yields an empty string. `maxTokens <= 0` disables the codemap. */
export function buildCodemap(cwd: string, changedFiles: string[], maxTokens: number): string {
  changedFiles = changedFiles.filter(isSafeRelativePath).map((file) => normalizeRel(file.replaceAll("\\", "/")));
  if (maxTokens <= 0 || changedFiles.length === 0) return "";
  try {
    const neighborFiles = findRelatedFiles(cwd, changedFiles);
    const index = loadFreshProjectIndex(cwd, true);
    if (index && index.files.length > 0) {
      const codemap = buildFromIndex(cwd, index, changedFiles, neighborFiles, maxTokens);
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

function buildFromIndex(
  cwd: string,
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
    // Blast radius: for CHANGED files, an up-to-3 entry "used by" line with
    // the actual import-site line numbers (bounded reads; deterministic
    // order). Neighbor files show their own symbols only.
    if (changedFiles.includes(file)) {
      // Blast radius: up to three dependents with their actual AST import-site
      // lines (findImportSite returns 0 when no site exists → omitted).
      const usedBy: string[] = [];
      for (const dep of (fileIndex.dependents ?? []).slice(0, 3)) {
        const lineNo = findImportSite(cwd, dep, file, byFile);
        // A missing site yields fewer than three entries (still bounded).
        if (lineNo > 0) usedBy.push(`${dep}:${lineNo}`);
      }
      if (usedBy.length > 0) {
        const line = `used by: ${usedBy.join(", ")}`;
        const lineTokens = estimateTokens(line);
        if (tokens + lineTokens > maxTokens) {
          truncated = true;
          break;
        }
        lines.push(line);
        tokens += lineTokens;
      }
    }
  }

  if (lines.length === 0) return "";
  const joined = lines.join("\n");
  const withNote = truncated ? `${joined}\n${TRUNCATION_NOTE}` : joined;
  // Final accounting against the COMPLETE rendered output (joining newlines
  // and the truncation note included): if it still exceeds the budget, drop
  // whole lines from the tail until it fits. The note is only appended when
  // at least one content line remains — a note-only codemap is treated as
  // empty. Never render beyond maxTokens.
  if (estimateTokens(withNote) <= maxTokens) return withNote;
  const trimmedLines = lines.slice();
  while (trimmedLines.length > 0) {
    trimmedLines.pop();
    if (trimmedLines.length === 0) return "";
    const candidate = `${trimmedLines.join("\n")}\n${TRUNCATION_NOTE}`;
    if (estimateTokens(candidate) <= maxTokens) return candidate;
  }
  return "";
}

/** Truncate text to a token budget on whole-line boundaries, accounting for
 *  the COMPLETE rendered candidate (joining newlines + truncation note);
 *  returns empty when no content line can carry the note. */
function truncateLines(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const candidate = kept.length > 0 ? `${kept.join("\n")}\n${line}` : line;
    // Budget the EXACT rendered value (candidate + joining newline + note).
    if (estimateTokens(`${candidate}\n${TRUNCATION_NOTE}`) > maxTokens) break;
    kept.push(line);
  }
  if (kept.length === 0) return "";
  return `${kept.join("\n")}\n${TRUNCATION_NOTE}`;
}
