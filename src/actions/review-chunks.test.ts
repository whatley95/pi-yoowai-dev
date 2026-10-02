import { test } from "node:test";
import assert from "node:assert/strict";
import { splitReviewDiff, additionContainsSource } from "./review-chunks.js";

function patch(
  rows: string[],
  header = "@@ -0,0 +1,1000 @@",
  vcs = "diff --git a/app.kt b/app.kt\n--- /dev/null\n+++ b/app.kt",
) {
  return `${vcs}\n${header}\n${rows.join("\n")}\n`;
}

test("large additions retain every absolute source line with bounded overlap", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => `+val marker${i + 1} = "${"x".repeat(65)}"`);
  const chunks = splitReviewDiff(patch(rows), 2500);
  assert.ok(chunks.length > 1);
  const covered = new Map<number, string>();
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 2500);
    const start = Number(chunk.match(/^@@ -0,0 \+(\d+),(\d+) @@/m)?.[1]);
    assert.ok(start > 0);
    let line = start;
    for (const row of chunk.split("\n").filter((row) => /^\+val /.test(row))) {
      assert.equal(row, rows[line - 1]);
      covered.set(line++, row);
    }
  }
  assert.equal(covered.size, 1000);
  assert.equal(covered.get(1000), rows[999]);
});

test("packs adjacent small hunks without losing their absolute headers", () => {
  const diff =
    patch(["-before", "+after"], "@@ -1 +1 @@") +
    Array.from({ length: 30 }, (_, i) => `@@ -${i + 10} +${i + 10} @@\n-old${i}\n+new${i}\n`).join("");
  const chunks = splitReviewDiff(diff, 500);
  assert.ok(chunks.length > 1 && chunks.length < 31);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
  for (let i = 0; i < 30; i++) assert.ok(chunks.some((chunk) => chunk.split("\n").includes(`+new${i}`)));
});

test("replacement segments retain old and new coordinates and newline markers", () => {
  const rows = Array.from({ length: 100 }, (_, i) => [
    `-old${i} ${"x".repeat(25)}`,
    `+new${i} ${"y".repeat(25)}`,
  ]).flat();
  rows.push("\\ No newline at end of file");
  const chunks = splitReviewDiff(patch(rows, "@@ -50,100 +70,100 @@ function"), 1000);
  const old = new Set<number>(),
    added = new Set<number>();
  for (const chunk of chunks) {
    const match = chunk.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@ function/m)!;
    let oldLine = Number(match[1]),
      newLine = Number(match[3]);
    for (const row of chunk.slice(chunk.indexOf("@@ ")).split("\n").slice(1)) {
      if (row.startsWith("-")) {
        assert.equal(row, rows[(oldLine - 50) * 2]);
        old.add(oldLine++);
      }
      if (row.startsWith("+")) {
        assert.equal(row, rows[(newLine - 70) * 2 + 1]);
        added.add(newLine++);
      }
    }
    assert.equal(oldLine - Number(match[1]), Number(match[2]));
    assert.equal(newLine - Number(match[3]), Number(match[4]));
    assert.ok(chunk.length <= 1000);
  }
  assert.equal(old.size, 100);
  assert.equal(added.size, 100);
  assert.ok(chunks.at(-1)!.includes("+new99"));
  assert.ok(chunks.at(-1)!.includes("\\ No newline at end of file"));
});

test("SVN headers and separate hunks survive segmentation", () => {
  const header =
    "Index: app.kt\n===================================================================\n--- app.kt (revision 1)\n+++ app.kt (working copy)";
  const diff =
    patch(
      Array.from({ length: 90 }, (_, i) => `+row${i} ${"z".repeat(40)}`),
      "@@ -3,0 +3,90 @@",
      header,
    ) + "@@ -100,1 +190,1 @@\n-before\n+after\n";
  const parts = splitReviewDiff(diff, 1200);
  assert.ok(parts.every((part) => part.startsWith(header)));
  assert.ok(parts.at(-1)!.includes("+after"));
});

test("an indivisible line and unsupported oversized evidence fail before review", () => {
  assert.throws(() => splitReviewDiff(patch(["+" + "x".repeat(8000)]), 1000), /single diff line/);
  assert.throws(() => splitReviewDiff("binary property evidence".repeat(200), 1000), /no splittable text hunk/);
});

test("source deduplication requires a complete identical addition", () => {
  const content = "val first = 1\nval second = 2\n";
  const diff = patch(["+val first = 1", "+val second = 2"], "@@ -0,0 +1,2 @@");
  assert.ok(additionContainsSource(diff, content));
  assert.ok(additionContainsSource(diff, content.replaceAll("\n", "\r\n")));
  assert.ok(!additionContainsSource(diff, content + "val third = 3\n"));
  assert.ok(!additionContainsSource(diff.replace("--- /dev/null", "--- a/app.kt"), content));
  assert.ok(!additionContainsSource(diff, content.trimEnd()));
  assert.ok(additionContainsSource(diff + "\\ No newline at end of file\n", content.trimEnd()));
});
