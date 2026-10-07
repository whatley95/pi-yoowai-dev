import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { PlanUpdateRequestSchema } from "./schemas.js";
import { planIntegrityErrors } from "./plan-integrity.js";
import {
  planStepDescription,
  type PlanResult,
  type PlanStep,
  type PlanStepRef,
  type PlanUpdateRequest,
} from "./types.js";

type IdentifiedStep = PlanStep & { id: string };
export type IdentifiedPlan = Omit<PlanResult, "todo"> & { todo: IdentifiedStep[] };

function newId(): string {
  return `step-${randomUUID()}`;
}

/** Legacy string plans are upgraded only when created/updated, preserving old readers. */
export function identifyPlan(plan: PlanResult): IdentifiedPlan {
  const errors = planIntegrityErrors(plan);
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  return {
    ...structuredClone(plan),
    todo: plan.todo.map((step) => ({
      ...(typeof step === "string" ? { description: step } : structuredClone(step)),
      id: typeof step === "string" ? newId() : (step.id ?? newId()),
    })),
  };
}

/** Existing IDs are authoritative; missing IDs match only unique unchanged outcomes. */
export function identifyUpdatedPlan(previous: IdentifiedPlan, candidate: PlanResult): IdentifiedPlan {
  const next = structuredClone(candidate);
  next.todo = next.todo.map((item) => {
    const step = typeof item === "string" ? { description: item } : item;
    if (step.id) return step;
    const matches = previous.todo.filter((old) => old.description.trim() === step.description.trim());
    return { ...step, id: matches.length === 1 ? matches[0].id : newId() };
  });
  return identifyPlan(next);
}

export function parsePlanUpdateInput(input: string | PlanUpdateRequest): string | PlanUpdateRequest {
  if (typeof input !== "string") {
    if (!Value.Check(PlanUpdateRequestSchema, input))
      throw new Error("Invalid plan update operations. Use edit/add/remove/move operations or {undo:true}.");
    if (
      "operations" in input &&
      input.operations.some((op) => "description" in op && op.description !== undefined && !op.description.trim())
    )
      throw new Error("Step outcome descriptions cannot be blank.");
    return input;
  }
  const text = input.trim();
  if (!text) throw new Error("Describe the requested change, supply targeted operations, or use undo.");
  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Invalid plan update JSON.");
    }
    if (!Value.Check(PlanUpdateRequestSchema, parsed)) throw new Error("Invalid plan update JSON operations.");
    return parsePlanUpdateInput(parsed as PlanUpdateRequest);
  }
  if (text === "undo") return { undo: true };
  const simple = text.match(/^(edit|label|add|remove|move)\s+(\d+)(?:\s+([\s\S]+))?$/);
  if (!simple) return text;
  const [, op, rawStep, tail] = simple;
  const step = Number(rawStep);
  let request: PlanUpdateRequest;
  switch (op) {
    case "edit":
      request = { operations: [{ op: "edit", step, description: tail ?? "" }] };
      break;
    case "label":
      if (!tail) throw new Error("Usage: label <step> <display label>");
      request = { operations: [{ op: "edit", step, title: tail }] };
      break;
    case "add":
      request = { operations: [{ op: "add", after: step, description: tail ?? "" }] };
      break;
    case "remove":
      if (tail) throw new Error("Usage: remove <step>");
      request = { operations: [{ op: "remove", step }] };
      break;
    default:
      if (!tail || !/^\d+$/.test(tail)) throw new Error("Usage: move <step> <new position>");
      request = { operations: [{ op: "move", step, to: Number(tail) }] };
  }
  return parsePlanUpdateInput(request);
}

/** Dependencies travel with identities through every operation and are renumbered once. */
export function editPlan(
  previous: IdentifiedPlan,
  request: Exclude<PlanUpdateRequest, { undo: true }>,
): IdentifiedPlan {
  const steps = previous.todo.map((step) => ({
    ...structuredClone(step),
    dependencies: (step.dependsOn ?? []).map((n) => previous.todo[n - 1].id),
  }));
  const resolve = (ref: PlanStepRef): string => {
    const found = typeof ref === "number" ? steps[ref - 1] : steps.find((s) => s.id === ref);
    if (!found) throw new Error(`Unknown plan step: ${ref}. Inspect /wai-plan for current step numbers and IDs.`);
    return found.id;
  };
  for (const op of request.operations) {
    if (op.op === "add") {
      const after =
        op.after === undefined
          ? steps.length - 1
          : op.after === 0
            ? -1
            : steps.findIndex((s) => s.id === resolve(op.after!));
      const dependencies = (op.dependsOn ?? []).map(resolve);
      steps.splice(after + 1, 0, {
        id: newId(),
        description: op.description,
        title: op.title,
        priority: op.priority,
        dependencies,
      });
    } else {
      const id = resolve(op.step);
      const index = steps.findIndex((s) => s.id === id);
      if (op.op === "remove") steps.splice(index, 1);
      else if (op.op === "move") {
        if (op.to > steps.length) throw new Error(`Move position must be between 1 and ${steps.length}.`);
        const [step] = steps.splice(index, 1);
        steps.splice(op.to - 1, 0, step);
      } else {
        if (
          op.description === undefined &&
          op.title === undefined &&
          op.priority === undefined &&
          op.dependsOn === undefined
        )
          throw new Error("An edit must specify description, title, priority, or dependsOn.");
        if (op.description !== undefined) steps[index].description = op.description;
        if (op.title !== undefined) steps[index].title = op.title;
        if (op.priority !== undefined) steps[index].priority = op.priority;
        if (op.dependsOn !== undefined) steps[index].dependencies = op.dependsOn.map(resolve);
      }
    }
  }
  const todo = steps.map(({ dependencies, ...step }) => ({
    ...step,
    dependsOn: dependencies.map((id) => {
      const index = steps.findIndex((s) => s.id === id);
      if (index < 0)
        throw new Error(
          `Cannot remove prerequisite ${id} while another step depends on it. Update its dependents in the same operation batch.`,
        );
      return index + 1;
    }),
  }));
  const next = {
    summary: request.summary ?? previous.summary,
    acceptanceCriteria: request.acceptanceCriteria ?? previous.acceptanceCriteria,
    todo,
  };
  const errors = planIntegrityErrors(next);
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  return next;
}

function dependencyIds(plan: PlanResult, index: number): string[] {
  const item = plan.todo[index];
  return (typeof item === "string" ? [] : (item.dependsOn ?? []))
    .map((dep) => {
      const target = plan.todo[dep - 1];
      return typeof target === "string" ? `position-${dep}` : (target.id ?? `position-${dep}`);
    })
    .sort();
}

export function sameStepOutcome(previous: PlanResult, oldIndex: number, next: PlanResult, newIndex: number): boolean {
  return (
    planStepDescription(previous.todo[oldIndex]).trim() === planStepDescription(next.todo[newIndex]).trim() &&
    JSON.stringify(dependencyIds(previous, oldIndex)) === JSON.stringify(dependencyIds(next, newIndex))
  );
}

export function samePlanCriteria(previous: PlanResult, next: PlanResult): boolean {
  return (
    JSON.stringify(previous.acceptanceCriteria.map((s) => s.trim()).sort()) ===
    JSON.stringify(next.acceptanceCriteria.map((s) => s.trim()).sort())
  );
}

export function planChangeSummary(previous: IdentifiedPlan, next: IdentifiedPlan): string[] {
  const changes: string[] = [];
  const oldById = new Map(previous.todo.map((s, i) => [s.id, i]));
  const nextIds = new Set(next.todo.map((s) => s.id));
  previous.todo.forEach((s, i) => {
    if (!nextIds.has(s.id)) changes.push(`Removed step ${i + 1}: ${s.title || s.description}`);
  });
  next.todo.forEach((s, i) => {
    const oldIndex = oldById.get(s.id);
    if (oldIndex === undefined) changes.push(`Added step ${i + 1}: ${s.title || s.description}`);
    else {
      const old = previous.todo[oldIndex];
      if (!sameStepOutcome(previous, oldIndex, next, i))
        changes.push(`Changed outcome/dependencies of step ${i + 1}: ${s.title || s.description}`);
      else if (old.title !== s.title || old.priority !== s.priority)
        changes.push(`Updated label/priority of step ${i + 1}`);
      if (oldIndex !== i) changes.push(`Moved step ${oldIndex + 1} to ${i + 1}`);
    }
  });
  if (previous.summary !== next.summary) changes.push("Updated plan summary");
  if (!samePlanCriteria(previous, next))
    changes.push("Changed acceptance criteria; completed work needs verification again");
  else if (JSON.stringify(previous.acceptanceCriteria) !== JSON.stringify(next.acceptanceCriteria))
    changes.push("Updated acceptance-criteria formatting/order");
  return changes;
}
