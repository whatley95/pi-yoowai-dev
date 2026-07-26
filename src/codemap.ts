import { buildProjectIndex, loadProjectIndex, saveProjectIndex, type ProjectIndex } from "./project-index.js";
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
  if (maxTokens <= 0 || changedFiles.length === 0) return "";
  try {
    const index = getOrBuildIndex(cwd);
    if (index && index.files.length > 0) {
      const codemap = buildFromIndex(index, changedFiles, findRelatedFiles(cwd, changedFiles), maxTokens);
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

function getOrBuildIndex(cwd: string): ProjectIndex | null {
  const existing = loadProjectIndex(cwd);
  if (existing && existing.files.length > 0) return existing;
  const built = buildProjectIndex(cwd);
  if (built.files.length > 0) {
    saveProjectIndex(cwd, built);
    return built;
  }
  return null;
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
