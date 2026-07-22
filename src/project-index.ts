import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type * as TS from "typescript";
import { filterSourceFiles, listTrackedFiles } from "./conventions.js";
import { logEvent } from "./logger.js";
import { getProjectConfigPath } from "./pi-paths.js";
import type { Conventions } from "./types.js";

/**
 * TypeScript compiler API, loaded lazily on first use. A missing or broken
 * typescript install then degrades project indexing with a logged warning
 * instead of failing extension startup at import time (which would take down
 * every wai command). Mirrors the lazy duck-duck-scrape import in
 * doc-fetcher.ts.
 */
let tsModule: typeof import("typescript") | null = null;
try {
  tsModule = await import("typescript");
} catch {
  tsModule = null;
}

let warnedTsMissing = false;
function getTs(cwd: string): typeof import("typescript") | null {
  if (!tsModule && !warnedTsMissing) {
    warnedTsMissing = true;
    logEvent(cwd, "warn", "typescript not installed; project indexing disabled", {
      hint: "run `npm install` in the extension directory to enable symbol indexing",
    });
  }
  return tsModule;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  line: number;
  exported: boolean;
  signature?: string;
}

export interface FileIndex {
  file: string;
  symbols: SymbolInfo[];
  mtime?: number;
}

export interface ProjectIndex {
  generatedAt: string;
  files: FileIndex[];
  stats?: {
    scanned: number;
    indexed: number;
    skipped: number;
    symbols: number;
    reused?: number;
  };
}

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const MAX_FILE_BYTES = 500 * 1024;

function getIndexPath(cwd: string): string {
  return getProjectConfigPath(cwd, "yoowai", "index.json");
}

export function loadProjectIndex(cwd: string): ProjectIndex | null {
  const path = getIndexPath(cwd);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidProjectIndex(parsed)) {
      logEvent(cwd, "warn", "Invalid project index shape; ignoring", { path });
      return null;
    }
    return parsed;
  } catch (err) {
    logEvent(cwd, "warn", "Failed to load project index", {
      error: err instanceof Error ? err.message : String(err),
      path,
    });
    return null;
  }
}

function isValidProjectIndex(value: unknown): value is ProjectIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.generatedAt !== "string") return false;
  if (!Array.isArray(v.files)) return false;
  for (const f of v.files) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return false;
    const file = f as Record<string, unknown>;
    if (typeof file.file !== "string") return false;
    if (!Array.isArray(file.symbols)) return false;
    if (file.mtime !== undefined && typeof file.mtime !== "number") return false;
  }
  if (v.stats && typeof v.stats === "object" && !Array.isArray(v.stats)) {
    const s = v.stats as Record<string, unknown>;
    if (typeof s.scanned !== "number") return false;
    if (typeof s.indexed !== "number") return false;
    if (typeof s.skipped !== "number") return false;
    if (typeof s.symbols !== "number") return false;
    if (s.reused !== undefined && typeof s.reused !== "number") return false;
  }
  return true;
}

export function saveProjectIndex(cwd: string, index: ProjectIndex): void {
  try {
    const path = getIndexPath(cwd);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(index, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    logEvent(cwd, "error", "Failed to save project index", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function buildProjectIndex(cwd: string): ProjectIndex {
  const tracked = listTrackedFiles(cwd);
  const files = filterSourceFiles(tracked).filter((f) => SUPPORTED_EXTENSIONS.has(getExtension(f)));
  const existing = loadProjectIndex(cwd);
  const existingByFile = new Map(existing?.files.map((f) => [f.file, f]) ?? []);

  const index: ProjectIndex = {
    generatedAt: new Date().toISOString(),
    files: [],
    stats: { scanned: files.length, indexed: 0, skipped: 0, symbols: 0, reused: 0 },
  };

  for (const rel of files) {
    const filePath = `${cwd}/${rel}`;
    const cached = existingByFile.get(rel);
    const fileIndex = buildFileIndex(cwd, filePath, rel, cached);
    if (fileIndex) {
      if (fileIndex.symbols.length > 0) {
        index.files.push(fileIndex);
        index.stats!.indexed += 1;
        index.stats!.symbols += fileIndex.symbols.length;
      }
      if (fileIndex.mtime && cached && fileIndex.mtime === cached.mtime) {
        index.stats!.reused = (index.stats!.reused ?? 0) + 1;
      }
    } else {
      index.stats!.skipped += 1;
    }
  }

  return index;
}

function getExtension(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".d.ts")) return ".ts";
  const dot = lower.lastIndexOf(".");
  return dot > 0 ? lower.slice(dot) : "";
}

function buildFileIndex(cwd: string, filePath: string, relPath: string, cached?: FileIndex): FileIndex | undefined {
  try {
    const stats = statSync(filePath);
    const mtime = stats.mtimeMs;
    if (cached && cached.mtime === mtime && cached.symbols.length > 0) {
      return { file: relPath, symbols: cached.symbols, mtime };
    }
    const content = readFileSync(filePath, "utf-8");
    if (content.length > MAX_FILE_BYTES) {
      return { file: relPath, symbols: [], mtime };
    }
    const ts = getTs(cwd);
    if (!ts) return undefined;
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, getScriptKind(ts, relPath));
    return { file: relPath, symbols: extractSymbols(ts, sourceFile), mtime };
  } catch (err) {
    logEvent(cwd, "warn", "Failed to index file", {
      file: relPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function getScriptKind(ts: typeof import("typescript"), fileName: string): TS.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function isExported(ts: typeof import("typescript"), node: TS.Node): boolean {
  const modifiers = (node as TS.HasModifiers).modifiers;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function extractSymbols(ts: typeof import("typescript"), sourceFile: TS.SourceFile): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  function addSymbol(name: string, kind: string, node: TS.Node, includeSignature = false): void {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const exported = isExported(ts, node);
    const signature = includeSignature ? extractSignature(sourceFile, node) : undefined;
    const symbol: SymbolInfo = { name, kind, line, exported };
    if (signature) {
      symbol.signature = signature;
    }
    symbols.push(symbol);
  }

  function visit(node: TS.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      addSymbol(node.name.text, "function", node, true);
      return;
    }
    if (ts.isClassDeclaration(node) && node.name) {
      addSymbol(node.name.text, "class", node);
      return;
    }
    if (ts.isInterfaceDeclaration(node)) {
      addSymbol(node.name.text, "interface", node);
      return;
    }
    if (ts.isTypeAliasDeclaration(node)) {
      addSymbol(node.name.text, "type", node);
      return;
    }
    if (ts.isEnumDeclaration(node)) {
      addSymbol(node.name.text, "enum", node);
      return;
    }
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      addSymbol(node.name.text, "namespace", node);
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const kind = node.declarationList.flags & ts.NodeFlags.Const ? "const" : "variable";
          addSymbol(declaration.name.text, kind, node);
        }
      }
      return;
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        const name = element.name.text;
        addSymbol(name, "export", element);
      }
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return symbols;
}

function extractSignature(sourceFile: TS.SourceFile, node: TS.Node): string | undefined {
  try {
    const text = node.getText(sourceFile);
    const firstLine = text.split(/\r?\n/)[0] ?? text;
    const trimmed = firstLine.trim();
    return trimmed.length > 0 && trimmed.length < 300 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export interface RelevantFile {
  file: string;
  score: number;
}

export function findRelevantFiles(cwd: string, query: string, maxFiles = 5): RelevantFile[] {
  const index = loadProjectIndex(cwd);
  if (!index || index.files.length === 0) return [];

  const words = query
    .toLowerCase()
    .split(/[^a-zA-Z0-9_]+/)
    .filter((w) => w.length > 1);
  if (words.length === 0) return [];

  const scores = new Map<string, number>();
  for (const file of index.files) {
    let score = 0;
    const lowerFile = file.file.toLowerCase();
    for (const word of words) {
      if (lowerFile.includes(word)) score += 1;
      for (const symbol of file.symbols) {
        if (symbol.name.toLowerCase().includes(word)) score += 2;
        if (symbol.signature?.toLowerCase().includes(word)) score += 1;
      }
    }
    if (score > 0) {
      scores.set(file.file, (scores.get(file.file) ?? 0) + score);
    }
  }

  return Array.from(scores.entries())
    .map(([file, score]) => ({ file, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);
}

export function formatIndexSummary(index: ProjectIndex, query?: string): string {
  const lines: string[] = [];
  const q = query?.toLowerCase();
  let totalSymbols = 0;
  for (const file of index.files) {
    const matches = q
      ? file.symbols.filter(
          (s) =>
            s.name.toLowerCase().includes(q) || s.kind.toLowerCase().includes(q) || file.file.toLowerCase().includes(q),
        )
      : file.symbols;
    if (matches.length === 0) continue;
    totalSymbols += matches.length;
    lines.push(`\n${file.file}:`);
    for (const s of matches.slice(0, 20)) {
      const exported = s.exported ? " (exported)" : "";
      const sig = s.signature ? ` — \`${s.signature}\`` : "";
      lines.push(`  - ${s.kind} ${s.name} at ${s.line}${exported}${sig}`);
    }
    if (matches.length > 20) {
      lines.push(`  ... and ${matches.length - 20} more symbols`);
    }
  }
  const stats = index.stats;
  const statsLine = stats
    ? `Scanned ${stats.scanned} file(s), indexed ${stats.indexed} file(s) with ${stats.symbols} symbol(s)` +
      (stats.skipped > 0 ? `, skipped ${stats.skipped} file(s)` : "") +
      (stats.reused && stats.reused > 0 ? `, reused ${stats.reused} file(s)` : "") +
      "."
    : `Indexed ${totalSymbols} symbol(s) across ${index.files.length} file(s).`;
  if (lines.length === 0) {
    return q ? `${statsLine}\n\nNo symbols match "${query}".` : `${statsLine}\n\nNo symbols indexed.`;
  }
  return `${statsLine}\n` + lines.join("\n");
}

export function inferPublicApi(index: ProjectIndex, maxEntries = 50): string[] {
  const exported: string[] = [];
  for (const file of index.files) {
    for (const s of file.symbols) {
      if (!s.exported) continue;
      const sig = s.signature ? ` — ${s.signature}` : "";
      exported.push(`${file.file}:${s.line} ${s.kind} ${s.name}${sig}`);
    }
  }
  return exported.slice(0, maxEntries);
}

export function inferCommonPatterns(index: ProjectIndex, maxPatterns = 10): string[] {
  const counts = new Map<string, number>();
  let totalFunctions = 0;
  let asyncFunctions = 0;
  let genericFunctions = 0;
  let optionalParamFunctions = 0;
  let exportedCount = 0;
  let internalCount = 0;

  for (const file of index.files) {
    for (const s of file.symbols) {
      if (s.exported) {
        exportedCount++;
      } else {
        internalCount++;
      }
      counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
      if (s.kind === "function" || s.kind === "export") {
        totalFunctions++;
        if (s.signature) {
          if (s.signature.startsWith("async ")) asyncFunctions++;
          if (s.signature.includes("<")) genericFunctions++;
          if (s.signature.includes("?")) optionalParamFunctions++;
        }
      }
    }
  }

  const patterns: string[] = [];
  const sortedKinds = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const topKinds = sortedKinds.slice(0, 3).map(([kind, count]) => `${count} ${kind}(s)`);
  if (topKinds.length > 0) patterns.push(`Symbol mix: ${topKinds.join(", ")}`);

  if (totalFunctions > 0) {
    if (asyncFunctions / totalFunctions >= 0.3) patterns.push("heavy use of async functions");
    if (genericFunctions / totalFunctions >= 0.2) patterns.push("frequent generic type parameters");
    if (optionalParamFunctions / totalFunctions >= 0.3) patterns.push("frequent optional parameters");
  }

  const totalSymbols = exportedCount + internalCount;
  if (totalSymbols > 0 && exportedCount / totalSymbols >= 0.4) {
    patterns.push("many exported/public symbols");
  }

  return patterns.slice(0, maxPatterns);
}

export function enrichConventionsFromIndex(conventions: Conventions, index: ProjectIndex | null): Conventions {
  if (!index || index.files.length === 0) return conventions;
  return {
    ...conventions,
    publicApi: inferPublicApi(index),
    commonPatterns: inferCommonPatterns(index),
  };
}
