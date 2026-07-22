import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAstContext } from "./ast-context.js";

describe("ast-context", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "wai-ast-"));
    mkdirSync(join(cwd, "src"), { recursive: true });
  });

  it("returns imported symbol declarations when tsconfig exists", () => {
    writeFileSync(
      join(cwd, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler" } }),
      "utf-8",
    );
    writeFileSync(
      join(cwd, "src", "utils.ts"),
      "export function helper(name: string): string { return `Hello, ${name}`; }\n",
      "utf-8",
    );
    writeFileSync(
      join(cwd, "src", "main.ts"),
      "import { helper } from './utils';\nexport const msg = helper('world');\n",
      "utf-8",
    );

    const context = buildAstContext(cwd, ["src/main.ts"]);
    assert.match(context, /helper/);
    assert.match(context, /function helper/);
  });

  it("returns empty string when no tsconfig exists", () => {
    writeFileSync(join(cwd, "src", "a.ts"), "export const x = 1;", "utf-8");
    const context = buildAstContext(cwd, ["src/a.ts"]);
    assert.equal(context, "");
  });

  it("cleans up temp dir", () => {
    rmSync(cwd, { recursive: true, force: true });
    assert.ok(true);
  });
});
