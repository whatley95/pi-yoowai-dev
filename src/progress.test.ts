import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanupProgressReporter, createProgressReporter, clearWaiStatus } from "./progress.js";

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

  it("clearWaiStatus tears down concurrent reporters with one final status clear", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { ctx, statuses } = fakeCtx();
    const a = createProgressReporter("review", ctx);
    const b = createProgressReporter("security", ctx);
    a(1, 3, "A working");
    b(1, 3, "B working");

    statuses.length = 0;
    clearWaiStatus(ctx);
    assert.deepEqual(statuses, [undefined], "global teardown must not re-render a surviving reporter");
    statuses.length = 0;
    a(2, 3, "Late A update");
    b(2, 3, "Late B update");
    assert.deepEqual(statuses, [], "cleared reporters must ignore late callbacks");
    mock.timers.tick(3000);
    assert.deepEqual(statuses, []);
  });

  it("terminal stage stops the ticker", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { ctx, statuses } = fakeCtx();
    const progress = createProgressReporter("review", ctx);
    progress(3, 10, "Working…");
    progress(10, 10, "Done");
    const afterCompletion = [...statuses];
    progress(1, 10, "Late update");
    assert.deepEqual(statuses, afterCompletion, "a completed reporter must ignore late updates");
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
    assert.ok(statuses.length > 0, "the surviving reporter must continue to tick");
    assert.ok(
      statuses.every((s) => typeof s === "string" && s.includes("Security working…")),
      `only security ticks expected, got ${JSON.stringify(statuses)}`,
    );
    clearWaiStatus(ctx);
  });

  it("restores the most recently rendered reporter when a different reporter completes", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { ctx, statuses } = fakeCtx();
    const a = createProgressReporter("review", ctx);
    const b = createProgressReporter("review", ctx);
    const c = createProgressReporter("review", ctx);
    a(1, 3, "A initial");
    b(1, 3, "B working");
    c(1, 3, "C working");
    a(2, 3, "A latest");

    b(3, 3, "B done");
    assert.ok(statuses.at(-1)?.includes("A latest"), `expected A to be restored, got ${JSON.stringify(statuses)}`);
    statuses.length = 0;
    mock.timers.tick(3000);
    assert.ok(statuses.length > 0, "the restored reporter must continue to tick");
    assert.ok(
      statuses.every((status) => status?.includes("A latest")),
      `only the restored owner may update, got ${JSON.stringify(statuses)}`,
    );
    clearWaiStatus(ctx);
  });

  it("cleanup stops only its reporter and ignores repeated or late callbacks", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { ctx, statuses } = fakeCtx();
    const a = createProgressReporter("vision", ctx);
    const b = createProgressReporter("vision", ctx);
    a(1, 3, "Loading input…");
    b(2, 3, "Calling model…");

    cleanupProgressReporter(a);
    cleanupProgressReporter(a);
    const afterCleanup = [...statuses];
    a(2, 3, "Late update");
    assert.deepEqual(statuses, afterCleanup, "a disposed reporter must ignore late updates immediately");

    statuses.length = 0;
    mock.timers.tick(3000);
    assert.ok(statuses.length > 0, "the surviving reporter must continue to tick");
    assert.ok(
      statuses.every((s) => typeof s === "string" && s.includes("Calling model…")),
      `only the surviving reporter may update, got ${JSON.stringify(statuses)}`,
    );

    cleanupProgressReporter(b);
    cleanupProgressReporter(b);
    const afterSecondCleanup = [...statuses];
    b(3, 3, "Late completion");
    assert.deepEqual(statuses, afterSecondCleanup, "a disposed reporter must ignore a late completion immediately");

    statuses.length = 0;
    mock.timers.tick(3000);
    assert.deepEqual(statuses, []);
  });

  it("cleanup preserves the survivor when identical reporters stop in reverse order", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { ctx, statuses } = fakeCtx();
    const a = createProgressReporter("vision", ctx);
    const b = createProgressReporter("vision", ctx);
    a(1, 3, "A working");
    b(1, 3, "B working");

    cleanupProgressReporter(b);
    assert.ok(statuses.at(-1)?.includes("A working"), "cleanup of B must immediately restore A's status");
    statuses.length = 0;
    mock.timers.tick(3000);
    assert.ok(statuses.length > 0, "the first reporter must survive reverse-order cleanup");
    assert.ok(
      statuses.every((status) => status?.includes("A working")),
      `only A may update after B is cleaned up, got ${JSON.stringify(statuses)}`,
    );

    cleanupProgressReporter(a);
    assert.equal(statuses.at(-1), undefined, "cleanup of A must clear the final status");
    statuses.length = 0;
    mock.timers.tick(3000);
    assert.deepEqual(statuses, []);
  });

  it("does not start a ticker when an update callback cleans up the reporter", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { ctx, statuses } = fakeCtx();
    const reporter = createProgressReporter("vision", ctx, () => cleanupProgressReporter(reporter));

    reporter(1, 3, "Loading input…");
    statuses.length = 0;
    mock.timers.tick(3000);
    assert.deepEqual(statuses, []);
  });

  it("does not start a ticker when an update callback clears all reporters", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { ctx, statuses } = fakeCtx();
    const reporter = createProgressReporter("vision", ctx, () => clearWaiStatus(ctx));

    reporter(1, 3, "Loading input…");
    statuses.length = 0;
    mock.timers.tick(3000);
    assert.deepEqual(statuses, []);
  });

  it("removes a reporter when its update callback throws", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { ctx, statuses } = fakeCtx();
    const survivor = createProgressReporter("review", ctx);
    const failing = createProgressReporter("vision", ctx, () => {
      throw new Error("update failed");
    });
    survivor(1, 3, "Survivor working");
    assert.throws(() => failing(1, 3, "Failed update"), /update failed/);

    statuses.length = 0;
    mock.timers.tick(3000);
    assert.ok(statuses.length > 0, "the surviving reporter must keep ticking");
    assert.ok(
      statuses.every((status) => status?.includes("Survivor working")),
      `the failed reporter must not be restored, got ${JSON.stringify(statuses)}`,
    );
    clearWaiStatus(ctx);
  });

  it("cleanup is a no-op for an injected callback and before a reporter starts", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { ctx, statuses } = fakeCtx();
    const reporter = createProgressReporter("vision", ctx);
    cleanupProgressReporter(reporter);
    cleanupProgressReporter(() => {});
    const afterCleanup = [...statuses];
    reporter(1, 3, "Late update");
    assert.deepEqual(statuses, afterCleanup, "cleanup before start must make later callbacks inert");
    statuses.length = 0;
    mock.timers.tick(3000);
    assert.deepEqual(statuses, []);
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
