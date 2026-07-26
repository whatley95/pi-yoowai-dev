import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
});
