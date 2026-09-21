import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPlanView, getBlockedBy, latestFileReview, type PlanViewCost } from "./plan-view.js";
import type { PlanResult, YoowaiSessionState } from "./types.js";

const COST: PlanViewCost = { calls: 4, costUsd: 0.0123 };

function makeState(overrides: Partial<YoowaiSessionState> = {}): YoowaiSessionState {
  return {
    plan: {
      todo: ["step one", "step two", "step three"],
      acceptanceCriteria: [],
      summary: "Test plan",
    },
    completedSteps: 0,
    totalSteps: 3,
    reviewRounds: [0, 0, 0],
    reviewedSteps: [false, false, false],
    editsSinceLastReview: 0,
    ...overrides,
  } as YoowaiSessionState;
}

describe("buildPlanView", () => {
  it("returns exactly 'No active plan.' when no plan is set", () => {
    const state = makeState({ plan: undefined, totalSteps: 0 });
    assert.deepEqual(buildPlanView(state, COST), ["No active plan."]);
  });

  it("renders the header, progress ratio, and reviewed ratio", () => {
    const lines = buildPlanView(makeState(), COST);
    assert.ok(lines[0]?.includes("wai plan — Test plan"), `header should carry the summary: ${lines[0]}`);
    assert.ok(lines[1]?.includes("0/3 steps (0%)"));
    assert.ok(lines[1]?.includes("reviewed: 0/0"));
  });

  it("wraps a long header summary without discarding content", () => {
    const long = "summary-word ".repeat(15).trim(); // > 100 chars
    const state = makeState({ plan: { todo: ["only"], acceptanceCriteria: [], summary: long }, totalSteps: 1 });
    const lines = buildPlanView(state, COST);
    for (const line of lines) {
      assert.ok(line.length <= 100, `line must stay within the wrap width: ${line.length}`);
    }
    const recombined = lines
      .slice(
        0,
        lines.findIndex((l) => l.includes("Progress:")),
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    assert.ok(recombined.startsWith("wai plan —") && recombined.includes(long), "full summary must survive wrapping");
  });

  it("wraps long edited-file samples", () => {
    const state = makeState({
      editedFiles: [
        "src/very/long/path/alpha.ts",
        "src/very/long/path/beta.ts",
        "src/very/long/path/gamma.ts",
        "src/very/long/path/delta.ts",
        "src/very/long/path/epsilon.ts",
      ],
      editsSinceLastReview: 5,
    });
    const lines = buildPlanView(state, COST);
    for (const line of lines) {
      assert.ok(line.length <= 100, `line must stay within the wrap width: ${line.length}`);
    }
    const recombined = lines
      .filter((l) => l.includes("alpha.ts") || l.startsWith("    "))
      .join(" ")
      .replace(/\s+/g, " ");
    for (const path of state.editedFiles!) {
      assert.ok(recombined.includes(path), `every sampled file must survive wrapping: ${path}`);
    }
  });

  it("maps the first step to → (current) and the rest to · when nothing is done", () => {
    const lines = buildPlanView(makeState(), COST);
    assert.ok(lines.some((l) => l.includes("1. → step one — current")));
    assert.ok(lines.some((l) => l.includes("2. · step two")));
    assert.ok(lines.some((l) => l.includes("3. · step three")));
  });

  it("distinguishes completed-and-reviewed from completed-but-manually-marked", () => {
    const state = makeState({
      completedSteps: 2,
      reviewRounds: [2, 0, 0],
      reviewedSteps: [true, false, false],
    });
    const lines = buildPlanView(state, COST);
    const done = lines.find((l) => l.includes("1. ✓ step one"));
    assert.ok(done, "step 1 must use the ✓ reviewed glyph");
    assert.match(done!, /— reviewed \(2 rounds\)/);
    const manual = lines.find((l) => l.includes("2. ⚠ step two"));
    assert.ok(manual, "step 2 must use the ⚠ manually-marked glyph");
    assert.match(manual!, /— completed \(manually marked, not reviewed\)/);
  });

  it("shows the singular round label for one review round", () => {
    const state = makeState({
      completedSteps: 1,
      reviewRounds: [1, 0, 0],
      reviewedSteps: [true, false, false],
    });
    const lines = buildPlanView(state, COST);
    assert.ok(lines.some((l) => l.includes("— reviewed (1 round)") && l.includes("step one")));
  });

  it("marks the current step with → and lists blockers", () => {
    const state = makeState({
      completedSteps: 1,
      plan: {
        todo: ["step one", { description: "step two", dependsOn: [3] }, "step three"],
        acceptanceCriteria: [],
        summary: "deps",
      },
      reviewRounds: [1, 0, 0],
      reviewedSteps: [true, false, false],
    });
    const lines = buildPlanView(state, COST);
    const current = lines.find((l) => l.includes("2. → step two"));
    assert.ok(current, "step 2 must be the current step");
    assert.match(current!, /— current, blocked by step 3/);
  });

  it("shows the current step's review rounds so far", () => {
    const state = makeState({
      completedSteps: 1,
      reviewRounds: [1, 2, 0],
      reviewedSteps: [true, false, false],
    });
    const lines = buildPlanView(state, COST);
    assert.ok(lines.some((l) => l.includes("Review: step 2 has 2 review rounds so far")));
  });

  it("selects the latest file review by timestamp and counts files", () => {
    const state = makeState({
      reviewedFiles: {
        "src/a.ts": { verdict: "pass", at: 100 },
        "src/b.ts": { verdict: "needs-work", at: 200 },
        "src/c.ts": { verdict: "pass", at: 50 },
      },
    });
    const lines = buildPlanView(state, COST);
    assert.ok(lines.some((l) => l.includes("Last file review: needs-work (3 files with verdicts)")));
  });

  it("reports review-pending edits with an edited-files sample", () => {
    const state = makeState({
      editedFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts", "src/g.ts"],
      editsSinceLastReview: 7,
    });
    const lines = buildPlanView(state, COST);
    const pending = lines.find((l) => l.includes("⚠ review pending: 7 edits"));
    assert.ok(pending, "review-pending line must appear");
    const sample = lines.find((l) => l.includes("edited: src/a.ts"));
    assert.ok(sample, "edited-files sample must appear");
    assert.match(sample!, /\+2 more/, "files beyond the five-file sample are summarized");
  });

  it("honors an explicit unreviewedEdits override over state", () => {
    const state = makeState({ editsSinceLastReview: 9 });
    const lines = buildPlanView(state, COST, { unreviewedEdits: 2 });
    assert.ok(lines.some((l) => l.includes("⚠ review pending: 2 edits")));
  });

  it("renders acceptance criteria as a checklist without claiming verification", () => {
    const state = makeState({
      plan: {
        todo: ["only"],
        acceptanceCriteria: ["builds cleanly", "tests pass"],
        summary: "s",
      },
      totalSteps: 1,
    });
    const lines = buildPlanView(state, COST);
    assert.ok(lines.some((l) => l.includes("Acceptance criteria (not yet verified")));
    assert.ok(lines.some((l) => l.includes("builds cleanly") && !l.includes("verified ✓")));
    assert.ok(
      lines.some((l) => l.includes("tests pass")),
      "the second criterion must be rendered",
    );
  });

  it("reflects both judgeCompleted states on a complete plan", () => {
    const done = makeState({
      completedSteps: 3,
      reviewRounds: [1, 1, 1],
      reviewedSteps: [true, true, true],
      judgeCompleted: true,
    });
    assert.ok(buildPlanView(done, COST).some((l) => l.includes("final judge verdict recorded")));

    const pending = makeState({
      completedSteps: 3,
      reviewRounds: [1, 1, 1],
      reviewedSteps: [true, true, true],
    });
    assert.ok(buildPlanView(pending, COST).some((l) => l.includes("final judge pending")));
  });

  it("renders the session cost with calls", () => {
    const lines = buildPlanView(makeState(), COST);
    assert.ok(lines.some((l) => l.startsWith("Session cost:") && l.includes("4 calls")));
  });

  it("wraps long descriptions without discarding content", () => {
    const long = "word ".repeat(40).trim(); // 250 chars
    const state = makeState({
      plan: { todo: [long], acceptanceCriteria: [], summary: "long" },
      totalSteps: 1,
    });
    const lines = buildPlanView(state, COST);
    const firstIdx = lines.findIndex((l) => l.includes("1. "));
    const rest = lines.slice(firstIdx);
    const stepLines = rest.slice(
      0,
      rest.findIndex((l) => l === ""),
    );
    assert.ok(stepLines.length > 1, `a 250-char description must wrap into multiple lines (got ${stepLines.length})`);
    for (const line of stepLines) {
      assert.ok(line.length <= 100, `line must stay within the wrap width: ${line.length} — ${JSON.stringify(line)}`);
    }
    const recombined = stepLines
      .join(" ")
      .replace(/^\s*1\. [·→✓⚠] /, "")
      .replace(/\s+/g, " ")
      .trim();
    assert.ok(recombined.startsWith(long), "full description must survive wrapping");
  });

  it("emits no ANSI escape sequences and groups sections with single blank lines", () => {
    const state = makeState({
      completedSteps: 2,
      reviewRounds: [1, 1, 0],
      reviewedSteps: [true, true, false],
    });
    const lines = buildPlanView(state, COST);
    const esc = String.fromCharCode(27);
    for (const line of lines) {
      assert.ok(!line.includes(esc), `no ANSI escapes allowed: ${JSON.stringify(line)}`);
    }
    for (let i = 1; i < lines.length; i++) {
      assert.ok(!(lines[i] === "" && lines[i - 1] === ""), `no adjacent empty lines at index ${i}`);
    }
    assert.ok(lines.includes(""), "sections must be separated by at least one blank line");
  });

  it("emits no adjacent blanks even when every optional section is empty", () => {
    // Complete plan, no file reviews, no pending edits, no acceptance
    // criteria: the review-state and acceptance sections are both skipped.
    const state = makeState({
      completedSteps: 3,
      reviewRounds: [1, 1, 1],
      reviewedSteps: [true, true, true],
      judgeCompleted: true,
    });
    const lines = buildPlanView(state, COST);
    for (let i = 1; i < lines.length; i++) {
      assert.ok(!(lines[i] === "" && lines[i - 1] === ""), `no adjacent empty lines at index ${i}`);
    }
    assert.ok(lines.some((l) => l.includes("final judge verdict recorded")));
  });

  it("does not mutate the inputs", () => {
    const state = makeState({
      completedSteps: 1,
      reviewRounds: [1, 0, 0],
      reviewedSteps: [true, false, false],
    });
    const stateSnapshot = JSON.stringify(state);
    const costSnapshot = JSON.stringify(COST);
    buildPlanView(state, COST);
    assert.equal(JSON.stringify(state), stateSnapshot);
    assert.equal(JSON.stringify(COST), costSnapshot);
  });
});

describe("getBlockedBy (re-exported plan-view logic)", () => {
  it("returns unmet numeric dependencies and ignores string steps", () => {
    const state = makeState({
      completedSteps: 0,
      plan: {
        todo: ["a", { description: "b", dependsOn: [1, "x" as unknown as number] }, "c"],
        acceptanceCriteria: [],
        summary: "s",
      },
      totalSteps: 3,
    });
    assert.deepEqual(getBlockedBy(state, 1), [1]);
    assert.equal(getBlockedBy(state, 0), undefined);
    assert.deepEqual(getBlockedBy(state, 2), undefined);
  });
});

describe("latestFileReview", () => {
  it("returns undefined when no file reviews exist", () => {
    assert.equal(latestFileReview(makeState()), undefined);
  });

  it("picks the newest entry by `at`", () => {
    const state = makeState({
      reviewedFiles: { "a.ts": { verdict: "blocked", at: 5 }, "b.ts": { verdict: "pass", at: 9 } },
    });
    assert.deepEqual(latestFileReview(state), { verdict: "pass", files: 2 });
  });
});

describe("plan-result plan shape (object steps)", () => {
  it("renders PlanStep objects by description", () => {
    const plan: PlanResult = {
      todo: [{ description: "object step", priority: "high", dependsOn: [2] }, "plain step"],
      acceptanceCriteria: [],
      summary: "objects",
    };
    const state = makeState({ plan, totalSteps: 2 });
    const lines = buildPlanView(state, COST);
    assert.ok(lines.some((l) => l.includes("1. → object step — current, blocked by step 2")));
    assert.ok(lines.some((l) => l.includes("2. · plain step")));
  });
});
