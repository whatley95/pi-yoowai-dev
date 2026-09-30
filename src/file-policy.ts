/** Build products and local tool metadata are outside source review scope.
 * Keep capture, indexing, and workspace certification on the same policy. */
export const GENERATED_DIRECTORIES = [
  "node_modules",
  ".git",
  ".svn",
  ".idea",
  ".gradle",
  ".next",
  "__pycache__",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
] as const;

export const GENERATED_EXTENSIONS = ["class", "pyc", "pyo", "o", "obj", "pdb", "tsbuildinfo"] as const;

export function isGeneratedFile(file: string): boolean {
  const path = file
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
    .toLowerCase();
  return (
    path.split("/").some((segment) => (GENERATED_DIRECTORIES as readonly string[]).includes(segment)) ||
    GENERATED_EXTENSIONS.some((extension) => path.endsWith(`.${extension}`))
  );
}

/** UTF-8 decoding silently replaces binary bytes instead of throwing. */
export function isBinaryContent(content: Uint8Array): boolean {
  if (content.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return false;
  } catch {
    return true;
  }
}
