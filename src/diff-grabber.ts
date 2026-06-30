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
  const pathArgs = buildGitPathArgs(options.files, options.exclude);
  const maxDiffChars = options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;

  try {
    const args = buildGitRevisionArgs(revision, since, pathArgs);
    const diff = runVcsDiff(cwd, ["git", ...args]);
    if (diff.trim()) return processDiff(diff, "git", maxDiffChars);
  } catch (err) {
    logEvent(cwd, "debug", "Git diff attempt failed", {
      error: err instanceof Error ? err.message : String(err),
      args: buildGitRevisionArgs(revision, since, pathArgs),
    });
  }

  try {
    const diff = runVcsDiff(cwd, ["git", "diff", "--", ...pathArgs]);
    if (diff.trim()) return processDiff(diff, "git", maxDiffChars);
  } catch (err) {
    logEvent(cwd, "debug", "Git working-tree diff failed", { error: err instanceof Error ? err.message : String(err) });
  }

  if (options.untracked) {
    try {
      const untracked = runGitUntrackedDiff(cwd, pathArgs);
      if (untracked.trim()) return processDiff(untracked, "git", maxDiffChars);
    } catch (err) {
      logEvent(cwd, "debug", "Git untracked diff failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

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
    if (safeExcludes.length > 0) {
      args.push("--diff-cmd", "internal");
    }
    args.push(...pathArgs);
    const diff = runVcsDiff(cwd, ["svn", "diff", ...args]);
    if (diff.trim()) {
      const filtered = applyExclude(diff, safeExcludes);
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

function buildGitRevisionArgs(revision?: string, since?: string, pathArgs: string[] = []): string[] {
  if (revision) {
    return ["diff", revision, "--", ...pathArgs];
  }
  if (since) {
    return ["diff", `${since}..HEAD`, "--", ...pathArgs];
  }
  return ["diff", "HEAD", "--", ...pathArgs];
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

function buildGitPathArgs(files?: string[], exclude?: string[]): string[] {
  const args: string[] = [];
  if (files && files.length > 0) {
    for (const f of files) {
      if (isSafeRelativePath(f)) {
        args.push(f);
      }
    }
  }
  if (args.length === 0) {
    args.push(".");
  }
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
  const regex = new RegExp(`^(Index: |--- )(${patterns.join("|")})`, "m");
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

function runGitUntrackedDiff(cwd: string, pathArgs: string[]): string {
  try {
    return execFileSync("git", ["diff", "--no-index", NULL_DEVICE, ...pathArgs], {
      cwd,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    const stdout =
      err && typeof err === "object" && "stdout" in err && typeof (err as { stdout?: unknown }).stdout === "string"
        ? (err as { stdout: string }).stdout
        : "";
    if (stdout) return stdout;
    throw err;
  }
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

  const regex = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(diff)) !== null) {
    files.add(match[2]);
  }
  return [...files];
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
