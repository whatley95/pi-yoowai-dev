import { existsSync, readFileSync } from "node:fs";
import { resolveProjectPath } from "./path-security.js";
import { isReviewableFile } from "./file-loader.js";
import { estimateTokens } from "./token-budget.js";

const RELATIVE_IMPORT_RE = /(?:^|;)\s*(?:import|export)\s+(?:[^'"]*\s+from\s+)?['"](\.[^'"]+)['"];?/gim;
const MAX_RELATED_FILES = 5;
const MAX_TOKENS_TOTAL = 1000;
const MAX_LINES_PER_FILE = 50;

export interface RelatedContextResult {
  context: string;
  tokenEstimate: number;
  files: string[];
}

export function buildRelatedContext(cwd: string, changedFiles: string[]): RelatedContextResult {
  const relatedFiles = findRelatedFiles(cwd, changedFiles);
  const contexts: string[] = [];
  let totalTokens = 0;
  const included: string[] = [];

  for (const file of relatedFiles) {
    if (totalTokens >= MAX_TOKENS_TOTAL) break;
    const safePath = resolveProjectPath(cwd, file);
    if (!safePath) continue;
    try {
      const content = readFileSync(safePath, "utf-8");
      const outline = generateCompactOutline(content);
      if (outline.trim().length === 0) continue;
      const tokens = estimateTokens(outline);
      if (totalTokens + tokens > MAX_TOKENS_TOTAL) continue;
      contexts.push(`--- ${file} ---\n${outline}`);
      totalTokens += tokens;
      included.push(file);
    } catch {
      // ignore unreadable files
    }
  }

  if (contexts.length === 0) return { context: "", tokenEstimate: 0, files: [] };
  return {
    context: "Related files referenced by the changes:\n\n" + contexts.join("\n\n"),
    tokenEstimate: totalTokens,
    files: included,
  };
}

export function findRelatedFiles(cwd: string, changedFiles: string[]): string[] {
  const related = new Set<string>();
  for (const file of changedFiles) {
    const safePath = resolveProjectPath(cwd, file);
    if (!safePath) continue;
    try {
      const content = readFileSync(safePath, "utf-8");
      let match: RegExpExecArray | null;
      RELATIVE_IMPORT_RE.lastIndex = 0;
      while ((match = RELATIVE_IMPORT_RE.exec(content)) !== null) {
        const importPath = match[1];
        const resolved = resolveImportPath(cwd, file, importPath);
        if (resolved && !changedFiles.includes(resolved) && isReviewableFile(resolved)) {
          related.add(resolved);
        }
      }
    } catch {
      // ignore
    }
  }
  return Array.from(related).slice(0, MAX_RELATED_FILES);
}

function resolveImportPath(cwd: string, fromFile: string, importPath: string): string | undefined {
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const base = importPath.startsWith(".") ? normalizePosix(`${dir}/${importPath}`) : normalizePosix(importPath);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ];
  for (const candidate of candidates) {
    const normalized = normalizePosix(candidate);
    const absolute = resolveProjectPath(cwd, normalized);
    if (absolute && existsSync(absolute)) {
      return normalized;
    }
  }
  return undefined;
}

function normalizePosix(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/\.\//g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

function generateCompactOutline(content: string): string {
  const lines = content.split(/\r?\n/);
  const outline: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      /^(import|export)\b/.test(trimmed) ||
      /^(class|interface|type|function|async function)\b/.test(trimmed) ||
      /^(public|private|protected|static|#)?\s*(async\s+)?[a-zA-Z_$][\w$]*\s*\(/.test(trimmed) ||
      /^\/\*\*/.test(trimmed)
    ) {
      outline.push(line);
    }
    if (outline.length >= MAX_LINES_PER_FILE) break;
  }
  return outline.join("\n");
}

export interface FileOutlinesResult {
  /** Per-file outline blocks joined with blank lines (no semantic header — the caller supplies it). */
  context: string;
  tokenEstimate: number;
  /** Files whose outlines made it into the result (missing/unreadable/non-reviewable ones are skipped). */
  files: string[];
}

/** Build token-bounded compact outlines for an explicit list of files (the
 *  given files themselves, not their import neighbors). Used to give the
 *  reviewer context on files that were covered by earlier review rounds but
 *  are absent from the current incremental diff. Stops at maxTokens; files
 *  whose outline would exceed the remaining budget are skipped.
 *
 *  `perFileOverheadTokens` reserves additional tokens per INCLUDED file for
 *  caller-side per-file lines (e.g. verdict lines) so the assembled block
 *  stays complete: every included file has both its overhead line and its
 *  outline, and no entry is cut mid-way. A function receives the file path so
 *  the caller can measure the exact rendered line (e.g. a verdict line whose
 *  length varies with the path). */
export function buildFileOutlines(
  cwd: string,
  files: string[],
  maxTokens: number,
  perFileOverheadTokens: number | ((file: string) => number) = 0,
): FileOutlinesResult {
  const contexts: string[] = [];
  let totalTokens = 0;
  const included: string[] = [];

  for (const file of files) {
    if (totalTokens >= maxTokens) break;
    if (!isReviewableFile(file)) continue;
    const safePath = resolveProjectPath(cwd, file);
    if (!safePath) continue;
    try {
      const content = readFileSync(safePath, "utf-8");
      const outline = generateCompactOutline(content);
      if (outline.trim().length === 0) continue;
      // Count the complete rendered entry (header + outline) plus the
      // caller's per-file overhead (e.g. a verdict line) so the consumed
      // budget is cumulative and every included file's full entry fits.
      const entryText = `--- ${file} ---\n${outline}`;
      const overhead =
        typeof perFileOverheadTokens === "function" ? perFileOverheadTokens(file) : perFileOverheadTokens;
      const entryTokens = estimateTokens(entryText) + overhead;
      if (totalTokens + entryTokens > maxTokens) continue;
      contexts.push(entryText);
      totalTokens += entryTokens;
      included.push(file);
    } catch {
      // ignore unreadable files
    }
  }

  if (contexts.length === 0) return { context: "", tokenEstimate: 0, files: [] };
  return { context: contexts.join("\n\n"), tokenEstimate: totalTokens, files: included };
}
