import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Conventions, ScanResult } from "./types.js";

function getConventionsPath(cwd: string): string {
  return join(cwd, ".pi", "heyyoo", "conventions.json");
}

function isValidConventions(data: unknown): Conventions | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (typeof r.naming !== "string" || typeof r.structure !== "string" || typeof r.stack !== "string") return null;
  return {
    naming: r.naming,
    structure: r.structure,
    patterns: Array.isArray(r.patterns) ? r.patterns.map(String) : [],
    stack: r.stack,
    generatedAt: typeof r.generatedAt === "string" ? r.generatedAt : new Date().toISOString(),
  };
}

export function loadConventions(cwd: string): Conventions | null {
  const path = getConventionsPath(cwd);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return isValidConventions(data);
  } catch {
    return null;
  }
}

export function saveConventions(cwd: string, conventions: Conventions): void {
  const dir = join(cwd, ".pi", "heyyoo");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getConventionsPath(cwd), JSON.stringify(conventions, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function scanProjectConventions(cwd: string): ScanResult {
  let files: string[] = [];
  try {
    files = execSync("git ls-files", { cwd, encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 10000 })
      .split(/\r?\n/)
      .filter((f) => f.length > 0 && !f.includes("node_modules/") && !f.includes(".pi/"));
  } catch { /* not a git repo */ }

  if (files.length === 0) {
    return {
      conventions: emptyConventions(),
      files: [],
    };
  }

  const conventions: Conventions = {
    naming: inferNaming(files),
    structure: inferStructure(files),
    patterns: inferPatterns(files, cwd),
    stack: inferStack(files, cwd),
    generatedAt: new Date().toISOString(),
  };

  saveConventions(cwd, conventions);
  return { conventions, files };
}

function emptyConventions(): Conventions {
  return { naming: "unknown", structure: "unknown", patterns: [], stack: "unknown", generatedAt: new Date().toISOString() };
}

function inferNaming(files: string[]): string {
  const names = files.map((f) => f.split("/").pop() || "");
  const camel = names.some((n) => /^[a-z][a-zA-Z0-9]*\.(ts|js|tsx|jsx)$/.test(n));
  const pascal = names.some((n) => /^[A-Z][a-zA-Z0-9]*\.(ts|js|tsx|jsx)$/.test(n));
  const snake = names.some((n) => /^[a-z0-9_]+\.(ts|js|py|rs|go)$/.test(n));
  const kebab = names.some((n) => /^[a-z0-9-]+\.(ts|js)$/.test(n));
  const detected = [camel && "camelCase", pascal && "PascalCase", snake && "snake_case", kebab && "kebab-case"].filter(Boolean);
  return detected.length > 0 ? detected.join(", ") : "mixed";
}

function inferStructure(files: string[]): string {
  const hasSrc = files.some((f) => f.startsWith("src/"));
  const hasApp = files.some((f) => f.startsWith("app/"));
  const hasLib = files.some((f) => f.startsWith("lib/"));
  const hasTests = files.some((f) => /\/(test|tests|spec|__tests__)\//.test(f) || /\.(test|spec)\./.test(f));
  const parts = [];
  if (hasSrc) parts.push("src/");
  if (hasApp) parts.push("app/");
  if (hasLib) parts.push("lib/");
  if (hasTests) parts.push("tests/");
  return parts.length > 0 ? parts.join(", ") : "flat";
}

function inferPatterns(files: string[], cwd: string): string[] {
  const patterns: string[] = [];
  if (files.some((f) => f.endsWith("index.ts"))) patterns.push("barrel index.ts files present");
  if (files.some((f) => /\.test\./.test(f))) patterns.push("uses *.test.* test files");
  if (files.some((f) => /\.d\.ts$/.test(f))) patterns.push("uses TypeScript declaration files");
  if (existsSync(join(cwd, "AGENTS.md"))) patterns.push("has AGENTS.md");
  return patterns;
}

function inferStack(files: string[], cwd: string): string {
  const checks: Record<string, boolean> = {
    TypeScript: files.some((f) => /\.(ts|tsx)$/.test(f)),
    React: files.some((f) => /\.(tsx|jsx)$/.test(f)) || existsSync(join(cwd, "src/App.tsx")),
    Node: existsSync(join(cwd, "package.json")),
    Python: files.some((f) => f.endsWith(".py")),
    Go: files.some((f) => f.endsWith(".go")),
    Rust: files.some((f) => f.endsWith(".rs")),
  };
  const detected = Object.entries(checks).filter(([, v]) => v).map(([k]) => k);
  return detected.length > 0 ? detected.join(", ") : "unknown";
}

export function clearConventions(cwd: string): void {
  const path = getConventionsPath(cwd);
  try {
    if (existsSync(path)) {
      writeFileSync(path, JSON.stringify(emptyConventions()), { encoding: "utf-8", mode: 0o600 });
    }
  } catch { /* ignore */ }
}

export function formatConventions(conventions: Conventions): string {
  return `Project conventions:
- Naming: ${conventions.naming}
- Structure: ${conventions.structure}
- Stack: ${conventions.stack}
- Patterns: ${conventions.patterns.length > 0 ? conventions.patterns.join("; ") : "none recorded"}`;
}
