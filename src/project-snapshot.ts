import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { listTrackedFiles, readPackageJson } from "./conventions.js";
import { loadFreshProjectIndex } from "./project-index.js";
import { GENERATED_DIRECTORIES, isGeneratedFile } from "./file-policy.js";
import { resolveProjectPath } from "./path-security.js";

const SNAPSHOT_MAX_FILES = 200;
const SNAPSHOT_MAX_DOC_CHARS = 2000;
const SNAPSHOT_MAX_INDEX_SYMBOLS = 50;

const EXCLUDED_SNAPSHOT_DIRS = new Set<string>([...GENERATED_DIRECTORIES, ".pi"]);

function isExcludedDir(name: string): boolean {
  return EXCLUDED_SNAPSHOT_DIRS.has(name) || name.startsWith(".");
}

function buildTreeLines(root: string, dir: string, prefix: string, limit: number, lines: string[]): number {
  if (lines.length >= limit) return lines.length;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const visible = entries
      .filter((e) => !e.name.startsWith(".") || e.name === ".github")
      .filter((e) => !(e.isDirectory() && isExcludedDir(e.name)))
      .filter((e) => !isGeneratedFile(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (let i = 0; i < visible.length && lines.length < limit; i++) {
      const entry = visible[i];
      const isLast = i === visible.length - 1;
      const connector = isLast ? "└── " : "├── ";
      lines.push(`${prefix}${connector}${entry.name}`);
      if (entry.isDirectory()) {
        const newPrefix = prefix + (isLast ? "    " : "│   ");
        buildTreeLines(root, join(dir, entry.name), newPrefix, limit, lines);
      }
    }
  } catch {
    // ignore unreadable directories
  }
  return lines.length;
}

function formatPackageJsonSummary(cwd: string): string {
  const pkg = readPackageJson(cwd);
  if (!pkg) return "No package.json found.";

  const lines: string[] = [];
  if (typeof pkg.name === "string") lines.push(`name: ${pkg.name}`);
  if (typeof pkg.version === "string") lines.push(`version: ${pkg.version}`);

  const deps = {
    dependencies: pkg.dependencies,
    devDependencies: pkg.devDependencies,
    peerDependencies: pkg.peerDependencies,
  };
  for (const [key, value] of Object.entries(deps)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const names = Object.keys(value);
      if (names.length > 0) {
        lines.push(
          `${key}: ${names.slice(0, 20).join(", ")}${names.length > 20 ? ` ... (+${names.length - 20})` : ""}`,
        );
      }
    }
  }

  if (pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)) {
    const scripts = Object.entries(pkg.scripts as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .slice(0, 10);
    if (scripts.length > 0) lines.push(`scripts: ${scripts.join("; ")}`);
  }

  return lines.length > 0 ? lines.join("\n") : "package.json present but minimal.";
}

function formatIndexSnapshot(cwd: string): string {
  const index = loadFreshProjectIndex(cwd);
  if (!index || index.files.length === 0) return "";

  const lines: string[] = [];
  let symbolCount = 0;
  for (const file of index.files) {
    if (symbolCount >= SNAPSHOT_MAX_INDEX_SYMBOLS) break;
    const exported = file.symbols.filter((s) => s.exported);
    if (exported.length === 0) continue;
    lines.push(`${file.file}:`);
    for (const symbol of exported) {
      if (symbolCount >= SNAPSHOT_MAX_INDEX_SYMBOLS) break;
      const sig = symbol.signature ? ` — \`${symbol.signature}\`` : "";
      lines.push(`  - ${symbol.kind} ${symbol.name} at ${symbol.line}${sig}`);
      symbolCount++;
    }
  }
  if (lines.length === 0) return "";
  return `Public symbols from project index:\n${lines.join("\n")}`;
}

function readDocExcerpt(cwd: string, name: string): string {
  const path = join(cwd, name);
  if (!existsSync(path)) return "";
  try {
    const content = readFileSync(path, "utf-8");
    return content.length > SNAPSHOT_MAX_DOC_CHARS ? `${content.slice(0, SNAPSHOT_MAX_DOC_CHARS)}\n...` : content;
  } catch {
    return "";
  }
}

function formatTrackedFileList(cwd: string): string {
  const files = listTrackedFiles(cwd);
  if (files.length === 0) return "(no tracked files found)";
  const limited = files.slice(0, SNAPSHOT_MAX_FILES);
  const suffix = files.length > SNAPSHOT_MAX_FILES ? `\n... and ${files.length - SNAPSHOT_MAX_FILES} more files` : "";
  return limited.join("\n") + suffix;
}

export interface ProjectSnapshot {
  tree: string;
  packageJson: string;
  publicSymbols: string;
  agentsMd: string;
  readmeMd: string;
  trackedFiles: string;
}

export function buildProjectSnapshot(cwd: string): ProjectSnapshot {
  const treeLines: string[] = ["."];
  buildTreeLines(cwd, cwd, "", SNAPSHOT_MAX_FILES, treeLines);

  return {
    tree: treeLines.join("\n"),
    packageJson: formatPackageJsonSummary(cwd),
    publicSymbols: formatIndexSnapshot(cwd),
    agentsMd: readDocExcerpt(cwd, "AGENTS.md"),
    readmeMd: readDocExcerpt(cwd, "README.md"),
    trackedFiles: formatTrackedFileList(cwd),
  };
}

export interface RelevantFileContent {
  file: string;
  content: string;
  mode: "full" | "outline";
}

const RELEVANT_MAX_TOTAL_CHARS = 8_000;
const RELEVANT_MAX_FILE_CHARS = 4_000;
const RELEVANT_OUTLINE_LINES = 60;

function generateOutline(content: string): string {
  const lines = content.split(/\r?\n/);
  const outline: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      /^(import|export|class|interface|type|function|const|let|var|async function|public|private|protected|static|#)/.test(
        trimmed,
      ) ||
      /^\/(\/|\*)/.test(trimmed)
    ) {
      outline.push(line);
    }
  }
  return outline.slice(0, RELEVANT_OUTLINE_LINES).join("\n");
}

export function loadRelevantFileContents(cwd: string, files: string[]): RelevantFileContent[] {
  const results: RelevantFileContent[] = [];
  let totalChars = 0;

  for (const file of files) {
    if (totalChars >= RELEVANT_MAX_TOTAL_CHARS) break;
    const safePath = resolveProjectPath(cwd, file);
    if (!safePath || !existsSync(safePath)) continue;
    try {
      const stats = statSync(safePath);
      if (!stats.isFile() || stats.size > 500 * 1024) continue;
      const content = readFileSync(safePath, "utf-8");
      const lineCount = content.split(/\r?\n/).length;
      const preferFull = lineCount <= 150;
      const displayContent = preferFull ? content : generateOutline(content);
      const truncated = displayContent.slice(0, RELEVANT_MAX_FILE_CHARS);
      const finalContent = truncated.length < displayContent.length ? `${truncated}\n...` : truncated;
      results.push({ file, content: finalContent, mode: preferFull ? "full" : "outline" });
      totalChars += finalContent.length;
    } catch {
      // ignore unreadable files
    }
  }

  return results;
}

export function formatProjectSnapshot(snapshot: ProjectSnapshot): string {
  const parts: string[] = [];

  parts.push("### Directory tree");
  parts.push(snapshot.tree);

  parts.push("\n### package.json summary");
  parts.push(snapshot.packageJson);

  if (snapshot.publicSymbols) {
    parts.push("\n### Public symbols");
    parts.push(snapshot.publicSymbols);
  }

  if (snapshot.agentsMd) {
    parts.push("\n### AGENTS.md excerpt");
    parts.push(snapshot.agentsMd);
  }

  if (snapshot.readmeMd) {
    parts.push("\n### README.md excerpt");
    parts.push(snapshot.readmeMd);
  }

  parts.push("\n### Tracked files");
  parts.push(snapshot.trackedFiles);

  return parts.join("\n");
}
