import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isFileWriteTool } from "./file-write-tools.js";

describe("isFileWriteTool", () => {
  it("matches Pi's built-in file-mutating tools", () => {
    // Verified against @earendil-works/pi-coding-agent core tools
    // (packages/coding-agent/src/core/tools: read, write, edit, bash, find, grep, ls).
    assert.equal(isFileWriteTool("write"), true);
    assert.equal(isFileWriteTool("edit"), true);
  });

  it("matches known aliases case-insensitively", () => {
    assert.equal(isFileWriteTool("writeFile"), true);
    assert.equal(isFileWriteTool("EditFile"), true);
    assert.equal(isFileWriteTool("applyPatch"), true);
  });

  it("rejects read-only and unrelated tools", () => {
    for (const name of ["read", "readFile", "bash", "grep", "glob", "find", "ls", "wai", "createPlan"]) {
      assert.equal(isFileWriteTool(name), false, name);
    }
  });
});
