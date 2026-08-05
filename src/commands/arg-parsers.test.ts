import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseReviewCommandArgs } from "./arg-parsers.js";

describe("parseReviewCommandArgs", () => {
  it("parses a description and default options", () => {
    const result = parseReviewCommandArgs("review these changes");
    assert.equal(result.description, "review these changes");
    assert.deepEqual(result.options, {});
  });

  it("parses --level and -l", () => {
    const longForm = parseReviewCommandArgs("--level high review this");
    assert.equal(longForm.options.level, "high");

    const shortForm = parseReviewCommandArgs("-l min review this");
    assert.equal(shortForm.options.level, "min");
  });

  it("ignores invalid level values", () => {
    const result = parseReviewCommandArgs("--level extreme review this");
    assert.equal(result.options.level, undefined);
  });

  it("keeps the level out of the description", () => {
    const result = parseReviewCommandArgs("--level med check it");
    assert.equal(result.description, "check it");
    assert.equal(result.options.level, "med");
  });
});
