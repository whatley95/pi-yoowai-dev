import { isAbsolute, normalize, resolve, sep } from "node:path";

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
  if (resolved !== cwdResolved && !resolved.startsWith(cwdResolved + sep)) return null;
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
