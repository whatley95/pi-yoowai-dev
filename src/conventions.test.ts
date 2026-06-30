import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferNaming, inferStack, inferBuildTool } from "./conventions.js";

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
});
