import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { continuationMeta, retryStitchedParse } from "./shared.js";
import type { UsageCost } from "../types.js";

function zeroUsage(): UsageCost {
  return { estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedCostUsd: 0, sessionCostUsd: 0 };
}

describe("continuationMeta", () => {
  it("returns undefined when no rounds ran and output is not truncated", () => {
    assert.equal(continuationMeta(undefined, false), undefined);
    assert.equal(continuationMeta(0, false), undefined);
  });

  it("returns truncated-after-cap with 0 rounds when output is truncated without continuation", () => {
    assert.deepEqual(continuationMeta(0, true), { rounds: 0, status: "truncated-after-cap" });
  });

  it("returns stitched status when rounds ran and output is complete", () => {
    assert.deepEqual(continuationMeta(2, false), { rounds: 2, status: "stitched" });
  });

  it("returns truncated-after-cap when rounds ran but output is still truncated", () => {
    assert.deepEqual(continuationMeta(3, true), { rounds: 3, status: "truncated-after-cap" });
  });
});

describe("retryStitchedParse", () => {
  let cwd: string;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "shared-retry-"));
  });

  it("appends retry content after stripping an overlapping tail", async () => {
    const raw = "start text and hello";
    const callModel = async () => ({ content: "hello world end", usage: zeroUsage() });
    const result = await retryStitchedParse(cwd, raw, undefined, callModel);
    assert.ok(result);
    assert.equal(result!.raw, "start text and hello world end");
  });

  it("returns raw unchanged and records usage when retry content is empty", async () => {
    const raw = "start text and hello";
    const callModel = async () => ({ content: "   ", usage: zeroUsage() });
    const result = await retryStitchedParse(cwd, raw, undefined, callModel);
    assert.ok(result);
    assert.equal(result!.raw, raw);
  });

  it("returns null when the retry call fails", async () => {
    const raw = "start text";
    const callModel = async () => {
      throw new Error("model error");
    };
    const result = await retryStitchedParse(cwd, raw, undefined, callModel);
    assert.equal(result, null);
  });

  it("throws when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const callModel = async () => ({ content: "more", usage: zeroUsage() });
    await assert.rejects(() => retryStitchedParse(cwd, "start", controller.signal, callModel), /Aborted/);
  });
});
