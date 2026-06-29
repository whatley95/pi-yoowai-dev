import { execFileSync } from "node:child_process";

const MAX_DIFF_CHARS = 6000;

export interface DiffResult {
  diff: string;
  truncated: boolean;
  changedFiles: string[];
}

export function getGitDiff(cwd: string, files?: string[], exclude?: string[]): DiffResult {
  const pathArgs = buildPathArgs(files, exclude);

  try {
    const diff = runGitDiff(cwd, ["git", "diff", "HEAD", "--", ...pathArgs]);
    if (diff.trim()) return processDiff(diff);
  } catch { /* git diff failed or no repo */ }

  try {
    const unstaged = runGitDiff(cwd, ["git", "diff", "--", ...pathArgs]);
    if (unstaged.trim()) return processDiff(unstaged);
  } catch { /* ignore */ }

  return { diff: "(no changes detected — review session context instead)", truncated: false, changedFiles: [] };
}

function buildPathArgs(files?: string[], exclude?: string[]): string[] {
  const args: string[] = [];
  if (files && files.length > 0) {
    args.push(...files);
  } else {
    args.push(".");
  }
  if (exclude && exclude.length > 0) {
    for (const e of exclude) {
      args.push(":(exclude)" + e);
    }
  }
  return args;
}

function runGitDiff(cwd: string, command: string[]): string {
  const [file, ...args] = command;
  return execFileSync(file, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
    timeout: 10000,
  });
}

function processDiff(diff: string): DiffResult {
  const changedFiles = extractChangedFiles(diff);
  if (diff.length <= MAX_DIFF_CHARS) {
    return { diff, truncated: false, changedFiles };
  }
  return {
    diff: diff.slice(0, MAX_DIFF_CHARS) + "\n... diff truncated (too large)",
    truncated: true,
    changedFiles,
  };
}

function extractChangedFiles(diff: string): string[] {
  const files = new Set<string>();
  const regex = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(diff)) !== null) {
    files.add(match[2]);
  }
  return [...files];
}
