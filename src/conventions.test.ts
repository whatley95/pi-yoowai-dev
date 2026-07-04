import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferNaming, inferStack, inferBuildTool, gatherDeepScanSamples } from "./conventions.js";

describe("convention inference", () => {
  it("detects camelCase naming", () => {
    assert.ok(inferNaming(["src/getUser.ts"]).includes("camelCase"));
  });

  it("detects PascalCase naming", () => {
    assert.equal(inferNaming(["src/UserCard.tsx"]), "PascalCase");
  });

  it("detects mixed naming", () => {
    const result = inferNaming(["src/getUser.ts", "src/UserCard.tsx"]);
    assert.ok(result.includes("camelCase"));
    assert.ok(result.includes("PascalCase"));
  });

  it("detects TypeScript stack", () => {
    const result = inferStack(["src/index.ts"], ".", { dependencies: {} });
    assert.ok(result.includes("TypeScript"));
  });

  it("detects React stack", () => {
    const result = inferStack(["src/App.tsx"], ".", { dependencies: { react: "^18" } });
    assert.ok(result.includes("React"));
  });

  it("detects Vite build tool", () => {
    const result = inferBuildTool(["vite.config.ts"], { dependencies: {} });
    assert.equal(result, "vite");
  });

  it("gathers deep scan samples from entry points and source files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-heyyoo-deep-scan-"));
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ main: "src/index.ts" }), "utf-8");
    writeFileSync(join(cwd, "src/index.ts"), "export function main() {\n  return 1;\n}\n", "utf-8");
    writeFileSync(join(cwd, "src/util.ts"), "export const x = 1;\n", "utf-8");
    writeFileSync(join(cwd, "src/util.test.ts"), "test('x', () => {});\n", "utf-8");

    const samples = gatherDeepScanSamples(cwd, ["src/index.ts", "src/util.ts", "src/util.test.ts"], 5);
    const files = samples.map((s) => s.file);
    assert.ok(files.includes("src/index.ts"));
    assert.ok(files.includes("src/util.ts"));
    assert.ok(files.includes("src/util.test.ts"));
  });

  it("caps deep scan samples at maxFiles", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-heyyoo-deep-scan-limit-"));
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src/a.ts"), "export const a = 1;\n", "utf-8");
    writeFileSync(join(cwd, "src/b.ts"), "export const b = 1;\n", "utf-8");
    writeFileSync(join(cwd, "src/c.ts"), "export const c = 1;\n", "utf-8");

    const samples = gatherDeepScanSamples(cwd, ["src/a.ts", "src/b.ts", "src/c.ts"], 2);
    assert.equal(samples.length, 2);
  });
});
