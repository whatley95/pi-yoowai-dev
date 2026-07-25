import test from "node:test";
import assert from "node:assert";
import { councilMemberKey, formatCouncilMember, addCouncilMember } from "./council-members.js";

test("councilMemberKey parses provider/id strings", () => {
  assert.equal(councilMemberKey("openai/gpt-5-mini"), "openai/gpt-5-mini");
  assert.equal(councilMemberKey("openai/gpt-5-mini".toUpperCase()), "openai/gpt-5-mini");
  assert.equal(councilMemberKey("  anthropic/claude-sonnet-4-6  "), "anthropic/claude-sonnet-4-6");
});

test("councilMemberKey parses object entries", () => {
  assert.equal(councilMemberKey({ provider: "openai", id: "gpt-5-mini" }), "openai/gpt-5-mini");
  assert.equal(councilMemberKey({ provider: "OpenAI", id: "GPT-5-Mini" }), "openai/gpt-5-mini");
});

test("councilMemberKey rejects malformed entries", () => {
  assert.equal(councilMemberKey(""), undefined);
  assert.equal(councilMemberKey("   "), undefined);
  assert.equal(councilMemberKey(42), undefined);
  assert.equal(councilMemberKey(null), undefined);
  assert.equal(councilMemberKey({ provider: "openai" }), undefined);
  assert.equal(councilMemberKey({ id: 7 }), undefined);
  assert.equal(councilMemberKey(["openai/gpt-5-mini"]), undefined);
});

test("formatCouncilMember renders provider:id", () => {
  assert.equal(formatCouncilMember("openai/gpt-5-mini"), "openai/gpt-5-mini");
  assert.equal(formatCouncilMember({ provider: "openai", id: "gpt-5-mini" }), "openai:gpt-5-mini");
  assert.equal(
    formatCouncilMember({ provider: "openai", id: "gpt-5-mini", thinking: "high" }),
    "openai:gpt-5-mini · high",
  );
  assert.equal(formatCouncilMember({ thinking: "high" }), "(invalid entry)");
  assert.equal(formatCouncilMember(42), "(invalid entry)");
});

test("addCouncilMember appends new members and dedups by key", () => {
  const start: unknown[] = ["openai/gpt-5-mini"];
  const dup = addCouncilMember(start, { provider: "openai", id: "gpt-5-mini" });
  assert.equal(dup.added, false);
  assert.equal(dup.list.length, 1);

  const added = addCouncilMember(start, "anthropic/claude-sonnet-4-6");
  assert.equal(added.added, true);
  assert.deepEqual(added.list, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4-6"]);
  // The original list is not mutated.
  assert.equal(start.length, 1);

  const invalid = addCouncilMember(start, { provider: "openai" });
  assert.equal(invalid.added, false);
});
