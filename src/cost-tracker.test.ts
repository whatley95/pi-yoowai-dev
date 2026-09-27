import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCost, reserveCost, releaseCost, getReservedCost, getSessionCost, recordCost } from "./cost-tracker.js";
import { mergeUsageCost } from "./actions/shared.js";

const cwd = mkdtempSync(join(tmpdir(), "wai-cost-reservation-"));
after(() => rmSync(cwd, { recursive: true, force: true }));

it("budget admission includes existing reservations and rejected calls reserve nothing", () => {
  reserveCost(cwd, 0.6, 1);
  assert.throws(() => reserveCost(cwd, 0.5, 1), /budget/);
  assert.equal(getReservedCost(cwd), 0.6);
  releaseCost(cwd, 0.6);
  assert.equal(getReservedCost(cwd), 0);
});

it("settled backend usage and its merged result are recorded exactly once", () => {
  const usage = (cost: number) => ({
    estimatedInputTokens: 10,
    estimatedOutputTokens: 5,
    estimatedCostUsd: cost,
    sessionCostUsd: 0,
  });
  const a = recordCost(cwd, usage(0.1));
  const b = recordCost(cwd, usage(0.2));
  const merged = mergeUsageCost(a, b);
  recordCost(cwd, merged);
  recordCost(cwd, a);
  assert.equal(getSessionCost(cwd).calls, 2);
  assert.equal(getSessionCost(cwd).inputTokens, 20);
  assert.equal(getSessionCost(cwd).outputTokens, 10);
  assert.ok(Math.abs(getSessionCost(cwd).costUsd - 0.3) < 1e-10);
  assert.throws(() => reserveCost(cwd, 0.8, 1), /budget/);
});

describe("formatCost", () => {
  it("formats cents for small costs", () => {
    assert.equal(formatCost(0.0005), "0.05¢");
    assert.equal(formatCost(0.0009), "0.09¢");
  });

  it("formats dollars for costs above 0.001", () => {
    assert.equal(formatCost(0.01), "$0.0100");
    assert.equal(formatCost(1.5), "$1.5000");
  });

  it("handles zero", () => {
    assert.equal(formatCost(0), "0.00¢");
  });
});
