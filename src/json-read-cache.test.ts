import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCachedJson, invalidateJsonReadCache } from "./json-read-cache.js";

it("avoids parsing unchanged JSON and isolates mutations from the cached value", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wai-json-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  writeFileSync(path, '{"items":["original"]}');
  const parse = t.mock.method(JSON, "parse");
  const first = readCachedJson(path) as { items: string[] };
  first.items.push("caller mutation");
  assert.deepEqual(readCachedJson(path), { items: ["original"] });
  assert.equal(parse.mock.callCount(), 1);
  invalidateJsonReadCache(path);
  readCachedJson(path);
  assert.equal(parse.mock.callCount(), 2);
});

it("detects immediate same-size edits, removal, recreation, and corrupt JSON without returning stale data", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wai-json-changes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  writeFileSync(path, '{"n":1}');
  readCachedJson(path);
  const original = statSync(path);
  // No delay: freshness must not depend on timestamp resolution.
  writeFileSync(path, '{"n":2}');
  utimesSync(path, original.atime, original.mtime);
  assert.deepEqual(readCachedJson(path), { n: 2 });
  rmSync(path);
  assert.throws(() => readCachedJson(path));
  writeFileSync(path, '{"n":3}');
  assert.deepEqual(readCachedJson(path), { n: 3 });
  writeFileSync(path, "invalid");
  assert.equal(statSync(path).size, original.size);
  utimesSync(path, original.atime, original.mtime);
  assert.throws(() => readCachedJson(path));
  writeFileSync(path, '{"n":4}');
  assert.deepEqual(readCachedJson(path), { n: 4 });
});
