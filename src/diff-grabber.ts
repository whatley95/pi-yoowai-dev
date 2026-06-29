import { execSync } from "node:child_process";

const MAX_DIFF_CHARS = 6000;

export interface DiffResult {
  diff: string;
  truncated: boolean;
}

export function getGitDiff(cwd: string): DiffResult {
  try {
    const diff = execSync("git diff HEAD -- .", {
      cwd,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 10000,
    });

    if (diff.trim()) {
      return maybeTruncate(diff);
    }
  } catch { /* git diff failed or no repo */ }

  try {
    const unstaged = execSync("git diff -- .", {
      cwd,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 10000,
    });

    if (unstaged.trim()) {
      return maybeTruncate(unstaged);
    }
  } catch { /* ignore */ }

  return { diff: "(no changes detected — review session context instead)", truncated: false };
}

function maybeTruncate(diff: string): DiffResult {
  if (diff.length <= MAX_DIFF_CHARS) {
    return { diff, truncated: false };
  }
  return {
    diff: diff.slice(0, MAX_DIFF_CHARS) + "\n... diff truncated (too large)",
    truncated: true,
  };
}
