import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRelatedContext } from "./context-retrieval.js";

describe("context-retrieval", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "wai-context-"));
    mkdirSync(join(cwd, "src"), { recursive: true });
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

  it("cleans up temp dir", () => {
    rmSync(cwd, { recursive: true, force: true });
    assert.ok(true);
  });
});
