import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type * as TS from "typescript";
import { filterSourceFiles, listTrackedFiles } from "./conventions.js";
import { listGitUntrackedFiles } from "./diff-grabber.js";
import { captureImportFailure, type ImportFailureDetail } from "./import-diagnostics.js";
import { resolveProjectPath } from "./path-security.js";
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
/** Populated when the lazy typescript import fails; included in the first
 *  warning so the log shows why and where resolution pointed (the runtime
 *  copy Pi loads the extension from may lack node_modules/typescript). */
let tsLoadError: ImportFailureDetail | undefined;
try {
  tsModule = await import("typescript");
} catch (err) {
  tsModule = null;
  tsLoadError = captureImportFailure(err, "typescript");
}

let warnedTsMissing = false;
function getTs(cwd: string): typeof import("typescript") | null {
  if (!tsModule && !warnedTsMissing) {
    warnedTsMissing = true;
    logEvent(cwd, "warn", "typescript not installed; project indexing disabled", {
      hint: "run `npm install` in the extension directory to enable symbol indexing",
      ...(tsLoadError ?? {}),
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
  /** Literal relative/package import paths as written (deduped, sorted). */
  imports?: string[];
  /** Project files that import this file (reverse edge; resolved, deduped, sorted). */
  dependents?: string[];
  mtime?: number;
  /** Byte size at index time; compared alongside mtime so edits that land
   *  within the filesystem's mtime granularity but change size are caught. */
  size?: number;
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
    /** True when the build ran without the lazy `typescript` dependency.
     *  Distinguishes a genuinely empty index (all files skipped or
     *  symbol-less — keep it) from a broken one built without TS (rebuild). */
    tsUnavailable?: boolean;
  };
}

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const MAX_FILE_BYTES = 500 * 1024;

/** True when the file falls inside the index's scope — same predicate
 *  buildProjectIndex's collection uses (supported extension, not filtered
 *  out as binary/lockfile). Consumers like the codemap freshness check use
 *  this to decide whether a file absent from the index is a real gap. */
export function isIndexableFile(file: string): boolean {
  return SUPPORTED_EXTENSIONS.has(getExtension(file)) && filterSourceFiles([file]).length === 1;
}

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
    // A persisted index that scanned source files but indexed none was built
    // while the lazy `typescript` dependency was missing or broken (see
    // ast-context/project-index lazy-load warning). Only then is it invalid:
    // a legitimately empty index (all files skipped for size, or symbol-less)
    // must be kept, or it would be discarded and rebuilt on every load.
    if (parsed.stats && parsed.stats.scanned > 0 && parsed.stats.indexed === 0 && parsed.stats.tsUnavailable === true) {
      logEvent(cwd, "warn", "Project index scanned files but indexed none (built without TypeScript?); ignoring", {
        path,
        scanned: parsed.stats.scanned,
      });
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
    if (file.size !== undefined && typeof file.size !== "number") return false;
    // Optional edge fields must be arrays of strings when present, so a
    // malformed persisted index fails validation instead of throwing later.
    for (const key of ["imports", "dependents"]) {
      const field = file[key];
      if (field !== undefined && (!Array.isArray(field) || !field.every((s) => typeof s === "string"))) return false;
    }
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
  let files = tracked.filter(isIndexableFile);
  // Untracked files too: the review/diff world already includes them
  // (untracked diffs are on by default), so the symbol map must not silently
  // miss a newly created file's symbols until it is staged. Not gated on a
  // local .git entry: cwd may be a repo subdirectory or worktree, and
  // listGitUntrackedFiles throws outside git repos (swallowed below).
  try {
    const seen = new Set(files);
    const untracked = listGitUntrackedFiles(cwd).filter((f) => !seen.has(f));
    files = [...files, ...untracked.filter(isIndexableFile)];
  } catch (err) {
    // Not a git repo (or git unavailable) — the tracked/portable list applies.
    logEvent(cwd, "debug", "Untracked-file listing unavailable; tracked list only", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
      // All indexable files are persisted — including zero-symbol ones — so
      // the codemap freshness check can treat them as covered instead of
      // re-reporting them stale forever.
      index.files.push(fileIndex);
      if (fileIndex.symbols.length > 0) {
        index.stats!.indexed += 1;
        index.stats!.symbols += fileIndex.symbols.length;
      }
      if (fileIndex.mtime && cached && fileIndex.mtime === cached.mtime && fileIndex.size === cached.size) {
        index.stats!.reused = (index.stats!.reused ?? 0) + 1;
      }
    } else {
      index.stats!.skipped += 1;
    }
  }

  // Reverse dependency edges: for each file, resolve its literal imports to
  // PROJECT files (relative resolution with .ts/.tsx/.js/.jsx/index candidates
  // plus the .js → .ts import convention), then attach dependents (files that
  // import this one) to every target. Rebuilt across the CURRENT index on
  // every build (cheap — N×avg-imports path checks), so edge freshness does
  // not depend on cached entries.
  const byFile = new Map<string, FileIndex>();
  for (const f of index.files) byFile.set(f.file, f);
  // Start every current entry with NO dependents: a target whose sole
  // importer was edited or deleted must not retain a stale reverse edge.
  for (const f of index.files) delete f.dependents;
  const dependentsOf = new Map<string, string[]>();
  for (const f of index.files) {
    for (const imp of f.imports ?? []) {
      const target = resolveImportTarget(f.file, imp);
      if (!target) continue;
      for (const candidate of target) {
        // Segment-aware escape check: only truly escaping paths (".." or
        // "../…") are rejected, so e.g. "..internal.ts" stays valid.
        if (candidate === ".." || candidate.startsWith("../")) continue;
        if (!byFile.has(candidate)) continue;
        const list = dependentsOf.get(candidate) ?? [];
        if (!list.includes(f.file)) list.push(f.file);
        dependentsOf.set(candidate, list);
        break;
      }
    }
  }
  for (const [target, list] of dependentsOf) {
    const entry = byFile.get(target);
    if (entry) entry.dependents = list.sort();
  }

  // Record whether this build had TypeScript available, so loaders can tell a
  // broken empty index from a legitimately empty one.
  index.stats!.tsUnavailable = getTs(cwd) === null;

  return index;
}

/** Candidate project-relative paths for a literal import specifier, in
 *  resolution order: bare path, extensions, index files, and the .js → .ts
 *  convention used in NodeNext projects. The caller picks the first candidate
 *  present in the current index, so resolution is deterministic and project
 *  layout-agnostic (no src/ assumption). */
export function resolveImportTarget(fromFile: string, spec: string): string[] | undefined {
  // True relative form only: '.', '..', './…', '../…' — bare package
  // specifiers like '.foo' or '..pkg' must resolve against node_modules, not
  // the importing file.
  if (!(spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../"))) return undefined;
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const slash = spec.replace(/\\/g, "/");
  // Normalize './' and '../' segments so candidates match index keys exactly.
  const base = normalizeRel(dir ? `${dir}/${slash}` : slash);
  // Paths still escaping the project root cannot be indexed files.
  if (base === ".." || base.startsWith("../")) return undefined;
  const prefix = base ? `${base}/` : "";
  // Explicit-extension specifiers are kept EXACT (a './dep.ts' import must
  // not fall back to dep.js); .js/.jsx specifiers also offer the .ts/.tsx
  // convention (NodeNext). Extensionless specifiers expand as usual.
  if (/\.tsx?$/.test(base)) return [base];
  if (base.endsWith(".jsx")) {
    // NodeNext: '.jsx' probes the TSX source first, then the literal .jsx.
    return [base.replace(/\.jsx$/, ".tsx"), base];
  }
  if (base.endsWith(".js")) {
    // NodeNext for '.js': dep.ts, dep.tsx, dep.d.ts, then the literal dep.js.
    return [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), base.replace(/\.js$/, ".d.ts"), base];
  }
  // Any OTHER explicit extension (.mjs, .cjs, .json, ...) is exact-only:
  // './dep.mjs' must never fall back to dep.mjs.ts.
  if (/\.[a-z0-9]+$/i.test(base)) return [base];
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    `${base}.js`,
    `${base}.jsx`,
    `${prefix}index.ts`,
    `${prefix}index.tsx`,
    `${prefix}index.d.ts`,
    `${prefix}index.js`,
    `${prefix}index.jsx`,
  ];
}

export function normalizeRel(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      // Preserve unmatched leading .. segments: dropping them would create
      // false edges (e.g. '../../x' from src/a.ts must NOT resolve to 'x').
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push("..");
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
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
    const size = stats.size;
    if (cached && cached.mtime === mtime && cached.size === size && cached.imports) {
      return cached;
    }
    const content = readFileSync(filePath, "utf-8");
    if (content.length > MAX_FILE_BYTES) {
      return { file: relPath, symbols: [], imports: [], mtime, size };
    }
    const ts = getTs(cwd);
    if (!ts) return undefined;
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, getScriptKind(ts, relPath));
    return {
      file: relPath,
      symbols: extractSymbols(ts, sourceFile),
      imports: extractImports(ts, sourceFile),
      mtime,
      size,
    };
  } catch (err) {
    logEvent(cwd, "warn", "Failed to index file", {
      file: relPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Line of the first AST import/export/require/import-equals site in
 *  dependentFile whose specifier resolves to targetFile — using the SAME
 *  candidate selection as edge building (first candidate present in byFile),
 *  so the reported location always matches the constructed edge. AST-based:
 *  comments, template literals, and plain strings can never match. Returns 0
 *  when no site is found. */
export function findImportSite(
  cwd: string,
  dependentFile: string,
  targetFile: string,
  byFile: Map<string, FileIndex>,
): number {
  try {
    const ts = getTs(cwd);
    const safePath = resolveProjectPath(cwd, dependentFile);
    if (!ts || !safePath) return 0;
    const content = readFileSync(safePath, "utf-8");
    const sourceFile = ts.createSourceFile(
      safePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(ts, dependentFile),
    );
    let result = 0;
    const visit = (node: TS.Node): void => {
      if (result !== 0) return;
      let spec: string | undefined;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        spec = node.moduleSpecifier.text;
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        spec = node.moduleReference.expression.text;
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        spec = node.arguments[0].text;
      }
      if (spec) {
        const candidates = resolveImportTarget(dependentFile, spec);
        if (candidates) {
          for (const candidate of candidates) {
            if (candidate === ".." || candidate.startsWith("../")) break;
            if (!byFile.has(candidate)) continue;
            // First indexed candidate resolved — the same rule as edge building.
            if (candidate === targetFile) {
              result = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            }
            break;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return result;
  } catch {
    return 0;
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

/** Literal module specifiers from import/export declarations (deduped, sorted).
 *  Parsed from the same AST pass as symbols; reusable unchanged across index
 *  builds like symbols. */
function extractImports(ts: typeof import("typescript"), sourceFile: TS.SourceFile): string[] {
  const imports = new Set<string>();
  const visit = (node: TS.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.add(node.moduleSpecifier.text);
    }
    // import legacy = require("./legacy") — ImportEquals + ExternalModuleReference.
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      imports.add(node.moduleReference.expression.text);
    }
    // Static require("./x") calls in .js/.cjs files.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Array.from(imports).sort();
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
