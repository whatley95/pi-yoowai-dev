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
