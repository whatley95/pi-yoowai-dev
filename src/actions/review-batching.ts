import { posix } from "node:path";
import { resolveImportTarget } from "../project-index.js";

interface BatchFile {
  file: string;
  content: string;
}

function stem(file: string): string {
  const normalized = file.replaceAll("\\", "/");
  return posix.join(
    posix.dirname(normalized),
    posix.basename(normalized, posix.extname(normalized)).replace(/\.(?:spec|test)$/, ""),
  );
}

function related(a: BatchFile, b: BatchFile): boolean {
  if (stem(a.file) === stem(b.file)) return true;
  const imports = (from: BatchFile, target: string): boolean => {
    const pattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'](\.[^"']+)["']/g;
    for (const match of from.content.matchAll(pattern))
      if (resolveImportTarget(from.file, match[1])?.includes(target.replaceAll("\\", "/"))) return true;
    return false;
  };
  return imports(a, b.file) || imports(b, a.file);
}

/** Group only related files whose complete evidence fits. Unrelated or
 *  oversized inputs retain their separate reviews and original order. */
export function groupRelatedReviewFiles<T extends BatchFile>(
  files: T[],
  maxFiles: number,
  fits: (group: T[]) => boolean,
): T[][] {
  const groups: T[][] = [];
  for (const file of files) {
    const group = groups.find(
      (items) => items.length < maxFiles && items.some((item) => related(item, file)) && fits([...items, file]),
    );
    if (group) group.push(file);
    else groups.push([file]);
  }
  return groups;
}
