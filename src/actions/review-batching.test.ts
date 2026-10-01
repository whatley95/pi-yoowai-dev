import { test } from "node:test";
import assert from "node:assert/strict";
import { groupRelatedReviewFiles } from "./review-batching.js";
import { runWithConcurrencyLimit } from "./review-helpers.js";

const files = [
  { file: "src/jobs.ts", content: "export const job = 1;" },
  { file: "src/jobs.spec.ts", content: "import { job } from './jobs.js';" },
  { file: "src/caller.ts", content: "import { job } from './jobs.js';" },
  { file: "src/unrelated.ts", content: "export const other = 2;" },
];

test("groups related sources and tests without dropping unrelated files", () => {
  const groups = groupRelatedReviewFiles(files, 3, () => true);
  assert.deepEqual(
    groups.map((group) => group.map((file) => file.file)),
    [files.slice(0, 3).map((file) => file.file), [files[3].file]],
  );
  assert.deepEqual(groups.flat(), files);
});

test("preserves separate calls when grouping is disabled or complete evidence does not fit", () => {
  assert.equal(groupRelatedReviewFiles(files, 1, () => true).length, 4);
  assert.equal(groupRelatedReviewFiles(files, 3, () => false).length, 4);
  assert.deepEqual(
    groupRelatedReviewFiles(files, 2, () => true).map((group) => group.length),
    [2, 1, 1],
  );
});

test("cancellation records every unstarted review batch instead of leaving array holes", async () => {
  const controller = new AbortController();
  let ran = 0;
  const tasks = Array.from({ length: 3 }, () => async () => {
    ran++;
    controller.abort();
    return "completed";
  });
  const outcomes = await runWithConcurrencyLimit(tasks, 1, controller.signal);
  assert.equal(ran, 1);
  assert.equal(outcomes.length, 3);
  assert.deepEqual(outcomes[0], { ok: true, value: "completed" });
  for (const outcome of outcomes.slice(1)) {
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(String(outcome.error), /aborted/);
  }
});
