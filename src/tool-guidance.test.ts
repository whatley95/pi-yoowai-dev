import { it } from "node:test";
import assert from "node:assert/strict";
import { WAI_TOOL_GUIDANCE, WAI_NAMESPACE, compactToolMetadata } from "./tool-guidance.js";

it("retains detailed workflow rules on demand while reducing always-present instructions", () => {
  const full = Object.entries(WAI_TOOL_GUIDANCE).reduce((sum, [, lines]) => sum + lines.join("\n").length, 0);
  const compact = Object.keys(WAI_TOOL_GUIDANCE).reduce(
    (sum, name) => sum + compactToolMetadata(name)!.promptGuidelines.join("\n").length,
    0,
  );
  assert.ok(compact < full * 0.5, `${compact} compact chars vs ${full} detailed chars`);
  for (const [name, lines] of Object.entries(WAI_TOOL_GUIDANCE)) {
    assert.equal(compactToolMetadata(name)?.namespace, WAI_NAMESPACE);
    for (const line of lines) assert.ok(WAI_NAMESPACE.instructions.includes(line));
  }
  const visible = compactToolMetadata("wai")!.promptGuidelines.join("\n");
  assert.match(visible, /scoped\/historical pass/);
  assert.match(visible, /explicit user requirements/);
  assert.match(visible, /Force only on an explicit/);
  assert.match(visible, /Commit only when authorized/);
  assert.match(visible, /reviewPending|completedSteps/);
  assert.match(visible, /wai_index\(\{topic:'guidance'\}\)/);
  assert.match(visible, /Default to med/);
  assert.match(visible, /high for a concrete/);
  assert.match(visible, /model family, and thinking level alone.*do not justify high/s);
  assert.equal(compactToolMetadata("another-extension"), undefined);
});

it("documents native image blocks and bounded knowledge without replacing evidence", () => {
  assert.match(WAI_NAMESPACE.instructions, /models\.generateImages/);
  assert.match(WAI_NAMESPACE.instructions, /tools\.wai_vision\(\{image:block/);
  assert.match(WAI_NAMESPACE.instructions, /Never print\/store base64/);
  assert.match(WAI_NAMESPACE.instructions, /not evidence/);
  assert.match(WAI_NAMESPACE.instructions, /Memory is context, not verified evidence/);
});
