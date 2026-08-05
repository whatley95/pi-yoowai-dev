import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProgressReporter, clearWaiStatus } from "./progress.js";

function fakeCtx(): { ctx: ExtensionContext; statuses: (string | undefined)[] } {
  const statuses: (string | undefined)[] = [];
  const ctx = {
    ui: {
      setStatus: (_id: string, text: string | undefined) => {
        statuses.push(text);
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, statuses };
}

describe("progress reporter ticker", () => {
  afterEach(() => {
    mock.timers.reset();
  });

  it("refreshes the status while a stage is active", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { ctx, statuses } = fakeCtx();
    const progress = createProgressReporter("review", ctx);
    progress(3, 10, "Working…");
    mock.timers.tick(3000);
    assert.ok(
      statuses.filter((s) => typeof s === "string" && s.includes("Working…")).length >= 2,
      `expected repeated status renders, got ${JSON.stringify(statuses)}`,
    );
    clearWaiStatus(ctx);
  });

  it("clearWaiStatus stops a leaked ticker so it cannot resurrect the status", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { ctx, statuses } = fakeCtx();
    const progress = createProgressReporter("review", ctx);
    // Early-return path: never emits the terminal stage.
    progress(3, 10, "Using cached review result…");
    clearWaiStatus(ctx);
    statuses.length = 0;
    mock.timers.tick(5000);
    assert.deepEqual(statuses, []);
  });

  it("terminal stage stops the ticker", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { ctx, statuses } = fakeCtx();
    const progress = createProgressReporter("review", ctx);
    progress(3, 10, "Working…");
    progress(10, 10, "Done");
    statuses.length = 0;
    mock.timers.tick(3000);
    assert.deepEqual(statuses, []);
  });

  it("stopping one reporter's ticker does not affect another reporter on the same ctx", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { ctx, statuses } = fakeCtx();
    const a = createProgressReporter("review", ctx);
    const b = createProgressReporter("security", ctx);
    a(3, 10, "Review working…");
    b(5, 10, "Security working…");
    a(10, 10, "Review done");
    statuses.length = 0;
    mock.timers.tick(2000);
    assert.ok(
      statuses.every((s) => typeof s === "string" && s.includes("Security working…")),
      `only security ticks expected, got ${JSON.stringify(statuses)}`,
    );
    clearWaiStatus(ctx);
  });

  it("shows the level in the status line and carries it in update details", () => {
    const { ctx, statuses } = fakeCtx();
    const updates: Array<{ details: Record<string, unknown> }> = [];
    const progress = createProgressReporter(
      "review",
      ctx,
      (u) => {
        updates.push(u as { details: Record<string, unknown> });
      },
      "med",
    );
    progress(3, 10, "Working…");
    assert.ok(
      statuses.some((s) => typeof s === "string" && s.startsWith("(med) [3/10]")),
      `expected level-prefixed status, got ${JSON.stringify(statuses)}`,
    );
    assert.equal(updates[0]?.details.level, "med");
    assert.equal(updates[0]?.details.inProgress, true);
    progress(10, 10, "Done");
    assert.equal(updates[updates.length - 1]?.details.level, "med");
    assert.equal(updates[updates.length - 1]?.details.inProgress, false);
    clearWaiStatus(ctx);
  });

  it("omits the level from status and details when none is passed", () => {
    const { ctx, statuses } = fakeCtx();
    const updates: Array<{ details: Record<string, unknown> }> = [];
    const progress = createProgressReporter("review", ctx, (u) => {
      updates.push(u as { details: Record<string, unknown> });
    });
    progress(3, 10, "Working…");
    assert.ok(
      statuses.some((s) => typeof s === "string" && s.startsWith("[3/10]")),
      JSON.stringify(statuses),
    );
    assert.ok(
      statuses.every((s) => typeof s !== "string" || !s.includes("(")),
      JSON.stringify(statuses),
    );
    assert.equal(updates[0]?.details.level, undefined);
    progress(10, 10, "Done");
    clearWaiStatus(ctx);
  });
});
