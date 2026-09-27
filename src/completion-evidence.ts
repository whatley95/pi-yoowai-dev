import { getState, flushSessionState } from "./session-state.js";
import type { YoowaiSessionState } from "./types.js";

export function recordCompletionEvidence(
  cwd: string,
  fingerprint: string | undefined,
  checks: Array<{ command: string; exitCode: number }>,
  modelAssessment: string,
): void {
  const state = getState(cwd);
  if (fingerprint) state.observedFingerprint = fingerprint;
  state.completionEvidence = {
    fingerprint,
    recordedAt: new Date().toISOString(),
    checks,
    // A successful command alone cannot prove an arbitrary natural-language
    // criterion. Keep these unknown until evidence can be mapped explicitly.
    criteria: (state.plan?.acceptanceCriteria ?? []).map((criterion) => ({ criterion, status: "unverified" })),
    modelAssessment,
  };
  flushSessionState(cwd);
}

export function normalizeCompletionEvidence(value: unknown): YoowaiSessionState["completionEvidence"] {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.checks) || !Array.isArray(data.criteria) || typeof data.recordedAt !== "string")
    return undefined;
  const checks = data.checks
    .filter(
      (check): check is { command: string; exitCode: number } =>
        check && typeof check === "object" && typeof check.command === "string" && Number.isInteger(check.exitCode),
    )
    .slice(0, 100);
  const criteria = data.criteria
    .filter(
      (entry): entry is { criterion: string; status: "unverified" } =>
        entry && typeof entry === "object" && typeof entry.criterion === "string" && entry.status === "unverified",
    )
    .slice(0, 100);
  return {
    recordedAt: data.recordedAt,
    fingerprint: typeof data.fingerprint === "string" ? data.fingerprint : undefined,
    checks,
    criteria,
    modelAssessment: typeof data.modelAssessment === "string" ? data.modelAssessment : undefined,
  };
}
