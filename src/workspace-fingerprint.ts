import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveProjectPath } from "./path-security.js";
import { gitSpawnEnv } from "./git-env.js";
import { isPiStatePath } from "./diff-grabber.js";

export type WorkspaceSnapshot =
  | { status: "ready"; fingerprint: string; dirty: boolean }
  | { status: "unsupported" }
  | { status: "unavailable"; reason: string };

/** Hash actual contents, including untracked files, rather than truncated diffs
 * or mtime/size. Runtime metadata is excluded so recording a review is inert. */
export function captureWorkspace(cwd: string): WorkspaceSnapshot {
  // A nested SVN checkout can live under a Git-owned parent directory.
  // Prefer the nearest working-copy marker, as diff collection does.
  let ancestor = cwd;
  while (true) {
    if (existsSync(join(ancestor, ".svn"))) return captureSvnWorkspace(cwd);
    if (existsSync(join(ancestor, ".git"))) break;
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      env: gitSpawnEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  try {
    if (git(["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return captureSvnWorkspace(cwd);
  } catch {
    let ancestor = cwd;
    while (true) {
      if (existsSync(join(ancestor, ".git")))
        return { status: "unavailable", reason: "Git work-tree inspection failed" };
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    return captureSvnWorkspace(cwd);
  }
  try {
    const hash = createHash("sha256");
    const files = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0"))]
      .filter((file) => file && !isPiStatePath(file))
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
        .filter((entry) => !isPiStatePath(entry.split("\t")[1] ?? ""))
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

function decodeXmlAttribute(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, code: string) => {
    if (code.startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return (
      ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" } as Record<string, string>)[code.toLowerCase()] ?? entity
    );
  });
}

/** SVN's verbose XML status lists unchanged versioned files as well as edits.
 * Hash their contents and unversioned descendants, excluding wai's own state. */
function captureSvnWorkspace(cwd: string): WorkspaceSnapshot {
  const svn = (args: string[]): string =>
    execFileSync("svn", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  try {
    if (!svn(["info", "--show-item", "wc-root"]).trim()) throw new Error("SVN working-copy root is missing");
  } catch (err) {
    let ancestor = cwd;
    while (true) {
      if (existsSync(join(ancestor, ".svn"))) {
        return { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    return { status: "unsupported" };
  }
  try {
    const statusXml = svn(["status", "--xml", "--verbose"]);
    const entries = [...statusXml.matchAll(/<entry\b[^>]*\bpath="([^"]*)"[^>]*>([\s\S]*?)<\/entry>/g)]
      .map((match) => ({ path: decodeXmlAttribute(match[1]), body: match[2] }))
      .filter(({ path }) => path === "." || !isPiStatePath(path))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (entries.length === 0) throw new Error("SVN status returned no entries");
    const hash = createHash("sha256");
    const visited = new Set<string>();
    let dirty = false;
    const hashPath = (relative: string, expandUnversioned: boolean): void => {
      if (isPiStatePath(relative) || visited.has(relative)) return;
      visited.add(relative);
      const path = resolveProjectPath(cwd, relative);
      if (!path) throw new Error(`Cannot safely fingerprint ${relative}`);
      hash.update(`\0${relative}\0`);
      try {
        const stat = lstatSync(path);
        hash.update(`${stat.mode}\0`);
        if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
        else if (stat.isFile()) hash.update(createHash("sha256").update(readFileSync(path)).digest());
        else if (stat.isDirectory() && expandUnversioned) {
          for (const child of readdirSync(path).sort())
            hashPath(relative === "." ? child : `${relative}/${child}`, true);
        } else if (!stat.isDirectory()) throw new Error(`Unsupported SVN entry: ${relative}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") hash.update("deleted");
        else throw err;
      }
    };
    for (const entry of entries) {
      const statusTag = entry.body.match(/<wc-status\b[^>]*>/)?.[0];
      const attributes = Object.fromEntries(
        [...(statusTag ?? "").matchAll(/([a-z-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
      );
      const item = attributes.item;
      const props = attributes.props;
      if (!item) throw new Error(`Missing SVN status for ${entry.path}`);
      if (item !== "normal" || (props && props !== "none" && props !== "normal")) dirty = true;
      hash.update(`\0${entry.path}\0${JSON.stringify(Object.entries(attributes).sort())}\0`);
      if (props === "modified") hash.update(svn(["diff", "--properties-only", "--depth", "empty", entry.path]));
      hashPath(entry.path, item === "unversioned");
    }
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
