import { test } from "node:test";
import assert from "node:assert/strict";
import { BENCHMARK_CASES, scoreBenchmark } from "./review-benchmark.js";
import { classifyRiskReviewLevel } from "./review-level.js";

test("risk benchmark routes the HTML injection case deeply while keeping clean controls cheap", () => {
  const levels = Object.fromEntries(
    BENCHMARK_CASES.map((fixture) => [fixture.id, classifyRiskReviewLevel("min", ["subject.js"], `+${fixture.after}`)]),
  );
  assert.equal(levels["escaping-bug"], "high");
  assert.equal(levels["escaping-clean"], "min");
  assert.equal(levels["bounds-clean"], "min");
});

test("benchmark counts misses, false alarms, latency and cost against clean controls", () => {
  const observations = BENCHMARK_CASES.map((fixture, index) => ({
    caseId: fixture.id,
    adjudicated: true,
    detectedDefectIds: index === 0 ? [] : fixture.defects.map((item) => item.id),
    falsePositiveCount: index === 1 ? 2 : 0,
    elapsedMs: (index + 1) * 10,
    costUsd: 0.01,
  }));
  const score = scoreBenchmark(observations);
  assert.equal(score.detected, 3);
  assert.equal(score.missed, 1);
  assert.equal(score.precision, 0.6);
  assert.equal(score.recall, 0.75);
  assert.equal(score.cleanCaseFalseAlarmRate, 0.25);
  assert.equal(score.medianLatencyMs, 45);
  assert.ok(Math.abs(score.totalCostUsd - 0.08) < 0.00001);
  assert.throws(() => scoreBenchmark(observations.map((item) => ({ ...item, adjudicated: false }))), /adjudication/);
  assert.throws(() => scoreBenchmark(observations.slice(1)), /every/);
  assert.throws(
    () => scoreBenchmark(observations.map((item) => ({ ...item, detectedDefectIds: ["invented"] }))),
    /rubric/,
  );
});
