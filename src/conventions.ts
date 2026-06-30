import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
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
    testing: typeof r.testing === "string" ? r.testing : undefined,
    orm: typeof r.orm === "string" ? r.orm : undefined,
    ui: typeof r.ui === "string" ? r.ui : undefined,
    styling: typeof r.styling === "string" ? r.styling : undefined,
    buildTool: typeof r.buildTool === "string" ? r.buildTool : undefined,
    ci: typeof r.ci === "string" ? r.ci : undefined,
    packageManager: typeof r.packageManager === "string" ? r.packageManager : undefined,
    entryPoints: Array.isArray(r.entryPoints) ? r.entryPoints.map(String) : [],
    scripts: Array.isArray(r.scripts) ? r.scripts.map(String) : [],
    styleSample: typeof r.styleSample === "string" ? r.styleSample : undefined,
    agENTSmd: typeof r.agENTSmd === "string" ? r.agENTSmd : undefined,
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
  const files = listTrackedFiles(cwd);

  if (files.length === 0) {
    return {
      conventions: emptyConventions(),
      files: [],
    };
  }

  const packageJson = readPackageJson(cwd);
  const agENTSmd = readTextFile(join(cwd, "AGENTS.md"));

  const conventions: Conventions = {
    naming: inferNaming(files),
    structure: inferStructure(files),
    patterns: inferPatterns(files, cwd),
    stack: inferStack(files, cwd, packageJson),
    testing: inferTesting(files, packageJson),
    orm: inferOrm(files, packageJson),
    ui: inferUi(files, packageJson),
    styling: inferStyling(files, packageJson),
    buildTool: inferBuildTool(files, packageJson),
    ci: inferCi(files),
    packageManager: inferPackageManager(cwd),
    entryPoints: inferEntryPoints(files, packageJson),
    scripts: inferScripts(packageJson),
    styleSample: inferStyleSample(files, cwd),
    agENTSmd: agENTSmd ? agENTSmd.slice(0, 2000) : undefined,
    generatedAt: new Date().toISOString(),
  };

  return { conventions, files };
}

const FALLBACK_SCAN_LIMIT = 500;
const EXCLUDED_SCAN_DIRS = new Set(["node_modules", ".pi", ".git", "dist", "build", "out", "coverage"]);

function listTrackedFiles(cwd: string): string[] {
  try {
    return execSync("git ls-files", { cwd, encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 10000 })
      .split(/\r?\n/)
      .filter((f) => f.length > 0 && !f.includes("node_modules/") && !f.includes(".pi/"));
  } catch { /* not a git repo */ }

  // fallback: portable recursive directory scan (works on Windows without Unix shell tools)
  try {
    return scanDirectory(cwd, cwd, FALLBACK_SCAN_LIMIT);
  } catch { /* ignore */ }

  return [];
}

function scanDirectory(root: string, dir: string, limit: number): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= limit) break;
    if (entry.isDirectory()) {
      if (!EXCLUDED_SCAN_DIRS.has(entry.name)) {
        files.push(...scanDirectory(root, join(dir, entry.name), limit - files.length));
      }
      continue;
    }
    if (entry.isFile()) {
      const rel = relative(root, join(dir, entry.name)).split("\\").join("/");
      files.push(rel);
    }
  }
  return files;
}

function readPackageJson(cwd: string): Record<string, unknown> | null {
  return readJsonFile(join(cwd, "package.json"));
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readTextFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function hasDependency(pkg: Record<string, unknown> | null, name: string): boolean {
  if (!pkg) return false;
  const deps = pkg.dependencies as Record<string, unknown> | undefined;
  const devDeps = pkg.devDependencies as Record<string, unknown> | undefined;
  return Boolean(deps?.[name] ?? devDeps?.[name]);
}

const EXCLUDED_FILE_PATTERNS = [
  /\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|otf|eot|mp3|mp4|wav|avi|mov|pdf|zip|tar|gz|rar|7z|exe|dll|so|dylib|bin|map|log)$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|Pipfile\.lock|npm-shrinkwrap\.json)$/i,
];

const CONFIG_FILE_CANDIDATES = [
  "AGENTS.md",
  "README.md",
  "tsconfig.json",
  "jsconfig.json",
  "eslint.config.js",
  "eslint.config.mjs",
  ".eslintrc.json",
  "prettier.config.js",
  ".prettierrc",
  ".prettierrc.json",
  "vite.config.ts",
  "vite.config.js",
  "webpack.config.js",
  "rollup.config.js",
  "tsup.config.ts",
  "next.config.js",
  "next.config.ts",
  "tailwind.config.js",
  "tailwind.config.ts",
  "jest.config.js",
  "jest.config.ts",
  "vitest.config.ts",
  "vitest.config.js",
  "playwright.config.ts",
  "prisma/schema.prisma",
];

const CONFIG_FILE_MAX_CHARS = 1500;

export function filterSourceFiles(files: string[]): string[] {
  return files.filter((f) => !EXCLUDED_FILE_PATTERNS.some((p) => p.test(f)));
}

export function formatConfigFiles(cwd: string): string {
  const parts: string[] = [];
  for (const file of CONFIG_FILE_CANDIDATES) {
    const content = readTextFile(join(cwd, file));
    if (!content) continue;
    const truncated = content.length > CONFIG_FILE_MAX_CHARS
      ? `${content.slice(0, CONFIG_FILE_MAX_CHARS)}\n...`
      : content;
    parts.push(`### ${file}\n${truncated}`);
  }
  if (parts.length === 0) return "";
  return "\n\n<config_files>\n" + parts.join("\n\n") + "\n</config_files>";
}

function emptyConventions(): Conventions {
  return {
    naming: "unknown",
    structure: "unknown",
    patterns: [],
    stack: "unknown",
    entryPoints: [],
    scripts: [],
    generatedAt: new Date().toISOString(),
  };
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
  const parts: string[] = [];
  if (files.some((f) => f.startsWith("src/"))) parts.push("src/");
  if (files.some((f) => f.startsWith("app/"))) parts.push("app/");
  if (files.some((f) => f.startsWith("lib/"))) parts.push("lib/");
  if (files.some((f) => f.startsWith("packages/"))) parts.push("packages/");
  if (files.some((f) => /\/(test|tests|spec|__tests__)\//.test(f) || /\.(test|spec)\./.test(f))) parts.push("tests/");
  if (files.some((f) => f.startsWith("public/"))) parts.push("public/");
  if (files.some((f) => f.startsWith("docs/"))) parts.push("docs/");
  return parts.length > 0 ? parts.join(", ") : "flat";
}

function inferPatterns(files: string[], cwd: string): string[] {
  const patterns: string[] = [];
  if (files.some((f) => f.endsWith("index.ts") || f.endsWith("index.js"))) patterns.push("barrel index files present");
  if (files.some((f) => /\.(test|spec)\./.test(f))) patterns.push("uses *.test|spec.* files");
  if (files.some((f) => f.endsWith(".d.ts"))) patterns.push("uses TypeScript declaration files");
  if (existsSync(join(cwd, "AGENTS.md"))) patterns.push("has AGENTS.md");
  if (files.some((f) => f.includes(".github/"))) patterns.push("uses GitHub Actions/Workflows");
  if (files.some((f) => f === "docker-compose.yml" || f === "Dockerfile")) patterns.push("uses Docker");
  if (files.some((f) => f === ".env.example" || f === ".env.local.example")) patterns.push("has env example files");
  return patterns;
}

function inferStack(files: string[], cwd: string, pkg: Record<string, unknown> | null): string {
  if (!pkg) return "unknown";
  const checks: Record<string, boolean> = {
    TypeScript: files.some((f) => /\.(ts|tsx)$/.test(f)),
    React: files.some((f) => /\.(tsx|jsx)$/.test(f)) || hasDependency(pkg, "react"),
    "Next.js": hasDependency(pkg, "next"),
    Vue: hasDependency(pkg, "vue"),
    Svelte: hasDependency(pkg, "svelte"),
    Node: existsSync(join(cwd, "package.json")),
    Python: files.some((f) => f.endsWith(".py")),
    Go: files.some((f) => f.endsWith(".go")),
    Rust: files.some((f) => f.endsWith(".rs")),
    Java: files.some((f) => f.endsWith(".java")),
  };
  const detected = Object.entries(checks).filter(([, v]) => v).map(([k]) => k);
  return detected.length > 0 ? detected.join(", ") : "unknown";
}

function inferTesting(files: string[], pkg: Record<string, unknown> | null): string | undefined {
  if (hasDependency(pkg, "jest")) return "jest";
  if (hasDependency(pkg, "vitest")) return "vitest";
  if (hasDependency(pkg, "mocha")) return "mocha";
  if (hasDependency(pkg, "playwright")) return "playwright";
  if (hasDependency(pkg, "cypress")) return "cypress";
  if (files.some((f) => /\.(test|spec)\./.test(f))) return "unknown test files";
  return undefined;
}

function inferOrm(files: string[], pkg: Record<string, unknown> | null): string | undefined {
  if (hasDependency(pkg, "prisma")) return "prisma";
  if (hasDependency(pkg, "drizzle-orm")) return "drizzle";
  if (hasDependency(pkg, "typeorm")) return "typeorm";
  if (hasDependency(pkg, "sequelize")) return "sequelize";
  if (hasDependency(pkg, "mongoose")) return "mongoose";
  if (hasDependency(pkg, "sqlalchemy")) return "sqlalchemy";
  if (hasDependency(pkg, "django")) return "django orm";
  if (files.some((f) => f.includes("prisma/schema"))) return "prisma";
  return undefined;
}

function inferUi(files: string[], pkg: Record<string, unknown> | null): string | undefined {
  if (hasDependency(pkg, "react")) return "react";
  if (hasDependency(pkg, "vue")) return "vue";
  if (hasDependency(pkg, "svelte")) return "svelte";
  if (hasDependency(pkg, "angular")) return "angular";
  if (hasDependency(pkg, "solid-js")) return "solid";
  return undefined;
}

function inferStyling(files: string[], pkg: Record<string, unknown> | null): string | undefined {
  if (hasDependency(pkg, "tailwindcss")) return "tailwindcss";
  if (hasDependency(pkg, "styled-components")) return "styled-components";
  if (hasDependency(pkg, "@emotion/react")) return "emotion";
  if (files.some((f) => f.endsWith(".module.css") || f.endsWith(".module.scss"))) return "css modules";
  if (files.some((f) => f.endsWith(".scss") || f.endsWith(".sass"))) return "scss/sass";
  if (files.some((f) => f.endsWith(".less"))) return "less";
  if (files.some((f) => f.endsWith(".css"))) return "plain css";
  return undefined;
}

function inferBuildTool(files: string[], pkg: Record<string, unknown> | null): string | undefined {
  if (hasDependency(pkg, "vite")) return "vite";
  if (hasDependency(pkg, "webpack")) return "webpack";
  if (hasDependency(pkg, "rollup")) return "rollup";
  if (hasDependency(pkg, "esbuild")) return "esbuild";
  if (hasDependency(pkg, "tsup")) return "tsup";
  if (hasDependency(pkg, "turborepo") || hasDependency(pkg, "@turbo/gen")) return "turborepo";
  if (hasDependency(pkg, "nx")) return "nx";
  if (files.some((f) => f === "vite.config.ts" || f === "vite.config.js")) return "vite";
  if (files.some((f) => f === "webpack.config.js")) return "webpack";
  if (files.some((f) => f === "rollup.config.js")) return "rollup";
  if (files.some((f) => f === "tsup.config.ts")) return "tsup";
  return undefined;
}

function inferCi(files: string[]): string | undefined {
  if (files.some((f) => f.startsWith(".github/workflows/"))) return "github-actions";
  if (files.some((f) => f === ".gitlab-ci.yml")) return "gitlab-ci";
  if (files.some((f) => f.startsWith(".circleci/"))) return "circleci";
  if (files.some((f) => f === "azure-pipelines.yml")) return "azure-pipelines";
  if (files.some((f) => f === "Jenkinsfile")) return "jenkins";
  return undefined;
}

function inferPackageManager(cwd: string): string | undefined {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "package-lock.json"))) return "npm";
  if (existsSync(join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(join(cwd, "Cargo.lock"))) return "cargo";
  if (existsSync(join(cwd, "poetry.lock"))) return "poetry";
  if (existsSync(join(cwd, "Pipfile.lock"))) return "pipenv";
  return undefined;
}

function inferEntryPoints(files: string[], pkg: Record<string, unknown> | null): string[] {
  const entryPoints: string[] = [];
  if (pkg) {
    if (typeof pkg.main === "string") entryPoints.push(pkg.main as string);
    if (typeof pkg.module === "string") entryPoints.push(pkg.module as string);
    if (typeof (pkg.exports as Record<string, unknown>)?.["."] === "string") {
      entryPoints.push((pkg.exports as Record<string, unknown>)["."] as string);
    }
  }

  const common = ["src/index.ts", "src/index.js", "src/main.ts", "src/main.js", "src/app.ts", "src/app.tsx", "app/index.ts", "app/page.tsx", "main.py", "cmd/main.go", "src/lib.rs"];
  for (const f of common) {
    if (files.includes(f)) entryPoints.push(f);
  }

  return [...new Set(entryPoints)];
}

function inferScripts(pkg: Record<string, unknown> | null): string[] {
  if (!pkg) return [];
  const scripts = pkg.scripts as Record<string, unknown> | undefined;
  if (!scripts) return [];
  return Object.entries(scripts).map(([k, v]) => `${k}: ${String(v)}`);
}

function inferStyleSample(files: string[], cwd: string): string | undefined {
  const candidates = files.filter((f) => /\.(ts|js|tsx|jsx|py|go|rs)$/.test(f) && !/\.(test|spec|d)\./.test(f));
  if (candidates.length === 0) return undefined;

  // pick a medium-sized representative file
  const sample = candidates
    .map((f) => ({ file: f, size: statSize(join(cwd, f)) }))
    .filter((x) => x.size > 0 && x.size < 20_000)
    .sort((a, b) => a.size - b.size)[Math.floor(candidates.length / 2)];

  if (!sample) return undefined;
  try {
    const content = readFileSync(join(cwd, sample.file), "utf-8");
    const lines = content.split(/\r?\n/);
    return lines.slice(0, 40).join("\n");
  } catch {
    return undefined;
  }
}

function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function clearConventions(cwd: string): void {
  const path = getConventionsPath(cwd);
  try {
    if (existsSync(path)) {
      writeFileSync(path, JSON.stringify(emptyConventions()), { encoding: "utf-8", mode: 0o600 });
    }
  } catch { /* ignore */ }
}

export function mergeConventions(local: Conventions, override: Conventions): Conventions {
  const merged = { ...local } as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0 && merged[key]) {
      // Keep locally-inferred arrays if the LLM returned an empty list.
      continue;
    }
    merged[key] = value;
  }
  return merged as unknown as Conventions;
}

export function formatConventions(conventions: Conventions): string {
  const parts = [
    `Project conventions:`,
    `- Naming: ${conventions.naming}`,
    `- Structure: ${conventions.structure}`,
    `- Stack: ${conventions.stack}`,
  ];
  if (conventions.testing) parts.push(`- Testing: ${conventions.testing}`);
  if (conventions.orm) parts.push(`- ORM: ${conventions.orm}`);
  if (conventions.ui) parts.push(`- UI: ${conventions.ui}`);
  if (conventions.styling) parts.push(`- Styling: ${conventions.styling}`);
  if (conventions.buildTool) parts.push(`- Build tool: ${conventions.buildTool}`);
  if (conventions.ci) parts.push(`- CI: ${conventions.ci}`);
  if (conventions.packageManager) parts.push(`- Package manager: ${conventions.packageManager}`);
  if (conventions.entryPoints.length > 0) parts.push(`- Entry points: ${conventions.entryPoints.join(", ")}`);
  if (conventions.scripts.length > 0) parts.push(`- Scripts: ${conventions.scripts.slice(0, 5).join("; ")}`);
  parts.push(`- Patterns: ${conventions.patterns.length > 0 ? conventions.patterns.join("; ") : "none recorded"}`);
  if (conventions.styleSample) parts.push(`\nCode style sample:\n\`\`\`\n${conventions.styleSample}\n\`\`\``);
  if (conventions.agENTSmd) parts.push(`\nAGENTS.md:\n${conventions.agENTSmd}`);
  return parts.join("\n");
}
