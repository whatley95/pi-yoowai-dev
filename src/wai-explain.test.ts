import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateWaiExplainParams } from "./wai-explain.js";
import { buildExplainPrompt } from "./prompts.js";

describe("wai-explain", () => {
  it("validates params with target", () => {
    const result = validateWaiExplainParams({ target: "src/index.ts" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.params.target, "src/index.ts");
    }
  });

  it("rejects missing target", () => {
    const result = validateWaiExplainParams({ context: "some context" });
    assert.equal(result.ok, false);
  });

  it("builds explain prompt with target and files", () => {
    const { system, user } = buildExplainPrompt(
      "export const x = 1;",
      "variable definition",
      "camelCase naming",
      "const demo in src/demo.ts:1 (exported)",
      [{ file: "src/demo.ts", content: "export const demo = 1;" }],
    );
    assert.match(system, /Explain the provided code/i);
    assert.match(user, /export const x = 1;/);
    assert.match(user, /src\/demo.ts/);
  });

  it("validates docs params", () => {
    const result = validateWaiExplainParams({
      target: "MCP",
      docs: ["pi", ""],
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.params.docs, ["pi"]);
    }
  });

  it("builds explain prompt with external docs", () => {
    const { user } = buildExplainPrompt(
      "what is MCP",
      undefined,
      undefined,
      undefined,
      undefined,
      '<external_docs>\n<doc_source name="pi">docs</doc_source>\n</external_docs>',
    );
    assert.match(user, /<external_docs>/);
    assert.match(user, /<doc_source name="pi">/);
  });
});
