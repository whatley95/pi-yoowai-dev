import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLoopDetectionState, recordToolCall, checkLoop, shouldSendSteer } from "./loop-detector.js";

function makeEvent(toolName: string, args: Record<string, unknown>) {
  return { toolName, args };
}

describe("loop-detector", () => {
  it("does not flag short history", () => {
    const state = createLoopDetectionState();
    recordToolCall(state, makeEvent("yoo", { review: "check this" }));
    recordToolCall(state, makeEvent("yoo", { review: "check this" }));
    assert.equal(checkLoop(state), null);
  });

  it("detects repeated yoo.review without edits", () => {
    const state = createLoopDetectionState();
    for (let i = 0; i < 5; i++) {
      recordToolCall(state, makeEvent("yoo", { review: "check this" }));
    }
    const loop = checkLoop(state);
    assert.ok(loop);
    assert.match(loop!.message, /LOOP DETECTED/);
  });

  it("breaks identical-description streak when action changes", () => {
    const state = createLoopDetectionState();
    recordToolCall(state, makeEvent("yoo", { review: "same" }));
    recordToolCall(state, makeEvent("edit", { path: "x" }));
    recordToolCall(state, makeEvent("yoo", { review: "same" }));
    recordToolCall(state, makeEvent("edit", { path: "x" }));
    recordToolCall(state, makeEvent("yoo", { judge: "same" }));
    assert.equal(checkLoop(state), null);
  });

  it("detects identical description repeated 3+ times", () => {
    const state = createLoopDetectionState();
    recordToolCall(state, makeEvent("read_file", { path: "src/a.ts" }));
    recordToolCall(state, makeEvent("yoo", { plan: "implement feature" }));
    recordToolCall(state, makeEvent("yoo", { plan: "implement feature" }));
    recordToolCall(state, makeEvent("yoo", { plan: "implement feature" }));
    const loop = checkLoop(state);
    assert.ok(loop);
    assert.match(loop!.message, /repeating the same yoo call/);
  });

  it("rate-limits repeated steers", () => {
    const state = createLoopDetectionState();
    const loop = { looping: true, message: "LOOP DETECTED: fix it" };
    assert.ok(shouldSendSteer(state, loop));
    assert.ok(!shouldSendSteer(state, loop));
  });
});
