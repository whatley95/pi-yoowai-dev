import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectIndex, loadProjectIndex, saveProjectIndex } from "./project-index.js";

describe("project-index", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "yoo-index-test-"));
  });

  it("indexes TypeScript source files", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(
      join(cwd, "src", "utils.ts"),
      `
export function greet(name: string): string {
  return \`Hello, \${name}\`;
}

class Helper {
  run() {}
}

export interface Config {
  debug: boolean;
}
`,
      "utf-8",
    );

    const index = buildProjectIndex(cwd);
    assert.ok(index.files.length > 0, "should index at least one file");
    const file = index.files.find((f) => f.file === "src/utils.ts");
    assert.ok(file, "should include src/utils.ts");

    const names = file.symbols.map((s) => s.name);
    assert.ok(names.includes("greet"), "should include greet function");
    assert.ok(names.includes("Helper"), "should include Helper class");
    assert.ok(names.includes("Config"), "should include Config interface");

    const greet = file.symbols.find((s) => s.name === "greet");
    assert.equal(greet?.kind, "function");
    assert.equal(greet?.exported, true);
    assert.ok(greet?.line && greet.line > 0);
  });

  it("save and load round-trips the index", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "export const x = 1;", "utf-8");

    const index = buildProjectIndex(cwd);
    saveProjectIndex(cwd, index);

    assert.ok(existsSync(join(cwd, ".pi", "heyyoo", "index.json")), "index file should be saved");
    const loaded = loadProjectIndex(cwd);
    assert.deepEqual(loaded, index);
  });

  it("returns null when no index exists", () => {
    const loaded = loadProjectIndex(cwd);
    assert.equal(loaded, null);
  });

  it("ignores unsupported and generated files", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "main.ts"), "export const a = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "style.css"), ".a {}", "utf-8");
    writeFileSync(join(cwd, "src", "data.json"), "{}", "utf-8");

    const index = buildProjectIndex(cwd);
    const files = index.files.map((f) => f.file);
    assert.ok(files.includes("src/main.ts"));
    assert.ok(!files.includes("src/style.css"));
    assert.ok(!files.includes("src/data.json"));
  });

  it("reports index stats", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "b.ts"), "export const b = 2;", "utf-8");

    const index = buildProjectIndex(cwd);
    assert.ok(index.stats);
    assert.equal(index.stats?.scanned, 2);
    assert.equal(index.stats?.indexed, 2);
    assert.equal(index.stats?.symbols, 2);
    assert.equal(index.stats?.skipped, 0);
  });

  it("cleans up temp dir", () => {
    rmSync(cwd, { recursive: true, force: true });
  });
});
