/** Structured detail for a failed lazy `import(specifier)`, so the per-project
 *  log says WHY the import failed and WHERE resolution pointed instead of a
 *  bare "not installed" hint. This matters because Pi can run the extension
 *  from an installed copy whose node_modules differs from the dev clone — the
 *  resolved field makes that visible from the log alone. */
export interface ImportFailureDetail {
  /** err.code from the failed import (e.g. MODULE_NOT_FOUND). */
  code?: string;
  message: string;
  /** Result of import.meta.resolve(specifier): the URL resolution points at,
   *  or "unresolvable: ..." when resolution itself fails. Omitted when
   *  import.meta.resolve is unavailable on this Node version. */
  resolved?: string;
}

/** Capture failure detail for a lazy `import(specifier)` that threw. */
export function captureImportFailure(err: unknown, specifier: string): ImportFailureDetail {
  const detail: ImportFailureDetail = {
    message: err instanceof Error ? err.message : String(err),
  };
  if (err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    detail.code = (err as { code: string }).code;
  }
  const resolved = resolveSpecifier(specifier);
  if (resolved !== undefined) {
    detail.resolved = resolved;
  }
  return detail;
}

function resolveSpecifier(specifier: string): string | undefined {
  try {
    // import.meta.resolve is sync since Node 20.6; cast through unknown so a
    // Node version without it (or a loader that stubs it) degrades to
    // "no resolved field" instead of throwing at module load.
    const meta = import.meta as unknown as { resolve?: (s: string) => string };
    if (typeof meta.resolve !== "function") return undefined;
    return meta.resolve(specifier);
  } catch (resolveErr) {
    return `unresolvable: ${resolveErr instanceof Error ? resolveErr.message : String(resolveErr)}`;
  }
}
