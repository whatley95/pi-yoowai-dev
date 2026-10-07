import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { identifyPlan, identifyUpdatedPlan, editPlan, parsePlanUpdateInput } from "./plan-editor.js";
import { validatePlanResult, salvagePlanFromMarkdown } from "./prompts.js";
import { preservedCompletedPrefix } from "./actions/plan-update.js";

const original = () =>
  identifyPlan({
    summary: "task",
    todo: [
      "Inspect",
      { description: "Implement", dependsOn: [1] },
      "Document",
      { description: "Verify", dependsOn: [2] },
    ],
    acceptanceCriteria: ["Works"],
  });

describe("targeted plan editing", () => {
  it("uses stable identities and separates cosmetic labels from required outcomes", () => {
    const before = original();
    const renamed = editPlan(before, {
      operations: [{ op: "edit", step: before.todo[0].id, title: "Inspect routing", priority: "low" }],
    });
    assert.equal(renamed.todo[0].id, before.todo[0].id);
    assert.equal(renamed.todo[0].description, "Inspect");
    assert.equal(preservedCompletedPrefix(before, renamed, 2), 2);
    const changed = editPlan(before, { operations: [{ op: "edit", step: 2, description: "Implement a new outcome" }] });
    assert.equal(preservedCompletedPrefix(before, changed, 2), 1);
  });

  it("renumbers dependencies by identity after insertions and moves", () => {
    const before = original();
    const after = editPlan(before, {
      operations: [
        { op: "move", step: 3, to: 2 },
        { op: "add", after: 2, description: "New independent work" },
      ],
    });
    assert.equal(after.todo[3].id, before.todo[1].id);
    assert.deepEqual(after.todo[3].dependsOn, [1]);
    assert.deepEqual(after.todo[4].dependsOn, [4]);
    assert.deepEqual(before.todo[3].dependsOn, [2], "original plan is immutable");
  });

  it("rejects moves before prerequisites and removal of required prerequisites", () => {
    const before = original();
    assert.throws(() => editPlan(before, { operations: [{ op: "move", step: 2, to: 1 }] }), /earlier steps/);
    assert.throws(() => editPlan(before, { operations: [{ op: "remove", step: 1 }] }), /Cannot remove prerequisite/);
    const after = editPlan(before, {
      operations: [
        { op: "remove", step: before.todo[0].id },
        { op: "edit", step: before.todo[1].id, dependsOn: [] },
      ],
    });
    assert.equal(after.todo[0].description, "Implement");
    assert.deepEqual(after.todo[2].dependsOn, [1]);
    assert.throws(() => editPlan(before, { operations: [{ op: "move", step: 2, to: 99 }] }), /between 1 and 4/);
  });

  it("never certifies inserted work with an identical description or a reused changed ID", () => {
    const before = original();
    const inserted = editPlan(before, { operations: [{ op: "add", after: 0, description: "Inspect" }] });
    assert.notEqual(inserted.todo[0].id, before.todo[0].id);
    assert.equal(preservedCompletedPrefix(before, inserted, 2), 0);
    const rewritten = identifyUpdatedPlan(before, {
      ...before,
      todo: [{ ...before.todo[0], description: "Different requirement" }, ...before.todo.slice(1)],
    });
    assert.equal(preservedCompletedPrefix(before, rewritten, 2), 0);
  });

  it("matches missing IDs conservatively and retains completed independent moves", () => {
    const before = identifyPlan({ summary: "task", todo: ["One", "Two", "Three"], acceptanceCriteria: [] });
    const after = identifyUpdatedPlan(before, { ...before, todo: ["One", "Two", "New third"] });
    assert.equal(after.todo[0].id, before.todo[0].id);
    assert.equal(preservedCompletedPrefix(before, after, 2), 2);
    const moved = editPlan(before, { operations: [{ op: "move", step: 1, to: 2 }] });
    assert.equal(preservedCompletedPrefix(before, moved, 2), 2);
    assert.equal(preservedCompletedPrefix(before, { ...moved, acceptanceCriteria: ["Changed requirement"] }, 2), 0);
  });

  it("parses command shorthands and rejects malformed edits without a model fallback", () => {
    assert.deepEqual(parsePlanUpdateInput("label 2 Better title"), {
      operations: [{ op: "edit", step: 2, title: "Better title" }],
    });
    assert.deepEqual(parsePlanUpdateInput("add 0 New prerequisite"), {
      operations: [{ op: "add", after: 0, description: "New prerequisite" }],
    });
    assert.deepEqual(parsePlanUpdateInput("move 3 2"), { operations: [{ op: "move", step: 3, to: 2 }] });
    assert.deepEqual(parsePlanUpdateInput("undo"), { undo: true });
    assert.equal(parsePlanUpdateInput("add another integration check"), "add another integration check");
    for (const input of [
      "edit 2",
      "move 2 tomorrow",
      "remove 2 extra",
      "{bad json",
      { operations: [{ op: "move", step: 1.5, to: 2 }] },
    ])
      assert.throws(() => parsePlanUpdateInput(input as Parameters<typeof parsePlanUpdateInput>[0]));
  });
});

describe("plan semantic validation", () => {
  it("rejects impossible dependencies before coercion or markdown salvage", () => {
    for (const dependsOn of [[1], [99], [0.5], [-1], [NaN], ["1"], "bad"]) {
      const plan = { summary: "task", todo: [{ description: "Only step", dependsOn }], acceptanceCriteria: [] };
      assert.equal(validatePlanResult(plan), null);
      assert.equal(salvagePlanFromMarkdown(JSON.stringify(plan), "fallback"), null);
    }
    assert.equal(
      validatePlanResult({
        summary: "task",
        todo: ["First", { description: "Second", dependsOn: [1, 1] }],
        acceptanceCriteria: [],
      }),
      null,
    );
    const before = original();
    assert.equal(validatePlanResult({ ...before, todo: [before.todo[0], before.todo[0]] }), null);
    assert.ok(validatePlanResult(before));
  });
});
