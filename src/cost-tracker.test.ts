import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatCost } from "./cost-tracker.js";

describe("formatCost", () => {
  it("formats cents for small costs", () => {
    assert.equal(formatCost(0.0005), "0.50¢");
    assert.equal(formatCost(0.0009), "0.90¢");
  });

  it("formats dollars for costs above 0.001", () => {
    assert.equal(formatCost(0.01), "$0.0100");
    assert.equal(formatCost(1.5), "$1.5000");
  });

  it("handles zero", () => {
    assert.equal(formatCost(0), "0.00¢");
  });
});
