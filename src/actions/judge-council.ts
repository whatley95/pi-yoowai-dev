import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callSecondaryModel, providerSupportsJsonObject } from "../secondary-model.js";
import { resolveJudgeCouncilMembers } from "../config.js";
import {
  buildJudgeCouncilSynthesisPrompt,
  validateJudgeResult,
  getJudgeValidationErrors,
  salvageJudgeFromMarkdown,
} from "../prompts.js";
import { logEvent } from "../logger.js";
import { STAGES, recordCostWithBudget, parseStructuredResult, mergeUsageCost } from "./shared.js";
import type { ProgressReporter } from "../progress.js";
import type {
  JudgeCouncilSummary,
  JudgeResult,
  ReviewIssue,
  ReviewVerdict,
  SecondaryModelConfig,
  UsageCost,
  YoowaiConfig,
} from "../types.js";

export interface JudgeCouncilOutcome {
  judge: JudgeResult;
  cost: UsageCost;
  council: JudgeCouncilSummary;
}

interface MemberOutcome {
  label: string;
  result?: JudgeResult;
  error?: string;
  usage?: UsageCost;
}

function addCost(acc: UsageCost | undefined, next: UsageCost): UsageCost {
  return acc ? mergeUsageCost(acc, next) : next;
}

const VERDICT_RANK: Record<ReviewVerdict, number> = { pass: 0, "needs-work": 1, blocked: 2 };

/** Deterministic merge used when the synthesis call fails: worst verdict wins,
 *  issues are unioned with their source member's label, and completedStepIds
 *  are intersected across the members that reported any. */
function mergeCouncilVerdicts(successes: Array<{ label: string; result: JudgeResult }>): JudgeResult {
  let verdict: ReviewVerdict = "pass";
  for (const s of successes) {
    if (VERDICT_RANK[s.result.verdict] > VERDICT_RANK[verdict]) {
      verdict = s.result.verdict;
    }
  }

  const issues: ReviewIssue[] = [];
  const seenIssues = new Set<string>();
  for (const s of successes) {
    for (const issue of s.result.issues) {
      const key = `${issue.file ?? ""}:${issue.line ?? ""}:${issue.issue}`;
      if (seenIssues.has(key)) continue;
      seenIssues.add(key);
      issues.push({ ...issue, issue: `[${s.label}] ${issue.issue}` });
    }
  }

  const suggestions: string[] = [];
  const seenSuggestions = new Set<string>();
  for (const s of successes) {
    for (const suggestion of s.result.suggestions) {
      if (seenSuggestions.has(suggestion)) continue;
      seenSuggestions.add(suggestion);
      suggestions.push(suggestion);
    }
  }

  const stepLists = successes
    .map((s) => s.result.completedStepIds)
    .filter((ids): ids is number[] => Array.isArray(ids) && ids.length > 0);
  const completedStepIds =
    stepLists.length > 0 ? stepLists.reduce((acc, ids) => acc.filter((id) => ids.includes(id))) : undefined;

  const counts = new Map<ReviewVerdict, number>();
  for (const s of successes) {
    counts.set(s.result.verdict, (counts.get(s.result.verdict) ?? 0) + 1);
  }
  const tally = [...counts.entries()].map(([v, n]) => `${n} ${v}`).join(" / ");
  const agreed = counts.size === 1;
  const summary =
    `Council of ${successes.length} judges (${tally}): ${agreed ? "all judges agree." : "verdicts disagreed; worst verdict wins."} ` +
    `Merged deterministically because the synthesis call failed.`;

  return {
    verdict,
    issues,
    suggestions,
    consensus: verdict === "pass" && issues.length === 0 && agreed,
    summary,
    ...(completedStepIds && completedStepIds.length > 0 ? { completedStepIds } : {}),
  };
}

/** Fan the judge prompt out to every configured council member in parallel, then
 *  synthesize their verdicts into one final judgment with the configured judge model.
 *  Returns null when the council should not run (fewer than 2 valid members, or every
 *  member failed) so the caller falls back to the standard single-model judge. */
export async function runJudgeCouncil(options: {
  cwd: string;
  config: YoowaiConfig;
  description: string;
  system: string;
  user: string;
  synthesizer: SecondaryModelConfig;
  signal?: AbortSignal;
  sessionManager?: ExtensionContext["sessionManager"];
  progress: ProgressReporter;
}): Promise<JudgeCouncilOutcome | null> {
  const { cwd, config, description, system, user, synthesizer, signal, sessionManager, progress } = options;
  const members = resolveJudgeCouncilMembers(config);
  if (members.length < 2) {
    return null;
  }

  progress(3, STAGES.judge, `Calling council of ${members.length} judges…`);
  const outcomes: MemberOutcome[] = await Promise.all(
    members.map(async (member): Promise<MemberOutcome> => {
      const label = `${member.provider}:${member.id}`;
      try {
        const { content, usage } = await callSecondaryModel(member.provider, member.id, system, user, {
          signal,
          thinking: member.thinking,
          cwd,
          sessionManager,
          structuredOutput: true,
          secondaryOverride: member,
        });
        const result = parseStructuredResult(cwd, content, {
          label: `Council judgment (${label})`,
          validate: validateJudgeResult,
          validationErrors: getJudgeValidationErrors,
          salvage: salvageJudgeFromMarkdown,
        });
        if (!result) {
          return { label, error: "unparseable response", usage };
        }
        return { label, result, usage };
      } catch (err) {
        if (signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        logEvent(cwd, "warn", "Judge council member failed", { model: label, error: message });
        return { label, error: message };
      }
    }),
  );

  let cost: UsageCost | undefined;
  for (const outcome of outcomes) {
    if (outcome.usage) {
      cost = addCost(cost, recordCostWithBudget(cwd, outcome.usage));
    }
  }

  const successes = outcomes.filter((o): o is MemberOutcome & { result: JudgeResult } => Boolean(o.result));
  if (successes.length === 0) {
    logEvent(cwd, "warn", "All judge council members failed; falling back to single-model judge", {
      members: outcomes.map((o) => o.label),
    });
    return null;
  }

  const council: JudgeCouncilSummary = {
    synthesized: true,
    members: outcomes.map((o) => ({ model: o.label, verdict: o.result?.verdict, error: o.error })),
  };

  progress(3, STAGES.judge, `Synthesizing ${successes.length} council verdicts…`);
  let judge: JudgeResult | null = null;
  try {
    const nativeJson = providerSupportsJsonObject(synthesizer.provider, synthesizer.id, synthesizer);
    const synthesis = buildJudgeCouncilSynthesisPrompt(
      description,
      successes.map((s) => ({ model: s.label, result: s.result })),
      nativeJson,
    );
    const { content, usage } = await callSecondaryModel(
      synthesizer.provider,
      synthesizer.id,
      synthesis.system,
      synthesis.user,
      {
        signal,
        thinking: synthesizer.thinking,
        cwd,
        sessionManager,
        task: "judge",
        structuredOutput: true,
      },
    );
    cost = addCost(cost, recordCostWithBudget(cwd, usage));
    judge = parseStructuredResult(cwd, content, {
      label: "Council synthesis",
      validate: validateJudgeResult,
      validationErrors: getJudgeValidationErrors,
      salvage: salvageJudgeFromMarkdown,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    logEvent(cwd, "warn", "Judge council synthesis failed; using deterministic merge", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!judge) {
    council.synthesized = false;
    judge = mergeCouncilVerdicts(successes.map((s) => ({ label: s.label, result: s.result })));
  }
  judge.council = council;

  logEvent(cwd, "info", "Judge council completed", {
    members: council.members,
    synthesized: council.synthesized,
    verdict: judge.verdict,
  });

  return { judge, cost: cost ?? recordCostWithBudget(cwd, zeroUsage()), council };
}

function zeroUsage(): UsageCost {
  return { estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedCostUsd: 0, sessionCostUsd: 0 };
}
