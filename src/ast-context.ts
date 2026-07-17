import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type * as TS from "typescript";
import { resolveProjectPath } from "./path-security.js";
import { estimateTokens } from "./token-budget.js";
import { logEvent } from "./logger.js";

const DEFAULT_MAX_TOKENS = 1000;
const MAX_DECLARATION_LINES = 30;

export interface AstContextOptions {
  maxTokens?: number;
}

/**
 * TypeScript compiler API, loaded lazily on first use. A missing or broken
 * typescript install then disables the AST context with a logged warning
 * instead of failing extension startup at import time. Mirrors the lazy
 * duck-duck-scrape import in doc-fetcher.ts.
 */
let tsModule: typeof import("typescript") | null = null;
try {
  tsModule = await import("typescript");
} catch {
  tsModule = null;
}

export function buildAstContext(cwd: string, changedFiles: string[], options: AstContextOptions = {}): string {
  const ts = tsModule;
  if (!ts) {
    logEvent(cwd, "warn", "typescript not installed; AST context disabled", {
      hint: "run `npm install` in the extension directory to enable import-aware context",
    });
    return "";
  }
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists);
  if (!configPath || !existsSync(configPath)) {
    return "";
  }

  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error) return "";

  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, resolve(cwd));
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
  const checker = program.getTypeChecker();

  const seen = new Set<string>();
  const snippets: string[] = [];
  let totalTokens = 0;

  for (const rel of changedFiles) {
    const absPath = resolveProjectPath(cwd, rel);
    if (!absPath) continue;
    const sourceFile = program.getSourceFile(absPath);
    if (!sourceFile) continue;

    visitSourceFile(ts, sourceFile, checker, seen, snippets, maxTokens, totalTokens);
    totalTokens = snippets.reduce((sum, s) => sum + estimateTokens(s), 0);
    if (totalTokens >= maxTokens) break;
  }

  if (snippets.length === 0) return "";
  return `Relevant API signatures from imports:\n\n${snippets.join("\n\n")}`;
}

function visitSourceFile(
  ts: typeof import("typescript"),
  sourceFile: TS.SourceFile,
  checker: TS.TypeChecker,
  seen: Set<string>,
  snippets: string[],
  maxTokens: number,
  initialTokens: number,
): void {
  let totalTokens = initialTokens;

  function visit(node: TS.Node): void {
    if (totalTokens >= maxTokens) return;

    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleSpecifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (!clause) return;

      const identifiers: TS.Identifier[] = [];
      if (clause.name) identifiers.push(clause.name);
      if (clause.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const e of clause.namedBindings.elements) identifiers.push(e.name);
        } else if (ts.isNamespaceImport(clause.namedBindings)) {
          identifiers.push(clause.name ?? clause.namedBindings.name);
        }
      }

      for (const id of identifiers) {
        const symbol = checker.getSymbolAtLocation(id);
        if (!symbol) continue;
        const resolved = checker.getAliasedSymbol?.(symbol) ?? symbol;
        const declarations = resolved.getDeclarations();
        if (!declarations || declarations.length === 0) continue;

        for (const decl of declarations) {
          const declFile = decl.getSourceFile();
          const key = `${declFile.fileName}:${decl.getStart()}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const text = getDeclarationText(decl, id.text, moduleSpecifier);
          if (!text) continue;
          const tokens = estimateTokens(text);
          if (totalTokens + tokens > maxTokens) return;
          snippets.push(text);
          totalTokens += tokens;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function getDeclarationText(node: TS.Node, importName: string, moduleSpecifier: string): string | undefined {
  const sourceFile = node.getSourceFile();
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  let text = sourceFile.text.slice(start, end);
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_DECLARATION_LINES) {
    text = lines.slice(0, MAX_DECLARATION_LINES).join("\n") + "\n...";
  }
  return `--- ${importName} from ${moduleSpecifier} ---\n${text.trim()}`;
}
