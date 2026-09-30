import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasSuccessfulFileEdit, isFileWriteTool } from "./file-write-tools.js";

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

describe("hasSuccessfulFileEdit", () => {
  it("recognizes successful nested edits even when the enclosing script fails", () => {
    assert.equal(hasSuccessfulFileEdit({ toolName: "write", isError: false }), true);
    assert.equal(hasSuccessfulFileEdit({ toolName: "edit", isError: true }), false);
    assert.equal(
      hasSuccessfulFileEdit({
        toolName: "codemode",
        isError: true,
        nestedCalls: { calls: [{ name: "write", status: "ok" }], complete: false },
      }),
      true,
    );
  });

  it("ignores failed, unfinished, read-only, absent, and malformed nested records", () => {
    for (const nestedCalls of [
      undefined,
      null,
      { calls: null },
      { calls: [null, {}, { name: 42, status: "ok" }] },
      { calls: [{ name: "write", status: "error" }] },
      { calls: [{ name: "edit", status: "unfinished" }] },
      { calls: [{ name: "read", status: "ok" }] },
    ]) {
      assert.equal(hasSuccessfulFileEdit({ toolName: "codemode", isError: false, nestedCalls }), false);
    }
  });
});
