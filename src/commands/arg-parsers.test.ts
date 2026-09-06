import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseReviewCommandArgs, parseLearnCommandArgs } from "./arg-parsers.js";

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

describe("parseLearnCommandArgs", () => {
  it("parses a plain fact with optional category", () => {
    const r = parseLearnCommandArgs("Auth uses Clerk.");
    assert.equal(r.kind, "record");
    assert.equal((r as { fact?: string }).fact, "Auth uses Clerk.");
    const withCat = parseLearnCommandArgs("Use camelCase --category conventions");
    assert.equal(withCat.kind, "record");
    assert.equal((withCat as { fact?: string }).fact, "Use camelCase");
    assert.equal((withCat as { category?: string }).category, "conventions");
  });

  it("parses --stale with a quoted multi-word query", () => {
    const r = parseLearnCommandArgs('--stale --query "old dependency"');
    assert.equal(r.kind, "stale");
    assert.equal((r as { staleQuery?: string }).staleQuery, "old dependency");
    const bare = parseLearnCommandArgs("--stale");
    assert.equal(bare.kind, "stale");
    assert.equal((bare as { staleQuery?: string }).staleQuery, undefined);
  });

  it("parses --verify [--deep] with query", () => {
    const r = parseLearnCommandArgs("--verify --query auth");
    assert.equal(r.kind, "verify");
    assert.equal((r as { deep?: boolean }).deep, false);
    assert.equal((r as { query?: string }).query, "auth");
    const deep = parseLearnCommandArgs("--verify --deep --query auth");
    assert.equal(deep.kind, "verify");
    assert.equal((deep as { deep?: boolean }).deep, true);
    assert.equal((deep as { query?: string }).query, "auth");
    // Verbatim-positional input is rejected in verify/stale modes.
    const verbatim = parseLearnCommandArgs("--verify unexpected");
    assert.equal(verbatim.kind, "invalid");
    assert.match((verbatim as { invalidReason?: string }).invalidReason ?? "", /Unexpected positional argument\(s\)/);
    const staleVerbatim = parseLearnCommandArgs("--stale unexpected");
    assert.equal(staleVerbatim.kind, "invalid");
    assert.match(
      (staleVerbatim as { invalidReason?: string }).invalidReason ?? "",
      /Unexpected positional argument\(s\)/,
    );
    // Duplicate action flags are conflicts/repeats, not tolerated.
    assert.match(
      (parseLearnCommandArgs("--verify --verify") as { invalidReason?: string }).invalidReason ?? "",
      /Conflicting|Repeated/,
    );
  });

  it("parses --reaffirm with the exact remaining text", () => {
    const r = parseLearnCommandArgs("--reaffirm Never update the lockfile.");
    assert.equal(r.kind, "reaffirm");
    assert.equal((r as { reaffirmFact?: string }).reaffirmFact, "Never update the lockfile.");
  });

  it("rejects conflicting actions and unknown flags", () => {
    const conflict = parseLearnCommandArgs("--verify --stale");
    assert.equal(conflict.kind, "invalid");
    assert.match((conflict as { invalidReason?: string }).invalidReason ?? "", /Conflicting/);
    const unknown = parseLearnCommandArgs("--bogus fact");
    assert.equal(unknown.kind, "invalid");
    const reaffirmExtra = parseLearnCommandArgs("--reaffirm x --deep");
    assert.equal(reaffirmExtra.kind, "invalid");
    const empty = parseLearnCommandArgs("--query");
    assert.equal(empty.kind, "invalid");
    assert.equal(parseLearnCommandArgs("").kind, "invalid");
    assert.equal(parseLearnCommandArgs("   ").kind, "invalid");
    assert.equal(parseLearnCommandArgs('--verify --query ""').kind, "invalid");
    assert.equal(parseLearnCommandArgs('fact --category ""').kind, "invalid");
    assert.equal(parseLearnCommandArgs('--reaffirm ""').kind, "invalid");
    assert.equal(parseLearnCommandArgs('""').kind, "invalid");
    assert.equal(parseLearnCommandArgs('"   "').kind, "invalid", "quoted whitespace is an empty fact");
  });

  it("rejects repeated flags (query/category/deep)", () => {
    assert.match(
      (parseLearnCommandArgs("--verify --query first --query second") as { invalidReason?: string }).invalidReason ??
        "",
      /Repeated/,
    );
    assert.match(
      (parseLearnCommandArgs("--verify --deep --deep") as { invalidReason?: string }).invalidReason ?? "",
      /Repeated/,
    );
    assert.match(
      (parseLearnCommandArgs("fact --category a --category b") as { invalidReason?: string }).invalidReason ?? "",
      /Repeated/,
    );
    // Actions must be the FIRST token (option-first input is rejected).
    assert.equal(parseLearnCommandArgs("--query auth --verify").kind, "invalid");
    assert.equal(parseLearnCommandArgs("--query auth --stale").kind, "invalid");
    assert.equal(parseLearnCommandArgs("--deep --verify").kind, "invalid");
  });

  it("rejects mode-incompatible and unknown flags", () => {
    assert.equal(parseLearnCommandArgs("--verify --bogus").kind, "invalid");
    assert.equal(parseLearnCommandArgs("--stale --category x").kind, "invalid");
    assert.equal(parseLearnCommandArgs("--verify --stale").kind, "invalid");
    assert.equal(parseLearnCommandArgs("--deep only").kind, "invalid");
    assert.equal(parseLearnCommandArgs("fact --verbose").kind, "invalid");
    assert.equal(parseLearnCommandArgs("unexpected --reaffirm exact fact").kind, "invalid", "--reaffirm must be first");
  });

  it("rejects missing or flag-like values", () => {
    assert.equal(parseLearnCommandArgs("--verify --query").kind, "invalid");
    assert.equal(parseLearnCommandArgs("--verify --query --deep").kind, "invalid");
    assert.equal(parseLearnCommandArgs("--stale --query").kind, "invalid");
    assert.equal(parseLearnCommandArgs("fact --category").kind, "invalid");
    assert.equal(parseLearnCommandArgs("--category").kind, "invalid");
    assert.equal(parseLearnCommandArgs("--category web").kind, "invalid", "category alone has no fact");
  });

  it("handles quoted values for category, query, and reaffirm", () => {
    const cat = parseLearnCommandArgs('Use namespaces --category "team conventions"');
    assert.equal(cat.kind, "record");
    assert.equal((cat as { fact?: string }).fact, "Use namespaces");
    assert.equal((cat as { category?: string }).category, "team conventions");
    // The category value may equal a fact word — the consumed token is the
    // one right after --category, never an earlier equal-looking positional.
    const tricky = parseLearnCommandArgs("same --category same");
    assert.equal(tricky.kind, "record");
    assert.equal((tricky as { fact?: string }).fact, "same");
    assert.equal((tricky as { category?: string }).category, "same");
    const reaffirm = parseLearnCommandArgs('--reaffirm "exact stored fact"');
    assert.equal(reaffirm.kind, "reaffirm");
    assert.equal((reaffirm as { reaffirmFact?: string }).reaffirmFact, "exact stored fact");
  });
});
