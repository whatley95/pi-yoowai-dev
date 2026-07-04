import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logEvent } from "./logger.js";
import { isSafeRelativePath, validateRevision } from "./path-security.js";

const DEFAULT_MAX_DIFF_CHARS = 6000;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

export type VcsType = "git" | "svn";

export interface DiffResult {
  diff: string;
  truncated: boolean;
  changedFiles: string[];
  vcs?: VcsType;
}

export interface VcsInfo {
  type: VcsType | "unknown";
  branch?: string;
  revision?: string;
  dirty?: boolean;
  error?: string;
}

export function getVcsInfo(cwd: string): VcsInfo {
  const type = detectVcs(cwd);
  if (type === "git") return getGitInfo(cwd);
  if (type === "svn") return getSvnInfo(cwd);
  return { type: "unknown" };
}

function getGitInfo(cwd: string): VcsInfo {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
    return { type: "git", branch, revision, dirty: status.length > 0 };
  } catch (err) {
    return { type: "git", error: err instanceof Error ? err.message : String(err) };
  }
}

function getSvnInfo(cwd: string): VcsInfo {
  try {
    const output = execFileSync("svn", ["info"], {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const revision = output.match(/^Revision:\s*(.+)$/m)?.[1]?.trim();
    const url = output.match(/^URL:\s*(.+)$/m)?.[1]?.trim();
    return { type: "svn", revision, branch: url };
  } catch (err) {
    return { type: "svn", error: err instanceof Error ? err.message : String(err) };
  }
}

export function getDiff(
  cwd: string,
  options: {
    vcs?: VcsType;
    revision?: string;
    since?: string;
    files?: string[];
    exclude?: string[];
    untracked?: boolean;
    maxDiffChars?: number;
  } = {},
): DiffResult {
  const vcs = options.vcs ?? detectVcs(cwd);
  if (vcs === "svn") {
    return getSvnDiff(cwd, options);
  }
  return getGitDiff(cwd, options);
}

export function getGitDiff(
  cwd: string,
  options: {
    revision?: string;
    since?: string;
    files?: string[];
    exclude?: string[];
    untracked?: boolean;
    maxDiffChars?: number;
  } = {},
): DiffResult {
  const revision = validateRevision(options.revision);
  const since = validateRevision(options.since);
  let pathArgs: string[] | undefined;
  try {
    pathArgs = buildGitPathArgs(options.files, options.exclude);
  } catch (err) {
    logEvent(cwd, "warn", "Unsafe git diff paths", { error: err instanceof Error ? err.message : String(err) });
    return {
      diff: "(could not retrieve diff — unsafe file or exclude paths)",
      truncated: false,
      changedFiles: [],
      vcs: "git",
    };
  }
  const maxDiffChars = options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;

  if (revision || since) {
    try {
      const args = buildGitRevisionArgs(revision, since, pathArgs);
      const diff = runVcsDiff(cwd, ["git", ...args]);
      return processDiff(diff, "git", maxDiffChars);
    } catch (err) {
      logEvent(cwd, "debug", "Git diff attempt failed", {
        error: err instanceof Error ? err.message : String(err),
        args: buildGitRevisionArgs(revision, since, pathArgs),
      });
      return {
        diff: "(could not retrieve diff for the requested revision range)",
        truncated: false,
        changedFiles: [],
        vcs: "git",
      };
    }
  }

  let combinedDiff = "";
  try {
    const diff = pathArgs ? runVcsDiff(cwd, ["git", "diff", "--", ...pathArgs]) : runVcsDiff(cwd, ["git", "diff"]);
    if (diff.trim()) combinedDiff += diff;
  } catch (err) {
    logEvent(cwd, "debug", "Git working-tree diff failed", { error: err instanceof Error ? err.message : String(err) });
  }

  if (options.untracked) {
    try {
      const untrackedFiles = listGitUntrackedFiles(cwd, options.files, options.exclude);
      if (untrackedFiles.length > 0) {
        const untracked = runGitUntrackedDiff(cwd, untrackedFiles);
        if (untracked.trim()) {
          combinedDiff += (combinedDiff ? "\n" : "") + untracked;
        }
      }
    } catch (err) {
      logEvent(cwd, "debug", "Git untracked diff failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (combinedDiff.trim()) return processDiff(combinedDiff, "git", maxDiffChars);

  return {
    diff: "(no changes detected — review session context instead)",
    truncated: false,
    changedFiles: [],
    vcs: "git",
  };
}

export function getSvnDiff(
  cwd: string,
  options: {
    revision?: string;
    since?: string;
    files?: string[];
    exclude?: string[];
    maxDiffChars?: number;
  } = {},
): DiffResult {
  const revision = validateRevision(options.revision);
  const since = validateRevision(options.since);
  const pathArgs =
    options.files && options.files.length > 0 ? options.files.filter((f) => isSafeRelativePath(f)) : ["."];
  const maxDiffChars = options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;

  try {
    const args = buildSvnRevisionArgs(revision, since);
    const safeExcludes = options.exclude?.filter((e) => isSafeRelativePath(e)) ?? [];
    args.push(...pathArgs);
    const diff = runVcsDiff(cwd, ["svn", "diff", ...args]);
    if (diff.trim()) {
      const filtered = safeExcludes.length > 0 ? applyExclude(diff, safeExcludes) : diff;
      return processDiff(filtered, "svn", maxDiffChars);
    }
  } catch (err) {
    logEvent(cwd, "debug", "SVN diff attempt failed", { error: err instanceof Error ? err.message : String(err) });
  }

  return {
    diff: "(no SVN changes detected — review session context instead)",
    truncated: false,
    changedFiles: [],
    vcs: "svn",
  };
}

function buildGitRevisionArgs(revision?: string, since?: string, pathArgs?: string[]): string[] {
  const args: string[] = [];
  if (revision) {
    args.push("diff", revision);
  } else if (since) {
    args.push("diff", `${since}..HEAD`);
  } else {
    args.push("diff", "HEAD");
  }
  if (pathArgs) {
    args.push("--", ...pathArgs);
  }
  return args;
}

function buildSvnRevisionArgs(revision?: string, since?: string): string[] {
  const args: string[] = [];
  if (revision) {
    args.push("-r", revision);
  } else if (since) {
    args.push("-r", `${since}:HEAD`);
  }
  return args;
}

function buildGitPathArgs(files?: string[], exclude?: string[]): string[] | undefined {
  if (!files || files.length === 0) {
    if (exclude && exclude.length > 0) {
      return [".", ...exclude.filter((e) => isSafeRelativePath(e)).map((e) => `:(exclude)${e}`)];
    }
    return undefined;
  }

  const safeFiles = files.filter((f) => isSafeRelativePath(f));
  if (safeFiles.length === 0) {
    throw new Error("No safe file paths provided for git diff");
  }
  const args = [...safeFiles];
  if (exclude && exclude.length > 0) {
    for (const e of exclude) {
      if (isSafeRelativePath(e)) {
        args.push(":(exclude)" + e);
      }
    }
  }
  return args;
}

export function applyExclude(diff: string, exclude?: string[]): string {
  if (!exclude || exclude.length === 0) return diff;
  const patterns = exclude.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`^(Index: |--- )(${patterns.join("|")})(?:\\s|$)`, "m");
  const blocks = diff.split(/^(?=Index: )/m);
  return blocks.filter((b) => !regex.test(b)).join("");
}

function runVcsDiff(cwd: string, command: string[]): string {
  const [file, ...args] = command;
  return execFileSync(file, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function listGitUntrackedFiles(cwd: string, files?: string[], exclude?: string[]): string[] {
  const output = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const excludePatterns =
    exclude?.filter((e) => isSafeRelativePath(e)).map((e) => new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))) ??
    [];

  return output
    .split(/\r?\n/)
    .filter((f) => f.length > 0 && isSafeRelativePath(f))
    .filter((f) => {
      if (!files || files.length === 0) return true;
      return files.some((pattern) => isSafeRelativePath(pattern) && minimatch(f, pattern));
    })
    .filter((f) => !excludePatterns.some((re) => re.test(f)));
}

function minimatch(path: string, pattern: string): boolean {
  const segments = pattern.split("/");
  if (segments.length === 1) {
    // Bare name matches any filename or directory segment.
    return path === pattern || path.split("/").includes(pattern) || path.endsWith(`/${pattern}`);
  }
  return path === pattern || path.startsWith(pattern.endsWith("/") ? pattern : `${pattern}/`);
}

function runGitUntrackedDiff(cwd: string, files: string[]): string {
  const diffs: string[] = [];
  for (const file of files) {
    try {
      const diff = execFileSync("git", ["diff", "--no-index", NULL_DEVICE, file], {
        cwd,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      if (diff.trim()) diffs.push(diff);
    } catch (err) {
      const stdout =
        err && typeof err === "object" && "stdout" in err && typeof (err as { stdout?: unknown }).stdout === "string"
          ? (err as { stdout: string }).stdout
          : "";
      if (stdout.trim()) diffs.push(stdout);
    }
  }
  return diffs.join("\n");
}

function processDiff(diff: string, vcs: VcsType, maxDiffChars: number): DiffResult {
  const changedFiles = extractChangedFiles(diff, vcs);
  if (diff.length <= maxDiffChars) {
    return { diff, truncated: false, changedFiles, vcs };
  }
  return {
    diff: diff.slice(0, maxDiffChars) + "\n... diff truncated (too large)",
    truncated: true,
    changedFiles,
    vcs,
  };
}

function unquoteGitPath(path: string): string {
  // git diff --git with core.quotePath outputs C-style quoted paths.
  let out = path;
  if (out.startsWith('"') && out.endsWith('"')) {
    out = out.slice(1, -1);
  }
  return out
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function parseGitDiffHeader(line: string): string | undefined {
  // Combined diff headers from merge commits.
  const combined = /^diff --cc (.+?)$/.exec(line);
  if (combined) return combined[1].trim();
  // Quoted paths (spaces, non-ASCII).
  const quoted = /^diff --git "a\/(.+?)" "b\/(.+?)"$/.exec(line);
  if (quoted) return unquoteGitPath(quoted[2]);
  // Standard unquoted paths.
  const plain = /^diff --git a\/(.+?) b\/(.+?)$/.exec(line);
  if (plain) return plain[2];
  return undefined;
}

export function extractChangedFiles(diff: string, vcs: VcsType): string[] {
  const files = new Set<string>();
  if (vcs === "svn") {
    const regex = /^Index:\s*(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(diff)) !== null) {
      files.add(match[1].trim());
    }
    return [...files];
  }

  const lines = diff.split(/\r?\n/);
  for (const line of lines) {
    const file = parseGitDiffHeader(line);
    if (file) files.add(file);
  }
  return [...files];
}

export function splitDiffByFile(diff: string, vcs?: VcsType): Record<string, string> {
  const result: Record<string, string> = {};
  if (!diff.trim()) return result;
  const effectiveVcs = vcs ?? "git";

  if (effectiveVcs === "svn") {
    const blocks = diff.split(/^(?=Index: )/m);
    for (const block of blocks) {
      const match = block.match(/^Index:\s*(.+)$/m);
      if (match) result[match[1].trim()] = block;
    }
    return result;
  }

  const indices: { file: string; index: number }[] = [];
  const lines = diff.split(/\r?\n/);
  let cursor = 0;
  for (const line of lines) {
    const file = parseGitDiffHeader(line);
    if (file) {
      indices.push({ file, index: cursor });
    }
    cursor += line.length + 1; // +1 for the newline we split on
  }
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i].index;
    const end = i < indices.length - 1 ? indices[i + 1].index : diff.length;
    result[indices[i].file] = diff.slice(start, end);
  }
  return result;
}

function detectVcs(cwd: string): VcsType {
  if (existsSync(join(cwd, ".git"))) return "git";
  if (existsSync(join(cwd, ".svn"))) return "svn";

  // Fallback to command probes for non-standard layouts.
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return "git";
  } catch {
    /* ignore */
  }

  try {
    execFileSync("svn", ["info"], {
      cwd,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return "svn";
  } catch {
    /* ignore */
  }

  return "git";
}
