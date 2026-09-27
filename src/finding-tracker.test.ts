import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dismissFinding, listFindings, recordFindingRound } from "./finding-tracker.js";

test("findings recur across line shifts and restart, with evidence-bearing dismissals", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wai-findings-"));
  try {
    const issue = {
      file: "a.ts",
      line: 1,
      severity: "high" as const,
      issue: "Missing await",
      suggestion: "await save",
    };
    assert.deepEqual(recordFindingRound(cwd, [issue, issue]), []);
    recordFindingRound(cwd, [{ ...issue, line: 8 }]);
    assert.match(recordFindingRound(cwd, [issue])[0], /3 reviews/);
    const id = listFindings(cwd)[0].id;
    assert.throws(() => dismissFinding(cwd, id, " "), /requires/);
    dismissFinding(cwd, id, "save() returns synchronously; see contract test");
    assert.match(recordFindingRound(cwd, [issue])[0], /documented dismissal/);
    assert.equal(listFindings(cwd)[0].consecutiveRounds, 4);
    recordFindingRound(cwd, []);
    assert.equal(listFindings(cwd)[0].active, false);
    assert.deepEqual(recordFindingRound(cwd, [issue]), []);
    assert.equal(listFindings(cwd)[0].consecutiveRounds, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
