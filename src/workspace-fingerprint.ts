import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveProjectPath } from "./path-security.js";
import { gitSpawnEnv } from "./git-env.js";

export type WorkspaceSnapshot =
  | { status: "ready"; fingerprint: string; dirty: boolean }
  | { status: "unsupported" }
  | { status: "unavailable"; reason: string };

/** Hash actual contents, including untracked files, rather than truncated diffs
 * or mtime/size. Runtime metadata is excluded so recording a review is inert. */
export function captureWorkspace(cwd: string): WorkspaceSnapshot {
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      env: gitSpawnEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  try {
    if (git(["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return { status: "unsupported" };
  } catch {
    let ancestor = cwd;
    while (true) {
      if (existsSync(join(ancestor, ".git")))
        return { status: "unavailable", reason: "Git work-tree inspection failed" };
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    // No Git work tree: retain the host's tool-based tracking (including SVN).
    return { status: "unsupported" };
  }
  try {
    const hash = createHash("sha256");
    const files = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0"))]
      .filter((file) => file && !file.replaceAll("\\", "/").split("/").includes(".pi"))
      .sort();
    // A commit changes the review range even when file contents are identical.
    let head = "unborn";
    try {
      head = git(["rev-parse", "--verify", "HEAD"]).trim();
    } catch {
      /* empty repository */
    }
    hash.update(head);
    hash.update(
      git(["ls-files", "--stage", "-z"])
        .split("\0")
        .filter((entry) => !entry.split("\t")[1]?.split("/").includes(".pi"))
        .join("\0"),
    );
    for (const file of files) {
      hash.update(`\0${file}\0`);
      const path = resolveProjectPath(cwd, file);
      if (!path) throw new Error(`Cannot safely fingerprint ${file}`);
      try {
        const stat = lstatSync(path);
        hash.update(`${stat.mode}\0`);
        if (stat.isSymbolicLink()) {
          hash.update(readlinkSync(path));
          hash.update(createHash("sha256").update(readFileSync(path)).digest());
        } else if (stat.isFile()) hash.update(createHash("sha256").update(readFileSync(path)).digest());
        else if (stat.isDirectory()) {
          const nested = captureWorkspace(path);
          if (nested.status !== "ready") throw new Error(`Cannot fingerprint submodule ${file}`);
          hash.update(nested.fingerprint);
        } else throw new Error(`Unsupported tracked entry: ${file}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") hash.update("deleted");
        else throw err;
      }
    }
    const dirty = git(["status", "--porcelain=v1", "--untracked-files=normal"])
      .split("\n")
      .some((line) => line.trim() && !/^.. "?\.pi(?:[\\/]|"?$)/.test(line));
    return { status: "ready", fingerprint: hash.digest("hex"), dirty };
  } catch (err) {
    return { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }
}

export function workspaceMatches(cwd: string, before: WorkspaceSnapshot): boolean {
  if (before.status === "unsupported") return true;
  const after = captureWorkspace(cwd);
  return before.status === "ready" && after.status === "ready" && before.fingerprint === after.fingerprint;
}
