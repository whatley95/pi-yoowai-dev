import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { captureImportFailure } from "./import-diagnostics.js";

describe("captureImportFailure", () => {
  it("extracts code and message from a MODULE_NOT_FOUND-style error", () => {
    const err = Object.assign(new Error("Cannot find module 'x'"), { code: "MODULE_NOT_FOUND" });
    const detail = captureImportFailure(err, "x");
    assert.equal(detail.code, "MODULE_NOT_FOUND");
    assert.ok(detail.message.includes("Cannot find module"));
    // Resolution either yields a path (proving where the runtime would look)
    // or an explicit "unresolvable:" note — never silently absent when the
    // runtime supports import.meta.resolve.
    assert.ok(detail.resolved);
  });

  it("reports when the specifier cannot be resolved", () => {
    const err = Object.assign(new Error("Cannot find module 'nope'"), { code: "MODULE_NOT_FOUND" });
    const detail = captureImportFailure(err, "definitely-not-a-real-package-xyz-123");
    assert.equal(detail.code, "MODULE_NOT_FOUND");
    assert.ok(detail.resolved!.startsWith("unresolvable:"), detail.resolved ?? "");
  });

  it("resolves a real specifier to a file URL", () => {
    const err = Object.assign(new Error("boom"), { code: "MODULE_NOT_FOUND" });
    const detail = captureImportFailure(err, "typescript");
    assert.match(detail.resolved ?? "", /^file:\/\//);
  });

  it("handles non-Error throws", () => {
    const detail = captureImportFailure("plain string failure", "x");
    assert.equal(detail.message, "plain string failure");
    assert.equal(detail.code, undefined);
  });

  it("handles errors without a code", () => {
    const detail = captureImportFailure(new Error("just a message"), "x");
    assert.equal(detail.code, undefined);
    assert.equal(detail.message, "just a message");
  });
});
