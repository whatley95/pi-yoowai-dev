import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodemap } from "./codemap.js";

describe("buildCodemap", () => {
  let cwd: string;
  const tmpDirs: string[] = [];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "wai-codemap-test-"));
    tmpDirs.push(cwd);
  });

  after(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  function writeTsProject(): void {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(
      join(cwd, "src", "util.ts"),
      `export function greet(name: string): string {
  return \`Hello, \${name}\`;
}

export interface Config {
  debug: boolean;
}
`,
      "utf-8",
    );
    writeFileSync(
      join(cwd, "src", "main.ts"),
      `import { greet } from "./util";

export function run(): void {
  console.log(greet("world"));
}
`,
      "utf-8",
    );
  }

  it("returns an empty string when the budget is zero or negative", () => {
    writeTsProject();
    assert.equal(buildCodemap(cwd, ["src/main.ts"], 0), "");
    assert.equal(buildCodemap(cwd, ["src/main.ts"], -10), "");
  });

  it("returns an empty string when there are no changed files", () => {
    writeTsProject();
    assert.equal(buildCodemap(cwd, [], 1500), "");
  });

  it("maps symbols of changed files and their import neighbors", () => {
    writeTsProject();
    const codemap = buildCodemap(cwd, ["src/main.ts"], 1500);

    assert.ok(codemap.includes("src/main.ts"), "should include the changed file");
    assert.ok(codemap.includes("run"), "should include the changed file's symbols");
    assert.ok(codemap.includes("src/util.ts"), "should include the direct import neighbor");
    assert.ok(codemap.includes("greet"), "should include the neighbor's exported function");
    assert.ok(codemap.includes("interface Config"), "should include the neighbor's interface");
    // One line per symbol: file:line — signature/kind.
    assert.ok(/src\/util\.ts:\d+ — /.test(codemap), "lines should carry file:line prefixes");
  });

  it("reuses the persisted index across calls", () => {
    writeTsProject();
    const first = buildCodemap(cwd, ["src/main.ts"], 1500);
    const second = buildCodemap(cwd, ["src/main.ts"], 1500);
    assert.equal(first, second);
  });

  it("truncates whole symbol lines to fit the token budget", () => {
    writeTsProject();
    const codemap = buildCodemap(cwd, ["src/main.ts"], 25);

    assert.ok(codemap.length > 0, "should keep at least one line");
    assert.ok(codemap.includes("… (symbol map truncated)"), "should note truncation");
    for (const line of codemap.split("\n")) {
      if (line === "… (symbol map truncated)") continue;
      assert.ok(line.includes(" — "), `line should not be cut mid-line: ${line}`);
    }
  });

  it("falls back gracefully for non-TypeScript projects", () => {
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "guide.md"), "# Guide\n\nSome prose.\n", "utf-8");

    const codemap = buildCodemap(cwd, ["docs/guide.md"], 1500);
    assert.equal(typeof codemap, "string", "should never throw");
  });

  it("falls back gracefully when a changed file does not exist", () => {
    writeTsProject();
    const codemap = buildCodemap(cwd, ["src/missing.ts"], 1500);
    assert.equal(typeof codemap, "string", "should never throw");
  });

  it("rebuilds the index when a changed file was edited after indexing", () => {
    writeTsProject();
    const before = buildCodemap(cwd, ["src/main.ts"], 1500);
    assert.ok(before.includes("run"), "baseline should include the original symbol");

    // Edit main.ts after the index was persisted — the edit→review flow.
    writeFileSync(join(cwd, "src", "main.ts"), "export function brandNew(): number { return 1; }\n", "utf-8");

    const after = buildCodemap(cwd, ["src/main.ts"], 1500);
    assert.ok(after.includes("brandNew"), "codemap must show the new symbol after the edit");
    assert.ok(!after.includes("run"), "removed symbols must not leak in from the stale index");
  });

  it("indexes a newly created file that appears in changedFiles", () => {
    writeTsProject();
    buildCodemap(cwd, ["src/main.ts"], 1500); // persist the index

    writeFileSync(join(cwd, "src", "newfile.ts"), "export function fresh(): string { return 'x'; }\n", "utf-8");

    const codemap = buildCodemap(cwd, ["src/newfile.ts"], 1500);
    assert.ok(codemap.includes("fresh"), "new indexable file must appear after the freshness-triggered rebuild");
  });

  it("does not rebuild for non-indexable changed files", () => {
    writeTsProject();
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "guide.md"), "# Guide\n\nSome prose.\n", "utf-8");

    buildCodemap(cwd, ["src/main.ts"], 1500); // persist the index
    const indexPath = join(cwd, ".pi", "yoowai", "index.json");
    const indexBefore = readFileSync(indexPath, "utf-8");

    const codemap = buildCodemap(cwd, ["docs/guide.md"], 1500);
    assert.equal(typeof codemap, "string", "should never throw");
    const indexAfter = readFileSync(indexPath, "utf-8");
    assert.equal(indexAfter, indexBefore, "non-indexable changed files must not trigger a rebuild");
  });

  it("does not rebuild for indexable files with no symbols", () => {
    writeTsProject();
    // An import-only file extracts zero symbols; it must still be persisted
    // so freshness treats it as covered instead of rebuilding every call.
    writeFileSync(join(cwd, "src", "empty.ts"), "import { greet } from './util';\n", "utf-8");

    buildCodemap(cwd, ["src/empty.ts"], 1500);
    const indexPath = join(cwd, ".pi", "yoowai", "index.json");
    const indexBefore = readFileSync(indexPath, "utf-8");

    buildCodemap(cwd, ["src/empty.ts"], 1500);
    assert.equal(readFileSync(indexPath, "utf-8"), indexBefore, "zero-symbol files must not trigger rebuilds");
  });

  it("detects edits that preserve mtime but change size", () => {
    writeTsProject();
    buildCodemap(cwd, ["src/main.ts"], 1500); // persist the index

    const filePath = join(cwd, "src", "main.ts");
    const original = statSync(filePath);
    writeFileSync(filePath, "export function brandNew(): number { return 1; }\n", "utf-8");
    // Restore the old mtime so only the size differs (coarse-granularity
    // filesystems can land edits within the same mtime tick).
    utimesSync(filePath, original.atime, original.mtime);

    const codemap = buildCodemap(cwd, ["src/main.ts"], 1500);
    assert.ok(codemap.includes("brandNew"), "size change must be detected even with an identical mtime");
  });

  it("handles a deleted changed file without throwing", () => {
    writeTsProject();
    buildCodemap(cwd, ["src/main.ts"], 1500); // persist the index
    const indexPath = join(cwd, ".pi", "yoowai", "index.json");

    rmSync(join(cwd, "src", "main.ts"));

    const codemap = buildCodemap(cwd, ["src/main.ts"], 1500);
    assert.equal(typeof codemap, "string", "should never throw");
    assert.ok(!codemap.includes("run"), "deleted file's stale symbols must not be rendered");

    // The first call rebuilt the index (dropping the file); a second call
    // must NOT rebuild again — a deleted file lingering in the diff would
    // otherwise trigger a rebuild on every review.
    const afterFirst = readFileSync(indexPath, "utf-8");
    buildCodemap(cwd, ["src/main.ts"], 1500);
    assert.equal(
      readFileSync(indexPath, "utf-8"),
      afterFirst,
      "deleted changed files must not trigger repeated rebuilds",
    );
  });
});
