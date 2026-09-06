import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findImportSite, loadProjectIndexQuiet, resolveImportTarget } from "../project-index.js";
import { listTrackedFiles } from "../conventions.js";
import { estimateTokens } from "../token-budget.js";
import { logEvent } from "../logger.js";

export interface EvidencePackOptions {
  /** Token budget for the rendered pack. 0 = disabled (returns empty). */
  budgetTokens: number;
  /** Project-relative changed files (already validated by the caller). */
  changedFiles: string[];
}

export interface EvidenceEntry {
  kind: "symbol" | "import-site" | "test" | "contract";
  file: string;
  line: number;
  /** 1-based inclusive range (single-line entries keep start===end). */
  startLine: number;
  endLine: number;
  text: string;
  /** Selection reason (provenance of the claim). */
  reason: string;
  /** "index" (AST-backed) or "file-list" (tracked-file heuristic). */
  source: "index" | "file-list";
  /** "current" (working tree) or "unknown" (file-list heuristics). */
  side: "current" | "unknown";
  /** Resolved revision identifier when known (v1: current tree only). */
  revision?: string;
}

export interface EvidencePackResult {
  entries: EvidenceEntry[];
  /** Rendered block (empty when disabled or nothing found). */
  text: string;
  /** Every selection reason, cap exclusion, truncation, skip, and failure. */
  notes: string[];
  /** True when the rendered pack hit the budget and dropped candidates. */
  truncated: boolean;
}

const MAX_RELATIONSHIPS_PER_FILE = 4;
const MAX_TEST_FILES = 4;
const MAX_CONTRACT_FILES = 3;

/** Build the deterministic evidence pack for review. NEVER calls a model,
 *  never writes repo state, never throws: all failures become notes. */
export function buildReviewEvidencePack(cwd: string, options: EvidencePackOptions): EvidencePackResult {
  const { budgetTokens, changedFiles } = options;
  const notes: string[] = [];
  if (budgetTokens <= 0 || changedFiles.length === 0) {
    return { entries: [], text: "", notes: [], truncated: false };
  }

  const entries: EvidenceEntry[] = [];
  let truncated = false;
  try {
    // READ-ONLY index acquisition: an existing index is used as-is; a missing
    // or broken index is NEVER built or persisted here — it yields a note and
    // file-based evidence only (tests/contracts still work).
    const index = loadProjectIndexQuiet(cwd);
    if (!index || index.files.length === 0) {
      notes.push("evidence pack: no usable index — AST-backed evidence skipped (file-based evidence only)");
    }
    const byFile = new Map((index?.files ?? []).map((f) => [f.file, f]));
    const tracked = new Set(listTrackedFiles(cwd));
    const renderedLine = (e: EvidenceEntry) => `- ${e.text} (${e.reason})`;
    const renderedPack = (list: EvidenceEntry[]) =>
      list.length === 0 ? "" : `<evidence_pack>\n${list.map(renderedLine).join("\n")}\n</evidence_pack>`;
    const push = (entry: EvidenceEntry): boolean => {
      // EXACT accounting: render the complete prospective block (tags +
      // separators + all lines) and measure THAT string against the budget.
      const candidate = renderedPack([...entries, entry]);
      if (estimateTokens(candidate) > budgetTokens) {
        truncated = true;
        notes.push(`evidence pack: budget hit — dropped ${entry.kind} ${entry.file}:${entry.line}`);
        return false;
      }
      entries.push(entry);
      return true;
    };

    for (const file of changedFiles) {
      const fileIndex = byFile.get(file);
      // (a) symbol lines for the changed file (indexed symbols only).
      if (fileIndex) {
        const symbolRows = fileIndex.symbols.slice(0, 12);
        if (fileIndex.symbols.length > 12) {
          notes.push(`evidence pack: symbol rows capped at 12 for ${file} (${fileIndex.symbols.length - 12} more)`);
        }
        for (const symbol of symbolRows) {
          push({
            kind: "symbol",
            file,
            line: symbol.line,
            startLine: symbol.line,
            endLine: symbol.line,
            text: `${file}:${symbol.line} — ${symbol.signature ?? `${symbol.kind} ${symbol.name}`}${symbol.exported ? " (exported)" : ""}`,
            reason: `symbol in changed file`,
            source: "index",
            side: "current",
          });
        }
      } else {
        notes.push(`evidence pack: no index entry for ${file} — symbol evidence skipped`);
      }
      // (b) import / dependent sites (AST import lines, capped).
      if (fileIndex?.dependents?.length) {
        let shown = 0;
        let depIndex = 0;
        for (const dep of fileIndex.dependents) {
          depIndex++;
          if (shown >= MAX_RELATIONSHIPS_PER_FILE) {
            notes.push(
              `evidence pack: capped dependents for ${file} at ${MAX_RELATIONSHIPS_PER_FILE} (${fileIndex.dependents.length - depIndex + 1} more)`,
            );
            break;
          }
          const lineNo = findImportSite(cwd, dep, file, byFile, true);
          if (lineNo > 0) {
            push({
              kind: "import-site",
              file: dep,
              line: lineNo,
              startLine: lineNo,
              endLine: lineNo,
              text: `${dep}:${lineNo} imports this file`,
              reason: `dependent AST import site`,
              source: "index",
              side: "current",
            });
            shown++;
          } else {
            notes.push(`evidence pack: dependent ${dep} of ${file} has no verifiable import site`);
          }
        }
      }
      // Nearby tests: co-located test files OR tracked tests importing the file.
      const tests = findNearbyTests(cwd, file, tracked, notes);
      for (const testFile of tests.slice(0, MAX_TEST_FILES)) {
        push({
          kind: "test",
          file: testFile,
          line: 1,
          startLine: 1,
          endLine: 1,
          text: `test: ${testFile}`,
          reason: `nearby test for changed file${tests.length > MAX_TEST_FILES ? " (capped)" : ""}`,
          source: "file-list",
          side: "unknown",
        });
      }
      if (tests.length > MAX_TEST_FILES) {
        notes.push(
          `evidence pack: test files capped at ${MAX_TEST_FILES} for ${file} (${tests.length - MAX_TEST_FILES} more)`,
        );
      }
    }

    // (c) contract candidates (best-effort filename/import evidence only).
    const contracts = findContractCandidates(changedFiles, tracked);
    for (const c of contracts.slice(0, MAX_CONTRACT_FILES)) {
      push({
        kind: "contract",
        file: c,
        line: 1,
        startLine: 1,
        endLine: 1,
        text: `contract candidate: ${c}`,
        reason: `filename/schema evidence near changed files (heuristic — not a verified semantic pair)`,
        source: "file-list",
        side: "unknown",
      });
    }
    if (contracts.length === 0) {
      notes.push("evidence pack: no contract candidates found near changed files");
    } else if (contracts.length > MAX_CONTRACT_FILES) {
      notes.push(
        `evidence pack: contract candidates capped at ${MAX_CONTRACT_FILES} (${contracts.length - MAX_CONTRACT_FILES} more)`,
      );
    }
  } catch (err) {
    notes.push(`evidence pack: failed (${err instanceof Error ? err.message : String(err)})`);
  }

  if (entries.length === 0) {
    return { entries: [], text: "", notes: [...notes, "evidence pack: nothing to add"], truncated };
  }
  const counts = entries.reduce<Record<string, number>>((m, e) => {
    m[e.kind] = (m[e.kind] ?? 0) + 1;
    return m;
  }, {});
  notes.push(
    `evidence pack: selected ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (${Object.entries(counts)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ")})`,
  );
  const text = `<evidence_pack>\n${entries.map((e) => `- ${e.text} (${e.reason})`).join("\n")}\n</evidence_pack>`;
  if (truncated) {
    notes.push("evidence pack: truncated");
  }
  return { entries, text, notes, truncated };
}

/** Test files related to a changed file: co-located (*.test.* / *_test.*) and
 *  tracked test-looking files importing it. Tracked-only, deduped. */
function findNearbyTests(cwd: string, changedFile: string, tracked: Set<string>, notes: string[]): string[] {
  const out: string[] = [];
  const dir = dirname(changedFile);
  const base = changedFile.split(/[\\/]/).pop() ?? changedFile;
  const stem = base.replace(/(\.d)?\.[jt]sx?$/, "").replace(/\.dart$/, "");
  for (const file of tracked) {
    if (!isTestFile(file)) continue;
    if (dirname(file) === dir && file !== changedFile && file.includes(stem)) {
      out.push(file);
      continue;
    }
    if (out.length < 100 && importsFile(cwd, file, changedFile, notes)) {
      out.push(file);
    }
  }
  return [...new Set(out)];
}

function isTestFile(file: string): boolean {
  // Explicit test conventions only: *.test.*, *.spec.*, *_test.dart, *_spec.dart.
  return /\.(test|spec)\.(ts|tsx|js|jsx|dart)$/.test(file) || /_test\.dart$/.test(file) || /_spec\.dart$/.test(file);
}

function importsFile(cwd: string, candidate: string, target: string, notes: string[]): boolean {
  try {
    const source = readFileSync(join(cwd, candidate), "utf-8");
    const targetNorm = normalizeRelPath(target);
    for (const line of source.split(/\n/)) {
      if (!/^\s*(import|export|require)\b/.test(line)) continue;
      const specs = line.match(/['"]([^'"]+)['"]/g) ?? [];
      for (const raw of specs) {
        const spec = raw.slice(1, -1);
        // Only relative specifiers can be resolved against the importing file;
        // package imports and aliases never establish a project pair here.
        if (!(spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..")) continue;
        const resolved = resolveImportTarget(candidate, spec) ?? [spec];
        const normalized = resolved.map(normalizeRelPath);
        if (normalized.includes(targetNorm)) return true;
      }
    }
    return false;
  } catch (err) {
    notes.push(
      `evidence pack: unreadable candidate ${candidate} (${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  }
}

/** Normalize a project-relative path for comparison (forward slashes, no
 *  trailing/leading separators). */
function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

/** Contract candidates: api/dto/schema/contract/route/handler/endpoint files
 *  in the same directory as (or importing) changed files. HEURISTIC only. */
function findContractCandidates(changedFiles: string[], tracked: Set<string>): string[] {
  const out: string[] = [];
  const CONTRACT_RE = /(api|dto|schema|contract|route|handler|endpoint|server)/i;
  for (const changed of changedFiles) {
    const dir = dirname(changed);
    for (const file of tracked) {
      if (file === changed || !CONTRACT_RE.test(file.split(/[/]/).pop() ?? file)) continue;
      if (dirname(file) === dir) {
        out.push(file);
      }
    }
  }
  return [...new Set(out)];
}
export function evidencePackSummary(result: EvidencePackResult): string {
  return `evidence pack: ${result.entries.length} entr${result.entries.length === 1 ? "y" : "ies"}${result.truncated ? " (truncated)" : ""}`;
}
export function logPackNote(cwd: string, pack: EvidencePackResult): void {
  if (pack.notes.length > 0) {
    logEvent(cwd, "debug", evidencePackSummary(pack), { notes: pack.notes.slice(0, 5) });
  }
}
