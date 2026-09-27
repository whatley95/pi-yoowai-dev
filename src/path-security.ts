import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

export function isSafeRelativePath(path: string): boolean {
  if (!path || typeof path !== "string") return false;
  if (path.includes("\0")) return false;
  if (isAbsolute(path)) return false;
  const normalized = normalize(path);
  if (normalized === "..") return false;
  if (normalized.startsWith(".." + sep)) return false;
  if (normalized.includes(sep + ".." + sep)) return false;
  if (normalized.endsWith(sep + "..")) return false;
  return true;
}

export function resolveProjectPath(cwd: string, path: string): string | null {
  if (!isSafeRelativePath(path)) return null;
  const resolved = resolve(cwd, path);
  const cwdResolved = resolve(cwd);
  const contained = (root: string, target: string): boolean => {
    const rel = relative(root, target);
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  };
  if (!contained(cwdResolved, resolved)) return null;
  try {
    const realCwd = realpathSync(cwdResolved);
    // Include the target itself, and walk missing descendants up to their
    // nearest existing ancestor. lstat detects broken links; realpath then
    // fails closed instead of treating them as safe missing directories.
    let ancestor = resolved;
    while (true) {
      try {
        lstatSync(ancestor);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
        if (ancestor === cwdResolved) return null;
        ancestor = dirname(ancestor);
        continue;
      }
      if (!contained(realCwd, realpathSync(ancestor))) return null;
      break;
    }
  } catch {
    return null;
  }
  return resolved;
}

export function validateRevision(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) return undefined;
  if (value.startsWith("-")) return undefined;
  if (isAbsolute(value)) return undefined;
  const normalized = normalize(value);
  if (normalized.startsWith("..") || normalized.includes(sep + ".." + sep)) return undefined;
  return value;
}
