import type { YooToolParams, YooAction, YooModelTask } from "./types.js";

export const YOO_ACTIONS: YooAction[] = [
  "plan",
  "review",
  "suggest",
  "recommend",
  "judge",
  "scan",
  "test",
  "security",
  "done",
  "planUpdate",
];
export const YOO_MODEL_TASKS: YooModelTask[] = [...YOO_ACTIONS, "explain"];

interface ValidatedParams {
  ok: true;
  params: YooToolParams;
  action: YooAction;
}

interface InvalidParams {
  ok: false;
  error: string;
}

type ValidationResult = ValidatedParams | InvalidParams;

export function validateYooToolParams(params: unknown): ValidationResult {
  if (!params || typeof params !== "object") {
    return { ok: false, error: "Invalid parameters: expected an object." };
  }
  const p = params as Record<string, unknown>;

  const active = YOO_ACTIONS.filter((a) => {
    const value = p[a];
    if (a === "scan") return value === true;
    if (a === "done" || a === "planUpdate") {
      return value === true || typeof value === "number" || (typeof value === "string" && value.length > 0);
    }
    return typeof value === "string" && value.length > 0;
  });

  if (active.length === 0) {
    return {
      ok: false,
      error:
        "No action specified. Provide one of: plan, review, suggest, recommend, judge, scan, test, security, done, or planUpdate.",
    };
  }
  if (active.length > 1) {
    return { ok: false, error: `Only one action per call is allowed. Received: ${active.join(", ")}.` };
  }

  const action = active[0];

  const stringArray = (value: unknown): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return undefined;
    const filtered = value.filter((v): v is string => typeof v === "string" && v.length > 0);
    return filtered.length > 0 ? filtered : undefined;
  };

  const result: YooToolParams = {
    plan: action === "plan" ? (p.plan as string) : undefined,
    review: action === "review" ? (p.review as string) : undefined,
    suggest: action === "suggest" ? (p.suggest as string) : undefined,
    recommend: action === "recommend" ? (p.recommend as string) : undefined,
    judge: action === "judge" ? (p.judge as string) : undefined,
    scan: action === "scan" ? true : undefined,
    test: action === "test" ? (p.test as string) : undefined,
    security: action === "security" ? (p.security as string) : undefined,
    done: action === "done" ? (p.done === true ? "" : (p.done as string | number)) : undefined,
    planUpdate: action === "planUpdate" ? (p.planUpdate === true ? "" : (p.planUpdate as string)) : undefined,
    files: stringArray(p.files),
    exclude: stringArray(p.exclude),
    revision: typeof p.revision === "string" ? p.revision : undefined,
    since: typeof p.since === "string" ? p.since : undefined,
    vcs: p.vcs === "git" || p.vcs === "svn" ? p.vcs : undefined,
    untracked: p.untracked === true ? true : undefined,
    verify: p.verify === true ? true : undefined,
    docs: stringArray(p.docs),
  };

  return { ok: true, params: result, action } as ValidatedParams;
}
