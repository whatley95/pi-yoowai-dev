import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRelatedContext, buildFileOutlines } from "./context-retrieval.js";

describe("context-retrieval", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "wai-context-"));
    mkdirSync(join(cwd, "src"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("finds related files via relative imports", () => {
    writeFileSync(join(cwd, "src", "utils.ts"), "export function helper(): string { return 'x'; }", "utf-8");
    writeFileSync(
      join(cwd, "src", "main.ts"),
      "import { helper } from './utils';\nexport const x = helper();",
      "utf-8",
    );

    const result = buildRelatedContext(cwd, ["src/main.ts"]);
    assert.ok(result.files.includes("src/utils.ts"), "should include imported file");
    assert.match(result.context, /helper/);
  });

  it("excludes files that are already in changedFiles", () => {
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;", "utf-8");
    const result = buildRelatedContext(cwd, ["src/a.ts"]);
    assert.equal(result.files.length, 0);
  });

  it("buildFileOutlines outlines exactly the requested files", () => {
    writeFileSync(join(cwd, "src", "a.ts"), "export function helper(): string { return 'x'; }", "utf-8");
    writeFileSync(join(cwd, "src", "b.ts"), "export const b = 1;", "utf-8");

    const result = buildFileOutlines(cwd, ["src/a.ts", "src/b.ts"], 800);
    assert.deepEqual(result.files, ["src/a.ts", "src/b.ts"]);
    assert.match(result.context, /--- src\/a\.ts ---/);
    assert.match(result.context, /helper/);
    assert.match(result.context, /--- src\/b\.ts ---/);
    assert.ok(result.tokenEstimate > 0);
  });

  it("buildFileOutlines accumulates per-file overhead cumulatively", () => {
    writeFileSync(join(cwd, "src", "a.ts"), "export function alpha(): void {}", "utf-8");
    writeFileSync(join(cwd, "src", "b.ts"), "export function bravo(): void {}", "utf-8");

    // Each file's complete entry (header + outline + overhead) fits alone,
    // but two entries do not: the overhead must accumulate.
    const single = buildFileOutlines(cwd, ["src/a.ts"], 40, 12);
    assert.equal(single.files.length, 1);
    const both = buildFileOutlines(cwd, ["src/a.ts", "src/b.ts"], 40, 12);
    assert.equal(both.files.length, 1, "two entries with both overheads must not fit in 40 tokens");
    assert.ok(single.tokenEstimate <= 40 && both.tokenEstimate <= 40, "the consumed budget must stay within the cap");
  });

  it("buildFileOutlines honors per-file overhead so entries stay complete", () => {
    writeFileSync(join(cwd, "src", "a.ts"), "export function alpha(): void {}", "utf-8");
    writeFileSync(join(cwd, "src", "b.ts"), "export function bravo(): void {}", "utf-8");

    // With a per-file overhead reservation, files whose outline + overhead
    // would exceed the cap are excluded as complete units.
    const withOverhead = buildFileOutlines(cwd, ["src/a.ts", "src/b.ts"], 40, 12);
    const withoutOverhead = buildFileOutlines(cwd, ["src/a.ts", "src/b.ts"], 40);
    assert.equal(withoutOverhead.files.length, 2);
    assert.ok(
      withOverhead.files.length < withoutOverhead.files.length,
      "the overhead reservation must shrink the included set as complete units",
    );
  });

  it("buildFileOutlines skips missing files and caps by token budget", () => {
    writeFileSync(join(cwd, "src", "a.ts"), "export function alpha(): void {}", "utf-8");
    writeFileSync(join(cwd, "src", "b.ts"), "export function bravo(): void {}", "utf-8");

    // Missing file is skipped, the rest survive.
    const result = buildFileOutlines(cwd, ["src/a.ts", "src/missing.ts", "src/b.ts"], 800);
    assert.deepEqual(result.files, ["src/a.ts", "src/b.ts"]);

    // A budget too small for any single outline yields nothing.
    const tiny = buildFileOutlines(cwd, ["src/a.ts"], 1);
    assert.deepEqual(tiny.files, []);
    assert.equal(tiny.context, "");
    assert.equal(tiny.tokenEstimate, 0);
  });
});
