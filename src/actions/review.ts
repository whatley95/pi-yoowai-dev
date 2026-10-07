import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { captureWorkspace, workspaceMatches } from "../workspace-fingerprint.js";
import { recordCompletionEvidence } from "../completion-evidence.js";
import { recordFindingRound, findingGuidance } from "../finding-tracker.js";
import { loadYoowaiConfig, resolveReviewTaskModel, resolveJudgeCouncilMembers } from "../config.js";
import { isSafeRelativePath, normalizeReviewPath, resolveProjectPath } from "../path-security.js";
import { getDiff, splitDiffByFile, getVcsInfo } from "../diff-grabber.js";
import { loadConventions, formatConventions } from "../conventions.js";
import { providerSupportsJsonObject, estimateCost } from "../secondary-model.js";
import { loadFileContentsForReview, isReviewableFile, type FileContentEntry } from "../file-loader.js";
import { buildRelatedContext, buildFileOutlines } from "../context-retrieval.js";
import { buildCodemap } from "../codemap.js";
import { formatDesignRulesForPrompt, hasUiChanges } from "../design-ref.js";
import { capActionInstructions } from "../instructions.js";
import { buildAstContext } from "../ast-context.js";
import { getPastIssuesForFiles, recordIssues } from "../review-memory.js";
import { selectLearnedFacts, formatLearnedContext } from "../wai-learn.js";
import { runPreReviewCommands, formatPreReviewOutput } from "../pre-review.js";
import { resolveEffectivePreReviewCommands, resolveEffectiveToolLoop } from "./context-shared.js";
import { groupRelatedReviewFiles } from "./review-batching.js";
import { splitReviewDiff } from "./review-chunks.js";
import { calculateReviewBudget, estimateTokens, truncateToTokenBudget, type ReviewBudget } from "../token-budget.js";
import { getSessionCost, getReservedCost, formatCost } from "../cost-tracker.js";
import { logEvent } from "../logger.js";
import {
  getState,
  markStepsComplete,
  incrementReviewRounds,
  getProgress,
  markJudgeCompleted,
  getLastReviewedCommit,
  getPendingReviewCommit,
  getReviewedFiles,
  recordReviewedFiles,
  planStaleSuggestionDue,
  isWholeTreeReview,
} from "../session-state.js";
import { planStepDescription } from "../types.js";
import { auditStepDone } from "../integration/audit.js";
import {
  STAGES,
  secondaryModelLabel,
  recordCostWithBudget,
  mergeUsageCost,
  toolLoopOptions,
  continuationMeta,
} from "./shared.js";
import { resolveRangeBase, updateRangeState, pinAttemptedRange } from "./range.js";
import {
  getSessionContext,
  runWithConcurrencyLimit,
  mergeReviewResults,
  runReviewBatch,
  reviewDiffAllowance,
  type ReviewBatchInput,
  type ConcurrencyOutcome,
} from "./review-helpers.js";
import { executeWaiJudge } from "./judge.js";
import { resolveBackendType, resolveBudgetModel } from "../backends/backend-resolver.js";
import { validateReviewResult, getReviewValidationErrors, salvageReviewFromMarkdown } from "../prompts.js";
import { verifyResult, mergeVerifiedCost } from "./verify.js";
import { buildCacheKey, getCachedReview, setCachedResult } from "../review-cache.js";
import { getReviewLevelSettings, resolveRiskReviewLevel } from "../review-level.js";
import type { ProgressReporter } from "../progress.js";
import type { WaiToolResult, ReviewResult, UsageCost, ReviewLevel, ReviewExecution } from "../types.js";
import { INCONCLUSIVE_REVIEW_GUIDANCE } from "../workflow-guidance.js";
import { withReviewRecovery } from "../review-recovery.js";

/** Error returned when no review model can be resolved — the effective level
 *  drives the per-level task lookup (reviewMin/reviewMed/reviewHigh) with the
 *  `review` task and finally `secondary` as fallbacks. Exported so callers and
 *  tests can reference the exact message. */
export const REVIEW_NO_MODEL_ERROR =
  "No secondary model configured. Set pi-yoowai.secondary, taskModels.review, or taskModels.reviewMin/reviewMed/reviewHigh in settings.json.";

/** Decide whether a passing review advances the plan tracker, and by how
 *  many steps. Guards the guarded auto-completion contract:
 *  - consensus advances by an explicit positive "completedSteps" count;
 *  - an explicit stepComplete: true signal advances exactly one step (the
 *    current one) even when minor issues remain, because the model
 *    explicitly confirmed the step's work is finished and covered;
 *  - explicit incomplete/stale/inconclusive signals and a code-quality pass
 *    without completion evidence do not advance.
 *  Returns null when no plan is active; when the plan is already complete the
 *  returned count is 0 (bookkeeping may still run, auto-advance must not). */
export function planAdvanceFromReview(
  review: Pick<
    ReviewResult,
    | "verdict"
    | "consensus"
    | "stepComplete"
    | "completedSteps"
    | "planStale"
    | "inconclusive"
    | "contextLimited"
    | "coverageGaps"
    | "truncated"
    | "droppedFiles"
    | "inputIncomplete"
    | "checksFailed"
  >,
  planActive: boolean,
  planComplete: boolean,
): { count: number } | null {
  if (!planActive || review.verdict !== "pass" || review.planStale || review.inconclusive) return null;
  if (
    review.contextLimited ||
    review.coverageGaps?.length ||
    review.truncated ||
    review.droppedFiles?.length ||
    review.inputIncomplete ||
    review.checksFailed
  )
    return null;
  if (planComplete) return review.consensus || review.stepComplete === true ? { count: 0 } : null;
  if (review.stepComplete === false || review.completedSteps === 0) return null;
  const completedSteps = review.completedSteps;
  if (
    review.consensus &&
    typeof completedSteps === "number" &&
    Number.isInteger(completedSteps) &&
    completedSteps > 0
  ) {
    return { count: completedSteps };
  }
  if (review.stepComplete === true) {
    return { count: 1 };
  }
  return null;
}

export async function executeWaiReview(...args: Parameters<typeof executeReview>): Promise<WaiToolResult> {
  return withReviewRecovery(await executeReview(...args));
}

async function executeReview(
  cwd: string,
  description: string,
  ctx: ExtensionContext,
  options: {
    files?: string[];
    exclude?: string[];
    revision?: string;
    since?: string;
    vcs?: "git" | "svn";
    untracked?: boolean;
    level?: ReviewLevel;
  } = {},
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
): Promise<WaiToolResult> {
  signal?.throwIfAborted();
  const config = loadYoowaiConfig(cwd);
  const state = getState(cwd);
  const workspace = captureWorkspace(cwd);
  const workspaceFingerprint = workspace.status === "ready" ? workspace.fingerprint : undefined;
  const wholeTreeReview = isWholeTreeReview(options);
  const currentStep =
    wholeTreeReview && state.plan && state.completedSteps < state.plan.todo.length
      ? planStepDescription(state.plan.todo[state.completedSteps])
      : undefined;
  const criteria = wholeTreeReview ? state.plan?.acceptanceCriteria?.join("\n") : undefined;
  // Files edited since the current step started (the list resets when a step
  // completes): a focus hint for the reviewer, never a diff filter.
  const stepFocusFiles =
    wholeTreeReview && state.plan && state.editedFiles && state.editedFiles.length > 0 ? state.editedFiles : undefined;

  progress(1, STAGES.review, "Collecting diff…");
  const diffOptions = {
    ...options,
    maxDiffChars: config.reviewMaxDiffChars,
    untracked: options.untracked ?? true,
  };
  const vcsInfo = getVcsInfo(cwd);
  const lastReviewed = getLastReviewedCommit(cwd);
  const pendingAnchor = getPendingReviewCommit(cwd);
  // Shared range selection: validated anchors (pending may be a tree — the
  // empty-tree root-commit base), clean/dirty fallbacks, root-commit empty
  // tree, and base absolutization. Review uses the incremental policy: the
  // failed round's anchor wins over the accepted baseline.
  const range = resolveRangeBase(cwd, "incremental", vcsInfo, lastReviewed, pendingAnchor, options);
  if (range.since !== undefined) diffOptions.since = range.since;
  if (range.revision !== undefined) diffOptions.revision = range.revision;
  const { diff, truncated, changedFiles, vcs, unavailableReason } = getDiff(cwd, diffOptions);
  if (unavailableReason || changedFiles.length === 0) {
    const reason = unavailableReason ?? "No code changes were found in the requested review scope.";
    return {
      action: "review",
      recovery: {
        reason: unavailableReason ? "diff-unavailable" : "empty-diff",
        message: reason,
        nextAction:
          "Verify the working directory, file scope, and VCS range. Include new files; retry only once a reviewable diff is available.",
        retry: "after-change",
      },
      review: {
        verdict: "needs-work",
        issues: [],
        suggestions: [
          `${reason} No review verdict was issued; verify the working directory and requested files before retrying.`,
        ],
        consensus: false,
        inconclusive: true,
        inputIncomplete: true,
        stepComplete: false,
        scopeLimited: !wholeTreeReview,
      },
    };
  }
  const missingScopes = (options.files ?? []).filter((requested) => {
    if (!isSafeRelativePath(requested) || ["*", "?", "[", "]"].some((char) => requested.includes(char))) return false;
    const scope = normalizeReviewPath(requested);
    if (scope === ".") return false;
    return !changedFiles.some((file) => file === scope || file.startsWith(`${scope}/`));
  });
  if (missingScopes.length > 0) {
    return {
      action: "review",
      recovery: {
        reason: "missing-scoped-files",
        message: "No diff was captured for one or more requested files or directories.",
        affectedFiles: missingScopes,
        nextAction:
          "Check the project root and VCS range. Run Pi in the other project's directory for files outside this checkout.",
        retry: "after-change",
      },
      review: {
        verdict: "needs-work",
        issues: [],
        suggestions: [
          `No diff was captured for requested scope: ${missingScopes.join(", ")}. Check the working directory and VCS range; run Pi in the other project's directory if these files are outside this checkout.`,
        ],
        consensus: false,
        inconclusive: true,
        inputIncomplete: true,
        stepComplete: false,
        scopeLimited: !wholeTreeReview,
      },
    };
  }
  const level = resolveRiskReviewLevel(config, options.level, changedFiles, diff, truncated);
  const reviewSettings = getReviewLevelSettings(config, level);
  const effectiveConfig = { ...config, ...reviewSettings };
  // The effective depth selects the matching per-level model and tool loop.
  let modelConfig = resolveReviewTaskModel(config, level);
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "review", error: REVIEW_NO_MODEL_ERROR };
  }
  modelConfig = await resolveBudgetModel(modelConfig, config.modelInfo);
  const modelProfile = {
    provider: modelConfig.provider,
    id: modelConfig.id,
    thinking: modelConfig.thinking,
    backend: resolveBackendType(modelConfig.provider, modelConfig),
  };
  const nativeJson = providerSupportsJsonObject(modelConfig.provider, modelConfig.id, modelConfig);
  const effectiveToolUseLoop = resolveEffectiveToolLoop(config, level);
  const loopConfig = { ...config, toolUseLoop: effectiveToolUseLoop };
  const relatedContext =
    buildAstContext(cwd, changedFiles, { maxTokens: effectiveConfig.relatedContextMaxTokens ?? 1000 }) ||
    buildRelatedContext(cwd, changedFiles).context;
  const codemap = buildCodemap(cwd, changedFiles, effectiveConfig.codemapMaxTokens ?? 1500);
  const designRefText = hasUiChanges(cwd, changedFiles)
    ? formatDesignRulesForPrompt(cwd, effectiveConfig.designRefMaxTokens ?? 800, changedFiles)
    : "";
  const instructionsText = capActionInstructions(
    cwd,
    "review",
    effectiveConfig.instructionsMaxTokens ?? 800,
    changedFiles,
  );
  // Scoped reviews judge the requested change from its description and code.
  // The surrounding session can contain an unrelated active plan or prior
  // inconclusive verdicts that would make the reviewer repeat stale advice.
  const sessionContext = wholeTreeReview ? getSessionContext(ctx) : "";

  progress(2, STAGES.review, "Loading project conventions…");
  let conventionsText = "";
  const conventions = loadConventions(cwd);
  if (conventions) {
    conventionsText = truncateToTokenBudget(
      formatConventions(conventions),
      effectiveConfig.reviewMaxConventionsTokens ?? 1000,
    );
  }

  const memoryContext = truncateToTokenBudget(
    `${getPastIssuesForFiles(cwd, changedFiles, description)}\n${findingGuidance(cwd)}`.trim(),
    effectiveConfig.reviewMaxMemoryTokens ?? 800,
  );

  // Known decisions: facts recorded with kind:"decision" are surfaced to the
  // reviewer as do-not-re-flag context (implemented earlier on purpose — not
  // accidental drift). Capped at 600 tokens including the heading; empty when
  // no decisions exist.
  const decisionsRecords = selectLearnedFacts(cwd, { query: description, files: changedFiles, kind: "decision" });
  const decisionsContext =
    decisionsRecords.length > 0
      ? `Known project decisions — do NOT re-flag as missing or wrong without evidence they were overturned:\n${formatLearnedContext(decisionsRecords, 560)}`
      : "";
  const decisionsText = decisionsContext ? truncateToTokenBudget(decisionsContext, 600) : "";

  // Prior-round context: files that completed reviews in this step but are
  // NOT part of the current diff. An incremental review (clean tree,
  // lastReviewedCommit..HEAD) would otherwise never see earlier rounds'
  // files and re-flag their already-reviewed logic as missing. Token-capped
  // by priorReviewMaxTokens (0 disables); the finalized context is hashed
  // into the cache key so any change invalidates a stale cached review.
  let priorRoundContext = "";
  const priorReviewMaxTokens = wholeTreeReview ? (effectiveConfig.priorReviewMaxTokens ?? 800) : 0;
  if (priorReviewMaxTokens > 0) {
    const reviewedFiles = getReviewedFiles(cwd);
    const currentChanged = new Set(changedFiles);
    const priorFiles = Object.entries(reviewedFiles)
      .filter(
        ([file]) =>
          !currentChanged.has(file) && isReviewableFile(file) && existsSync(resolveProjectPath(cwd, file) ?? ""),
      )
      .map(([file, record]) => ({ file, verdict: record.verdict }));
    if (priorFiles.length > 0) {
      // Every included file also emits a verdict line and a header line: pass
      // a per-file overhead reservation so entries stay COMPLETE (a listed
      // file always has both its verdict line and its outline). The framing
      // line is reserved from the cap up front.
      // The framing line is reserved by MEASURING it, so the cap holds
      // exactly: each entry is fitted atomically against the remaining
      // budget inside buildFileOutlines (header + outline + exact verdict
      // line), so the assembled block can never exceed priorReviewMaxTokens.
      const framing =
        "Previously reviewed this step (not in the current diff — implemented and reviewed in earlier rounds):\n";
      const outlineBudget = Math.max(1, priorReviewMaxTokens - estimateTokens(framing));
      // Per-file overhead = the EXACT rendered verdict line (the header is
      // measured inside buildFileOutlines) plus a conservative 2-token
      // separator reserve: the verdict-line join newlines, the "\n\n" between
      // the verdict block and the outlines, and the outline-block separators
      // (worst case ~0.75 tokens per included file). The measured framing is
      // reserved up front, so the assembled block can never exceed
      // priorReviewMaxTokens.
      const verdictLineTokens = (file: string): number =>
        estimateTokens(`- ${file} — last review verdict: ${reviewedFiles[file]?.verdict ?? "unknown"}`) + 2;
      const outlines = buildFileOutlines(
        cwd,
        priorFiles.map((p) => p.file),
        outlineBudget,
        verdictLineTokens,
      );
      if (outlines.files.length > 0) {
        const verdictLines = outlines.files
          .map((file) => `- ${file} — last review verdict: ${reviewedFiles[file]?.verdict ?? "unknown"}`)
          .join("\n");
        priorRoundContext = `${framing}${verdictLines}\n\n${outlines.context}`;
      }
    }
  }

  // Effective pre-review commands: explicit user config (any non-empty list)
  // wins; otherwise auto-detected from the reviewed project's package.json
  // when autoPreReviewCommands is enabled (min auto-detects nothing); else no
  // commands. Explicitly empty preReviewCommands does NOT trigger auto mode.
  const effectivePreReviewCommands = resolveEffectivePreReviewCommands(cwd, config, level);

  // Diff preparation runs BEFORE the cache key: when the combined diff hit the
  // reviewMaxDiffChars cap it is sliced at a byte boundary that can fall
  // MID-FILE — a boundary file's surviving slice is truthy but incomplete, and
  // tail files are missing entirely. Refetch EVERY reviewable file
  // individually (per-file diffs bypass the combined cap) and REPLACE the
  // combined slices, so the per-file parallel review covers each changed file
  // completely. Failed refetches drop the partial slice so the coverage math
  // below sees the file as skipped. Only relevant when per-file batches will
  // run. The per-file diffs are part of the cache key below, so an identical
  // capped combined text with different per-file content cannot replay a
  // stale cached verdict.
  const strategy = effectiveConfig.reviewStrategy ?? "auto";
  const explicitParallel = Boolean(config.parallelReview);
  const fileDiffs = splitDiffByFile(diff, vcs);
  // Supplemental-source policy must never remove an already captured patch
  // (for example dependency lockfiles) from parallel review coverage.
  const reviewableFiles = changedFiles.filter((file) => Boolean(fileDiffs[file]) || isReviewableFile(file));
  let perFileDiffsRebuilt = false;
  let perFileDiffsTruncated = false;
  // Files whose per-file diff itself hit the cap: their batches must still be
  // told their diff is truncated, and they count against full coverage.
  const perFileTruncated = new Set<string>();
  const shouldRebuildPerFileDiffs =
    truncated && reviewableFiles.length > 1 && (strategy !== "diff-only" || explicitParallel);
  if (shouldRebuildPerFileDiffs) {
    for (const file of reviewableFiles) {
      const perFile = getDiff(cwd, { ...diffOptions, files: [file] });
      if (perFile.changedFiles.includes(file) && perFile.diff) {
        fileDiffs[file] = perFile.diff;
        if (perFile.truncated) {
          perFileDiffsTruncated = true;
          perFileTruncated.add(file);
        }
      } else {
        delete fileDiffs[file];
      }
    }
    perFileDiffsRebuilt = true;
  }

  // Cache key: every STABLE prompt input. Pre-review COMMANDS are keyed (not
  // their output — commands are deterministic given cwd, and this keeps a
  // cache hit from re-running them), along with codemap, design rules, related
  // context, level instructions, the effective tool-loop setting, both token
  // caps, and the level. The session context is INTENTIONALLY excluded: it
  // changes on every turn, so including it would make every key unique and
  // the cache useless; the reviewed artifact (diff + files + conventions +
  // memory) is identical regardless of the conversation that led here.
  const cacheKey = buildCacheKey("review", {
    diff,
    // When the combined diff was capped, the reviewed artifact is the set of
    // per-file diffs: key entries by identity, content, AND truncation state
    // (a diff exactly equal to the cap and a longer diff sharing that capped
    // prefix have identical text but different coverage), so identical capped
    // combined TEXT cannot replay a stale cached verdict.
    perFileDiffs: shouldRebuildPerFileDiffs
      ? reviewableFiles.map((file) => ({
          file,
          diff: fileDiffs[file] ?? null,
          truncated: perFileTruncated.has(file),
        }))
      : undefined,
    description,
    modelProfile,
    modelCapacity: { contextWindow: modelConfig.contextWindow, maxOutputTokens: modelConfig.maxOutputTokens },
    language: config.language,
    currentStep,
    // Plan progress is part of the key: without it, a cached review with
    // stepComplete/consensus auto-advance could replay after a tracker
    // regression (identical step description + identical diff within the
    // TTL) and advance the plan without a fresh model call.
    workspaceFingerprint,
    planProgress: state.plan ? `${state.completedSteps}/${state.totalSteps}` : "none",
    options,
    reviewMaxDiffChars: effectiveConfig.reviewMaxDiffChars,
    reviewMaxInputTokens: effectiveConfig.reviewMaxInputTokens,
    reviewStrategy: effectiveConfig.reviewStrategy,
    reviewFullFileThresholdLines: config.reviewFullFileThresholdLines,
    parallelReview: config.parallelReview,
    reviewBatchFiles: config.reviewBatchFiles ?? 1,
    selfVerify: config.selfVerify,
    conventionsText,
    memoryContext,
    // The finalized prior context itself (not a digest): buildCacheKey hashes
    // the payload, so ANY change to the assembled context — outlines, verdict
    // lines, truncation — invalidates the cached review.
    priorRoundContext,
    decisionsText,
    codemap,
    designRefText,
    instructionsText,
    relatedContext,
    levelInstructions: reviewSettings.instructions,
    level,
    toolUseLoop: effectiveToolUseLoop,
    codemapMaxTokens: effectiveConfig.codemapMaxTokens,
    relatedContextMaxTokens: effectiveConfig.relatedContextMaxTokens,
    autoPreReviewCommands: config.autoPreReviewCommands ?? false,
    preReviewCommands: effectivePreReviewCommands,
  });

  {
    const cached = effectivePreReviewCommands.length ? undefined : getCachedReview(cwd, cacheKey);
    if (cached) {
      progress(3, STAGES.review, "Using cached review result…");
      if (!workspaceMatches(cwd, workspace))
        return { action: "review", error: "Workspace changed during cached review." };
      recordCompletionEvidence(cwd, workspaceFingerprint, [], `Cached review: ${cached.review.verdict}`);
      // A cached pass is still a completed review: keep the baseline in sync
      // so a baseline reset (new plan/session) cannot leave the next review
      // re-diffing already-reviewed commits.
      updateRangeState(cwd, vcsInfo, diffOptions, cached.review);
      recordReviewedFiles(cwd, changedFiles, cached.review.verdict);
      cached.review.scopeLimited = !wholeTreeReview;
      return {
        action: "review",
        workspaceFingerprint,
        review: cached.review,
        model: cached.model,
        cost: cached.cost,
        level,
      };
    }
  }

  progress(3, STAGES.review, "Calculating token budget…");
  const baseBudget = calculateReviewBudget(
    modelConfig.provider,
    modelConfig.id,
    effectiveConfig,
    {
      systemPrompt: "",
      sessionContext,
      conventionsText,
      preReviewOutput: "",
      description,
      memoryContext,
    },
    modelConfig,
  );

  // Effective pre-review commands: explicit user config (any non-empty list)
  // wins; otherwise auto-detected from the reviewed project's package.json
  // when autoPreReviewCommands is enabled (min auto-detects nothing); else no
  // commands. Explicitly empty preReviewCommands does NOT trigger auto mode.
  // (Already resolved above for the cache key.)
  let preReviewOutput = "";
  let checks: Array<{ command: string; exitCode: number }> = [];
  if (effectivePreReviewCommands.length > 0) {
    progress(4, STAGES.review, "Running pre-review commands…");
    const results = await runPreReviewCommands(cwd, effectivePreReviewCommands, {
      signal,
      preReviewTimeoutMs: config.preReviewTimeoutMs,
    });
    signal?.throwIfAborted();
    checks = results.map(({ command, exitCode }) => ({ command, exitCode }));
    preReviewOutput = formatPreReviewOutput(results);
    const preReviewChars = baseBudget.availableInputTokens * 4;
    if (preReviewChars <= 0) {
      preReviewOutput = "";
    } else if (preReviewOutput.length > preReviewChars) {
      preReviewOutput = preReviewOutput.slice(0, preReviewChars) + "\n… (truncated to token budget)";
    }
  } else {
    progress(4, STAGES.review, "Preparing review context…");
  }

  const fullFileThresholdLines = config.reviewFullFileThresholdLines ?? 300;
  progress(5, STAGES.review, "Calculating token budget with pre-review output…");
  const budgetWithPreReview = calculateReviewBudget(
    modelConfig.provider,
    modelConfig.id,
    effectiveConfig,
    {
      systemPrompt: "",
      sessionContext,
      conventionsText,
      preReviewOutput,
      description,
      memoryContext,
    },
    modelConfig,
  );
  progress(6, STAGES.review, "Loading changed file contents…");
  // fileDiffs/reviewableFiles/perFileDiffs* were prepared before the cache key.
  const filesWithDiff = reviewableFiles.filter((file) => fileDiffs[file] || !truncated);
  const skippedDueToTruncation = reviewableFiles.filter((file) => !fileDiffs[file] && truncated);
  const commonBatch = (
    files: string[],
    memory = memoryContext,
    batchBudget = budgetWithPreReview,
  ): ReviewBatchInput => ({
    cwd,
    description,
    files: [],
    diff: "",
    vcs,
    criteria,
    currentStep,
    sessionContext,
    conventionsText,
    preReviewOutput,
    memoryContext: memory,
    decisionsContext: decisionsText,
    priorRoundContext,
    relatedContext,
    codemap,
    designRefText,
    instructionsText,
    truncated: false,
    droppedFiles: [],
    budget: batchBudget,
    modelConfig,
    signal,
    sessionManager: ctx.sessionManager,
    relevantPaths: files,
    nativeJson,
    focusFiles: stepFocusFiles,
    assignment: { files, batchIndex: 999999, batchCount: 999999, hunk: { index: 999999, count: 999999 } },
    evidencePackMaxTokens: effectiveConfig.evidencePackMaxTokens ?? 1200,
    levelInstructions: reviewSettings.instructions,
    ...toolLoopOptions(loopConfig),
  });
  const combinedAllowance = reviewDiffAllowance(commonBatch(filesWithDiff));
  const diffLikelyTruncated = estimateTokens(diff) > combinedAllowance;
  const shouldParallelize =
    (explicitParallel || ((diffLikelyTruncated || truncated) && strategy !== "diff-only")) &&
    filesWithDiff.length > 0 &&
    (strategy !== "diff-only" || explicitParallel);
  const maxConcurrency =
    typeof config.parallelReview === "number" && config.parallelReview > 0 ? config.parallelReview : 3;

  // Diff-only reviews (the min level default, or explicit diff-only config)
  // cannot split the diff into hunks: without explicit parallelReview a
  // single model call must see the whole change, and when the diff exceeds
  // the context-derived budget we fail loudly with guidance instead of
  // silently truncating the diff and reviewing only a fragment (the old
  // behavior produced unreliable "diff truncated · context limited" reviews).
  // With explicit parallelReview the change is split per file instead; the
  // only remaining hard stop is a SINGLE file whose diff alone still exceeds
  // the per-file budget (that file would need med/high hunk-splitting). The
  // budget math mirrors runReviewBatch's remainingForDiff so a diff that fits
  // never errors here.
  if (strategy === "diff-only") {
    const remainingForDiff = combinedAllowance;
    const diffTokens = estimateTokens(diff);
    if (diffTokens > remainingForDiff && !shouldParallelize) {
      progress(7, STAGES.review, "Diff too large for a diff-only review…");
      const parallelHint =
        filesWithDiff.length > 1 ? " Enable pi-yoowai.parallelReview for a per-file parallel diff-only review, or" : "";
      // The attempted range was not reviewed: pin it so a re-run at a higher
      // level (or with scoping) still sees the whole range.
      pinAttemptedRange(cwd, vcsInfo, diffOptions);
      return {
        action: "review",
        error: `The change is too large for a diff-only (${level} level) review: the diff needs ~${diffTokens.toLocaleString()} tokens but the model's available context budget is ~${remainingForDiff.toLocaleString()} tokens.${parallelHint} Re-run with wai_review_med or wai_review_high (they split large diffs automatically), or scope the review with files:[...].`,
        model: modelProfile,
        level,
      };
    }
    // Explicit parallel review is active: the whole diff fits only because it
    // is split per file, so make sure EVERY per-file diff also fits its own
    // budget — a single oversized file would be truncated inside the batch.
    if (shouldParallelize) {
      const oversizedFile = filesWithDiff.find((file) => {
        const perFileTokens = estimateTokens(fileDiffs[file] ?? "");
        return perFileTokens > reviewDiffAllowance(commonBatch([file]));
      });
      if (oversizedFile) {
        progress(7, STAGES.review, "A single file's diff exceeds the model budget…");
        pinAttemptedRange(cwd, vcsInfo, diffOptions);
        return {
          action: "review",
          error: `The diff of \`${oversizedFile}\` (~${estimateTokens(fileDiffs[oversizedFile] ?? "").toLocaleString()} tokens) exceeds the model's per-file available context budget (~${remainingForDiff.toLocaleString()} tokens), so a parallel diff-only review would truncate it. Re-run with wai_review_med or wai_review_high (they split individual files into hunks), or scope the review with files:[...].`,
          model: modelProfile,
          level,
        };
      }
    }
  }

  let review: ReviewResult | undefined;
  let cost: UsageCost | undefined;
  let finalDiffTruncated: boolean;
  let finalDroppedFiles: string[];
  let continuationRounds: number;
  let continuationTruncated: boolean;
  // Set when a hunk/parallel batch had failed tasks: the merged result is
  // incomplete and must not advance the baseline or record a pass verdict.
  let reviewIncomplete = false;
  const execution: ReviewExecution = {
    batches: 0,
    segments: 0,
    modelCalls: 0,
    contextRequests: 0,
    modelTimeMs: 0,
    contextTimeMs: 0,
    verificationTimeMs: 0,
  };
  const addExecution = (value?: ReviewExecution) => {
    if (value) for (const key of Object.keys(execution) as Array<keyof ReviewExecution>) execution[key] += value[key];
  };

  if (shouldParallelize) {
    progress(
      7,
      STAGES.review,
      `Reviewing ${filesWithDiff.length} files in parallel with ${secondaryModelLabel(modelConfig)}${diffLikelyTruncated && !config.parallelReview ? " (auto: diff too large for single review)" : ""}…`,
    );

    const sharedContextEstimate = [
      sessionContext,
      conventionsText,
      preReviewOutput,
      description,
      // Every model call also receives the injected instructions and the
      // prior-round context (it is part of every batch prompt).
      instructionsText,
      priorRoundContext,
    ].join("\n");
    const outputEstimate =
      modelConfig.thinking && modelConfig.thinking.toLowerCase() !== "off"
        ? (modelConfig.maxOutputTokens ?? 8192)
        : 2048;

    interface FilePrep {
      file: string;
      fileMemoryContext: string;
      fileBudget: ReviewBudget;
      fileResult: Awaited<ReturnType<typeof loadFileContentsForReview>>;
      droppedForBudget: string[];
    }
    const preps = await Promise.all(
      filesWithDiff.map(async (file): Promise<FilePrep> => {
        const fileMemoryContext = truncateToTokenBudget(
          `${getPastIssuesForFiles(cwd, [file], description)}\n${findingGuidance(cwd)}`.trim(),
          effectiveConfig.reviewMaxMemoryTokens ?? 800,
        );
        const fileBudget = calculateReviewBudget(
          modelConfig.provider,
          modelConfig.id,
          effectiveConfig,
          {
            systemPrompt: "",
            sessionContext,
            conventionsText,
            preReviewOutput,
            description,
            memoryContext: fileMemoryContext,
          },
          modelConfig,
        );
        const fileResult = await loadFileContentsForReview({
          cwd,
          changedFiles: [file],
          budget: fileBudget,
          strategy,
          fullFileThresholdLines,
        });
        const droppedForBudget = fileResult.dropped.filter((f) => isReviewableFile(f));
        return { file, fileMemoryContext, fileBudget, fileResult, droppedForBudget };
      }),
    );

    const batchBudget = (items: FilePrep[]) =>
      calculateReviewBudget(
        modelConfig.provider,
        modelConfig.id,
        effectiveConfig,
        {
          systemPrompt: "",
          sessionContext,
          conventionsText,
          preReviewOutput,
          description,
          memoryContext: [...new Set(items.map((p) => p.fileMemoryContext))].join("\n\n"),
        },
        modelConfig,
      );
    const contextTokens = [
      codemap,
      designRefText,
      instructionsText,
      priorRoundContext,
      decisionsText,
      relatedContext,
    ].reduce((total, text) => total + estimateTokens(text ?? ""), 0);
    const groups = groupRelatedReviewFiles(
      preps.map((p) => ({ ...p, content: p.fileResult.entries.map((entry) => entry.content).join("\n") })),
      config.reviewBatchFiles ?? 1,
      (items) => {
        if (
          items.some(
            (p) =>
              p.droppedForBudget.length ||
              perFileTruncated.has(p.file) ||
              p.fileResult.entries.length === 0 ||
              p.fileResult.entries.some((entry) => entry.mode !== "full"),
          )
        )
          return false;
        const tokens = items.reduce(
          (total, p) => total + p.fileResult.totalTokens + estimateTokens(fileDiffs[p.file] ?? ""),
          0,
        );
        const budget = batchBudget(items);
        return (
          tokens + contextTokens + 1000 + (effectiveConfig.evidencePackMaxTokens ?? 1200) <=
          Math.min(budget.availableInputTokens, budget.hardInputCap ?? Infinity)
        );
      },
    );
    let batches: Array<{
      files: string[];
      fileMemoryContext: string;
      fileBudget: ReviewBudget;
      fileResult: { entries: FileContentEntry[]; dropped: string[] };
      droppedForBudget: string[];
      diff: string;
      hunk?: { index: number; count: number };
    }>;
    try {
      const fittingGroups = groups.flatMap((items) => {
        const fileBudget = items.length === 1 ? items[0].fileBudget : batchBudget(items);
        const memory = [...new Set(items.map((p) => p.fileMemoryContext))].join("\n\n");
        const input = commonBatch(
          items.map((p) => p.file),
          memory,
          fileBudget,
        );
        return items.length > 1 &&
          estimateTokens(items.map((p) => fileDiffs[p.file] ?? "").join("\n")) > reviewDiffAllowance(input)
          ? items.map((item) => [item])
          : [items];
      });
      batches = fittingGroups.flatMap((items) => {
        const files = items.map((p) => p.file);
        const fileMemoryContext = [...new Set(items.map((p) => p.fileMemoryContext))].join("\n\n");
        const fileBudget = items.length === 1 ? items[0].fileBudget : batchBudget(items);
        const parts = splitReviewDiff(
          items.map((p) => fileDiffs[p.file] ?? "").join("\n"),
          reviewDiffAllowance(commonBatch(files, fileMemoryContext, fileBudget)) * 4,
        );
        return parts.map((diff, index) => ({
          files,
          fileMemoryContext,
          fileBudget,
          diff,
          fileResult: {
            entries: items.flatMap((p) => p.fileResult.entries),
            dropped: items.flatMap((p) => p.fileResult.dropped),
          },
          droppedForBudget: items.flatMap((p) => p.droppedForBudget),
          hunk: parts.length > 1 ? { index: index + 1, count: parts.length } : undefined,
        }));
      });
    } catch (error) {
      pinAttemptedRange(cwd, vcsInfo, diffOptions);
      return {
        action: "review",
        level,
        model: modelProfile,
        review: {
          verdict: "needs-work",
          issues: [],
          suggestions: [String(error)],
          consensus: false,
          contextLimited: true,
          inputIncomplete: true,
          inconclusive: true,
          coverageGaps: filesWithDiff,
          stepComplete: false,
        },
      };
    }
    logEvent(cwd, "info", "Review batches prepared", {
      fileCount: preps.length,
      batchCount: batches.length,
      filesPerBatch: batches.map((p) => p.files),
      reviewBatchFiles: config.reviewBatchFiles ?? 1,
    });

    let projectedCost = 0;
    for (const p of batches) {
      const contentTokens = p.fileResult.entries.reduce((sum, e) => sum + e.tokenEstimate, 0);
      const diffTokens = estimateTokens(p.diff);
      const inputEstimate =
        1000 + estimateTokens(sharedContextEstimate) + contentTokens + diffTokens + estimateTokens(p.fileMemoryContext);
      projectedCost += estimateCost(modelConfig.provider, modelConfig.id, inputEstimate, outputEstimate);
    }
    if (config.costBudgetUsd !== undefined && config.costBudgetUsd >= 0) {
      const sessionCost = getSessionCost(cwd).costUsd;
      if (sessionCost + getReservedCost(cwd) + projectedCost > config.costBudgetUsd) {
        pinAttemptedRange(cwd, vcsInfo, diffOptions);
        return {
          action: "review",
          error: `Parallel review would exceed the configured cost budget (${formatCost(config.costBudgetUsd)}).`,
        };
      }
    }

    const tasks = batches.map((p, batchIndex) => async () => {
      const started = Date.now();
      logEvent(cwd, "info", "Review batch started", {
        files: p.files,
        provider: modelConfig.provider,
        model: modelConfig.id,
        thinking: modelConfig.thinking,
      });
      try {
        const result = await runReviewBatch({
          cwd,
          description,
          files: p.fileResult.entries,
          diff: p.diff,
          vcs,
          criteria,
          currentStep,
          sessionContext,
          conventionsText,
          preReviewOutput,
          memoryContext: p.fileMemoryContext,
          decisionsContext: decisionsText,
          priorRoundContext,
          relatedContext,
          codemap,
          designRefText,
          instructionsText,
          // After a successful rebuild each batch's diff is complete: only its
          // own per-file cap should mark it truncated, not the original
          // combined-diff cap.
          truncated: shouldRebuildPerFileDiffs ? p.files.some((file) => perFileTruncated.has(file)) : truncated,
          droppedFiles: [],
          omittedFileContents: p.fileResult.dropped,
          budget: p.fileBudget,
          modelConfig,
          signal,
          sessionManager: ctx.sessionManager,
          relevantPaths: p.files,
          assignment: { files: p.files, batchIndex: batchIndex + 1, batchCount: batches.length, hunk: p.hunk },
          allowAdaptiveToolContext: config.toolUseLoop === undefined || config.toolUseLoop === true,
          progress,
          nativeJson,
          focusFiles: stepFocusFiles,
          evidencePackMaxTokens: effectiveConfig.evidencePackMaxTokens ?? 1200,
          levelInstructions: reviewSettings.instructions,
          ...toolLoopOptions(loopConfig),
        });
        addExecution(result.execution);
        progress(
          8,
          STAGES.review,
          `Completed batch ${batchIndex + 1}/${batches.length}: ${p.files.join(", ")}${p.hunk ? ` (segment ${p.hunk.index}/${p.hunk.count})` : ""}`,
        );
        logEvent(cwd, "info", "Review batch completed", {
          files: p.files,
          elapsedMs: Date.now() - started,
          verdict: result.review.verdict,
          truncated: result.truncated || result.review.truncated,
        });
        return {
          files: p.files,
          review: result.review,
          usage: result.usage,
          dropped: [],
          rounds: result.rounds,
          truncated: result.truncated,
        };
      } catch (error) {
        logEvent(cwd, signal?.aborted ? "info" : "warn", "Review batch stopped", {
          files: p.files,
          elapsedMs: Date.now() - started,
          cancelled: signal?.aborted === true,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });

    const outcomes: ConcurrencyOutcome<{
      files: string[];
      review: ReviewResult;
      usage: UsageCost;
      dropped: string[];
      rounds?: number;
      truncated?: boolean;
    }>[] = await runWithConcurrencyLimit(tasks, maxConcurrency, signal);

    const successes: {
      files: string[];
      review: ReviewResult;
      usage: UsageCost;
      dropped: string[];
      rounds?: number;
      truncated?: boolean;
    }[] = [];
    const failures: string[] = [];
    const failedFiles = new Set<string>();
    for (const [batchIndex, outcome] of outcomes.entries()) {
      if (outcome.ok) {
        successes.push(outcome.value);
      } else {
        for (const file of batches[batchIndex].files) failedFiles.add(file);
        failures.push(
          `${batches[batchIndex].files.join(", ")}: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
        );
      }
    }

    if (successes.length === 0) {
      // Every batch failed: pin the attempted (scoped-aware) range so moving
      // HEAD cannot drop it before a successful retry.
      pinAttemptedRange(cwd, vcsInfo, diffOptions);
      return { action: "review", error: failures.join("; "), model: modelProfile };
    }

    review = mergeReviewResults(successes.map((s) => s.review));
    for (const { usage } of successes) {
      const recorded = recordCostWithBudget(cwd, usage);
      cost = cost ? mergeUsageCost(cost, recorded) : recorded;
    }
    finalDroppedFiles = Array.from(new Set(successes.flatMap((s) => s.dropped).concat(skippedDueToTruncation)));
    if (finalDroppedFiles.length > 0)
      review.droppedFiles = Array.from(new Set([...(review.droppedFiles ?? []), ...finalDroppedFiles]));
    // Coverage completeness: a capped COMBINED diff no longer means
    // incomplete coverage when the rebuild covered every file individually
    // (perFileDiffsRebuilt && nothing skipped && no per-file cap); a
    // truncated batch response still does. Non-truncated diffs are always
    // complete.
    const coverageComplete =
      !truncated || (perFileDiffsRebuilt && skippedDueToTruncation.length === 0 && !perFileDiffsTruncated);
    finalDiffTruncated = !coverageComplete || successes.some((s) => s.review.truncated);
    continuationRounds = successes.reduce((sum, s) => sum + (s.rounds ?? 0), 0);
    continuationTruncated = successes.some((s) => s.truncated);

    if (
      batches.some((batch) => batch.hunk) &&
      !failures.length &&
      !finalDiffTruncated &&
      !review.contextLimited &&
      !review.coverageGaps?.length
    ) {
      progress(8, STAGES.review, "Checking interactions across reviewed patch segments…");
      const integrationStarted = Date.now();
      const assessments = successes.map((success, index) => ({
        files: success.files,
        segment: batches[index].hunk,
        verdict: success.review.verdict,
        issues: success.review.issues,
        suggestions: success.review.suggestions,
      }));
      try {
        const integrated = await runReviewBatch({
          ...commonBatch(filesWithDiff),
          priorRoundContext: `${priorRoundContext}\nReviewed segment assessments (not source evidence):\n${JSON.stringify(assessments)}`,
          relatedContext: `${relatedContext ?? ""}\n${buildFileOutlines(cwd, filesWithDiff, 1200).context}`,
          assignment: { files: filesWithDiff, batchIndex: 1, batchCount: 1, integration: true },
          allowAdaptiveToolContext: config.toolUseLoop === undefined || config.toolUseLoop === true,
          progress,
        });
        addExecution(integrated.execution);
        review = mergeReviewResults([review, integrated.review]);
        if (!review.contextLimited && review.verdict === "pass") review.stepComplete = integrated.review.stepComplete;
        const recorded = recordCostWithBudget(cwd, integrated.usage);
        cost = cost ? mergeUsageCost(cost, recorded) : recorded;
        continuationRounds += integrated.rounds ?? 0;
        continuationTruncated ||= integrated.truncated;
      } catch (error) {
        signal?.throwIfAborted();
        review.contextLimited = true;
        review.coverageGaps = filesWithDiff;
        review.suggestions.push(
          `Segment integration check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      execution.verificationTimeMs += Date.now() - integrationStarted;
    }

    if (failures.length > 0) {
      review.suggestions.unshift(`Review failed for ${failedFiles.size} file(s): ${failures.join("; ")}`);
      review.consensus = false;
      reviewIncomplete = true;
      // Only the successful batches were actually reviewed: record them with
      // their own verdicts so prior context cannot claim a pass for files
      // whose batches failed. The failed files stay in range via the pending
      // anchor (the merged verdict must not advance anything).
      for (const s of successes) {
        recordReviewedFiles(
          cwd,
          s.files,
          s.review.truncated === true ||
            s.truncated === true ||
            s.review.contextLimited ||
            s.review.coverageGaps?.length ||
            s.review.inputIncomplete ||
            s.review.inconclusive ||
            s.files.some((file) => failedFiles.has(file))
            ? "needs-work"
            : s.review.verdict,
        );
      }
    }

    logEvent(cwd, "info", "Parallel review completed", {
      fileCount: preps.length,
      batchCount: batches.length,
      successCount: new Set(successes.flatMap((s) => s.files).filter((file) => !failedFiles.has(file))).size,
      failureCount: failedFiles.size,
      provider: modelConfig.provider,
      model: modelConfig.id,
      estimatedCostUsd: cost?.estimatedCostUsd,
    });
  } else {
    const fileResult =
      strategy === "diff-only"
        ? { entries: [] as FileContentEntry[], dropped: [] as string[], totalTokens: 0 }
        : await loadFileContentsForReview({
            cwd,
            changedFiles,
            budget: budgetWithPreReview,
            strategy,
            fullFileThresholdLines,
          });

    const finalDiff = diff;
    finalDiffTruncated = truncated;
    finalDroppedFiles = [...skippedDueToTruncation];

    progress(7, STAGES.review, "Building review prompt…");
    let result: Awaited<ReturnType<typeof runReviewBatch>>;
    try {
      result = await runReviewBatch({
        cwd,
        description,
        files: fileResult.entries,
        diff: finalDiff,
        vcs,
        criteria,
        currentStep,
        sessionContext,
        conventionsText,
        preReviewOutput,
        memoryContext,
        decisionsContext: decisionsText,
        priorRoundContext,
        relatedContext,
        codemap,
        designRefText,
        instructionsText,
        truncated: finalDiffTruncated,
        droppedFiles: finalDroppedFiles,
        omittedFileContents: fileResult.dropped,
        budget: budgetWithPreReview,
        modelConfig,
        signal,
        sessionManager: ctx.sessionManager,
        relevantPaths: Array.from(new Set([...(options.files ?? []), ...changedFiles])),
        assignment: { files: changedFiles, batchIndex: 1, batchCount: 1 },
        allowAdaptiveToolContext: config.toolUseLoop === undefined || config.toolUseLoop === true,
        progress,
        nativeJson,
        focusFiles: stepFocusFiles,
        evidencePackMaxTokens: effectiveConfig.evidencePackMaxTokens ?? 1200,
        levelInstructions: reviewSettings.instructions,
        ...toolLoopOptions(loopConfig),
      });
    } catch (err) {
      // The single batch failed entirely: the attempted range was NOT
      // reviewed, so pin it (scoped-aware) before returning — otherwise
      // moving HEAD would drop the whole range.
      pinAttemptedRange(cwd, vcsInfo, diffOptions);
      return {
        action: "review",
        error: err instanceof Error ? err.message : String(err),
        model: modelProfile,
      };
    }
    review = result.review;
    addExecution(result.execution);
    cost = recordCostWithBudget(cwd, result.usage);
    continuationRounds = result.rounds ?? 0;
    continuationTruncated = result.truncated ?? false;

    if (effectiveConfig.selfVerify && !review.contextLimited && !review.coverageGaps?.length) {
      progress(8, STAGES.review, "Self-verifying review result…");
      const verificationStarted = Date.now();
      execution.modelCalls++;
      try {
        const verified = await verifyResult(cwd, modelConfig, {
          originalSystem: result.system,
          originalUser: result.user,
          result: review,
          task: "review",
          instructionsText,
          signal,
          sessionManager: ctx.sessionManager,
          validate: validateReviewResult,
          validationErrors: getReviewValidationErrors,
          salvage: salvageReviewFromMarkdown,
        });
        // Local evidence metadata remains authoritative even if the verifier
        // returns only the core verdict fields.
        const omittedFileContents = review.omittedFileContents;
        review = verified.result;
        if (omittedFileContents?.length)
          review.omittedFileContents = Array.from(
            new Set([...omittedFileContents, ...(review.omittedFileContents ?? [])]),
          );
        cost = mergeVerifiedCost(cost, recordCostWithBudget(cwd, verified.usage));
      } catch (err) {
        logEvent(cwd, "warn", "Self-verification failed; keeping original review", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        const elapsed = Date.now() - verificationStarted;
        execution.verificationTimeMs += elapsed;
        execution.modelTimeMs += elapsed;
      }
    }
  }

  if (!review) {
    // The model call failed to produce a review: the attempted range was not
    // reviewed, so pin it before returning.
    pinAttemptedRange(cwd, vcsInfo, diffOptions);
    return { action: "review", error: "Review could not be produced", model: modelProfile };
  }

  signal?.throwIfAborted();
  progress(8, STAGES.review, "Review response received");
  review.scopeLimited = !wholeTreeReview;
  if (!wholeTreeReview) review.planStale = false;
  if (changedFiles.length > 0) {
    const changedFilesSet = new Set(changedFiles);
    const originalIssueCount = review.issues.length;
    review.issues = review.issues.filter((issue) => {
      if (!issue.file) return true;
      return changedFilesSet.has(issue.file);
    });
    if (review.issues.length < originalIssueCount) {
      logEvent(cwd, "info", "Filtered out-of-scope review issues", {
        original: originalIssueCount,
        kept: review.issues.length,
        removed: originalIssueCount - review.issues.length,
      });
    }
  }
  if (!workspaceMatches(cwd, workspace)) {
    return {
      action: "review",
      error: "Workspace changed or could not be fingerprinted during review. Review the current tree again.",
      cost,
      model: modelProfile,
      level,
    };
  }
  recordIssues(cwd, review.issues);
  if (checks.some((check) => check.exitCode !== 0)) {
    review.checksFailed = true;
    review.verdict = "needs-work";
    review.consensus = false;
    review.stepComplete = false;
    review.suggestions.push(
      "Configured checks failed. A model pass cannot certify failing checks; fix them and review again.",
    );
  }

  // Merge the model's own truncation signal into the diff-truncation flag for
  // every path (the single-batch path computes finalDiffTruncated before the
  // model call; hunk/parallel already fold batch flags in). A truncated pass
  // must hit the downgrade below, whatever the cause.
  // Merge every truncation signal into the diff-truncation flag for every
  // path (the single-batch path computes finalDiffTruncated before the model
  // call; hunk/parallel already fold batch flags in; self-verification may
  // set review.truncated after that). A truncated pass must hit the downgrade
  // below, whatever the cause.
  if (review.truncated || continuationTruncated) finalDiffTruncated = true;

  // A non-pass verdict with ZERO issues is not actionable: either the model
  // response was truncated and salvage recovered only a bare verdict, or the
  // verdict contradicts its own findings (issues empty, suggestions positive).
  // It is not a pass (no evidence of clean), but it must not count as a failed
  // review round or tell the user to fix nonexistent issues — mark it
  // inconclusive. Batch-failure reviews are NOT verdict slips: the
  // reviewIncomplete handling below re-marks them, so skip them here (their
  // suggestion must not claim the round was inconclusive).
  if (
    !reviewIncomplete &&
    !review.contextLimited &&
    !review.coverageGaps?.length &&
    !checks.some((check) => check.exitCode !== 0) &&
    (review.verdict === "needs-work" || review.verdict === "blocked") &&
    review.issues.length === 0
  ) {
    review.inconclusive = true;
    review.suggestions.push(
      review.planStale
        ? "The model flagged the active plan as stale but found no actionable code issue. This review cannot certify the plan step. Compare the cited mismatch with the current step, code, and developer decisions; correct tracker progress or update the plan only for a confirmed mismatch before another whole-tree review."
        : `The model returned a non-pass verdict without actionable code issues. ${INCONCLUSIVE_REVIEW_GUIDANCE}`,
    );
    logEvent(cwd, "warn", "Review verdict had no issues; marked inconclusive", {
      verdict: review.verdict,
      truncated: continuationTruncated,
    });
  }

  if ((review.verdict === "needs-work" || review.verdict === "blocked") && review.issues.length > 0) {
    const plan: string[] = [];
    for (const issue of review.issues) {
      const loc = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "the change";
      const action = issue.suggestion || issue.issue;
      plan.push(`Fix ${issue.severity} issue in ${loc}: ${action}`);
    }
    review.fixPlan = plan.filter((step, index) => index === 0 || step !== plan[index - 1]);
  }

  if (finalDiffTruncated) review.truncated = true;
  finalDroppedFiles = Array.from(new Set([...finalDroppedFiles, ...(review.droppedFiles ?? [])]));
  if (finalDroppedFiles.length > 0) review.droppedFiles = finalDroppedFiles;
  if (finalDiffTruncated || finalDroppedFiles.length > 0) {
    review.contextLimited = true;
    review.suggestions.push(
      "The change is large and some context was omitted. If the review missed something, scope it with --files or increase reviewMaxInputTokens.",
    );
  }

  if (review.verdict === "blocked" && (finalDiffTruncated || review.truncated || finalDroppedFiles.length > 0)) {
    review.verdict = "needs-work";
    review.consensus = false;
    review.suggestions.push(
      "Verdict was downgraded from 'blocked' to 'needs-work' because the review context was incomplete (truncated diff or omitted files); the review is inconclusive.",
    );
  }

  // A PASS on a truncated diff is not evidence of a clean change: the model
  // never saw part of the change, so advancing the baseline would permanently
  // skip unreviewed content. Downgrade to an inconclusive needs-work (no
  // baseline advance, no plan advance, no caching) and tell the user to
  // re-run scoped.
  if (finalDiffTruncated) {
    review.verdict = "needs-work";
    review.consensus = false;
    review.stepComplete = false;
    review.inconclusive = true;
    review.suggestions.push(
      "The diff was truncated, so the pass verdict cannot be trusted — re-run the review scoped with files:[...] (or with a larger budget) to cover the omitted part of the change.",
    );
  }

  if (review.contextLimited || review.coverageGaps?.length || review.inputIncomplete) {
    review.contextLimited = true;
    review.consensus = false;
    review.stepComplete = false;
    review.completedSteps = 0;
    review.inconclusive = true;
    if (review.verdict === "pass") review.verdict = "needs-work";
    review.suggestions.push(
      "Required review evidence is incomplete. Obtain the listed missing evidence before certification; this is a coverage gap, not an actionable code finding.",
    );
  }

  // An incomplete batch review is NOT a pass, whatever the surviving batches
  // said: downgrade the public verdict (callers gating on `verdict` must not
  // see success), block plan advancement, and refuse to cache it (a cached
  // pass would replay the merged verdict on retry and advance the
  // baseline / record passes for never-reviewed coverage). Batch failures
  // are definite failed rounds, so any earlier inconclusive marker is cleared
  // (the escalation counter must count the round).
  if (reviewIncomplete) {
    review.verdict = "needs-work";
    review.stepComplete = false;
    review.consensus = false;
    review.inconclusive = false;
  }

  if (
    !reviewIncomplete &&
    !review.inconclusive &&
    !finalDiffTruncated &&
    !finalDroppedFiles.length &&
    isWholeTreeReview(options)
  ) {
    review.suggestions.push(...recordFindingRound(cwd, review.issues));
  }
  recordCompletionEvidence(cwd, workspaceFingerprint, checks, `Review: ${review.verdict}`);

  // Incomplete and inconclusive reviews are never cached: a retry must
  // re-run the model (the inconclusive suggestion explicitly recommends a
  // re-run), and the cache-hit path (which applies the cached verdict to
  // baseline + recording) must never see a merged or verdict-slip result.
  if (!reviewIncomplete && !review.inconclusive) {
    setCachedResult(cwd, "review", cacheKey, { review, model: modelProfile, cost });
  }

  // Propose-only staleness: never touch the plan; surface the update
  // suggestion once per review round (auto-review on settle must not repeat
  // it for the same round). The suggestion annotates ONLY the result handed
  // to the caller — the cached payload stays raw so a later cache hit on an
  // identical diff does not replay it outside the guard.
  if (review.planStale && state.plan && planStaleSuggestionDue(cwd)) {
    review = {
      ...review,
      suggestions: [
        "Check the review's stale-plan evidence against the developer's requirements and current tracker step. For a confirmed plan change, use `/wai-plan-update` or `wai({ planUpdate: '<changed decision and remaining work>' })`; a partial diff or unfinished step alone does not require re-planning.",
        ...review.suggestions,
      ],
    };
    logEvent(cwd, "info", "Review flagged the plan as stale; suggested a plan update", {
      provider: modelConfig.provider,
      model: modelConfig.id,
    });
  }

  // Incremental-diff range state: a pass advances the baseline to HEAD and
  // clears the pending anchor; a non-pass (or an incomplete batch review)
  // keeps the baseline and pins a pending anchor so the failed changes stay
  // inside the next review's diff. The reviewed files are recorded (verdict
  // included) for prior-round context. Both run before the
  // plan-advance/auto-judge block so every pass return path (including the
  // auto-judge early return below) runs them exactly once.
  updateRangeState(
    cwd,
    vcsInfo,
    diffOptions,
    // Incomplete batch reviews always count as failed rounds even when the
    // surviving batches were inconclusive: the batches themselves failed.
    reviewIncomplete ? { verdict: "needs-work" } : review,
    // An inconclusive result caused by truncated/omitted coverage must still
    // pin the range so the unreviewed portion stays visible.
    { pinOnInconclusive: review.inconclusive === true && (finalDiffTruncated || finalDroppedFiles.length > 0) },
  );
  if (!reviewIncomplete) recordReviewedFiles(cwd, changedFiles, review.verdict);

  // Code quality and completion are separate: require explicit step-completion
  // evidence before advancing, even when every reviewer agrees the code passes.
  const advance = isWholeTreeReview(options)
    ? planAdvanceFromReview(
        review,
        state.plan !== undefined && state.totalSteps > 0,
        state.completedSteps >= state.totalSteps,
      )
    : null;
  if (advance) {
    if (advance.count > 0) {
      const newCompleted = Math.min(state.completedSteps + advance.count, state.totalSteps);
      markStepsComplete(cwd, newCompleted, true);
      auditStepDone(ctx, newCompleted, state.totalSteps, true);
    }
    const planProgress = getProgress(cwd);
    review.planProgress = `${planProgress.completed}/${planProgress.total} steps done`;
    if (planProgress.nextStep) {
      review.nextStep = planProgress.nextStep;
    }

    if (
      config.autoJudge &&
      resolveJudgeCouncilMembers(config).length > 0 &&
      !state.judgeCompleted &&
      planProgress.completed === planProgress.total &&
      planProgress.total > 0
    ) {
      progress(10, STAGES.review, "Auto-judging completed work…");
      const judgeProgress: ProgressReporter = (stage, _total, message) => {
        progress(STAGES.review, STAGES.review, `[judge] ${message}`);
      };
      try {
        const judgeResult = await executeWaiJudge(
          cwd,
          `All ${planProgress.total} plan steps completed.`,
          signal,
          judgeProgress,
          ctx.sessionManager,
        );
        signal?.throwIfAborted();
        if (judgeResult.judge) {
          review.autoJudged = true;
          markJudgeCompleted(cwd);
          const mergedCost =
            cost && judgeResult.cost ? mergeUsageCost(cost, judgeResult.cost) : (cost ?? judgeResult.cost);
          return {
            action: "review",
            workspaceFingerprint,
            review,
            judge: judgeResult.judge,
            cost: mergedCost,
            model: modelProfile,
            level,
            continuation: continuationMeta(continuationRounds, continuationTruncated),
            execution,
          };
        } else if (judgeResult.error) {
          review.suggestions.push(`Auto-judge failed: ${judgeResult.error}`);
        }
      } catch (err) {
        signal?.throwIfAborted();
        logEvent(cwd, "warn", "Auto-judge failed; keeping review result", {
          error: err instanceof Error ? err.message : String(err),
        });
        review.suggestions.push(
          `Auto-judge failed: ${err instanceof Error ? err.message : String(err)}. The review result is still available.`,
        );
      }
    }
  } else if (!review.inconclusive && review.verdict !== "pass") {
    // Inconclusive reviews (verdict with zero issues) are not failed rounds —
    // the model gave us nothing to act on, so they must not feed escalation.
    incrementReviewRounds(cwd);
    const updatedState = getState(cwd);
    if ((updatedState.reviewRounds[updatedState.completedSteps] ?? 0) >= 3) {
      review.escalated = true;
      review.suggestions.push(
        "This step has failed review 3 times. Consider regenerating the plan with `/wai-plan-update` or `wai({ planUpdate: '...' })`, breaking this step into smaller pieces, or asking the user for guidance.",
      );
    }
  }

  progress(10, STAGES.review, "Finalizing review…");
  return {
    action: "review",
    workspaceFingerprint,
    review,
    cost,
    model: modelProfile,
    level,
    continuation: continuationMeta(continuationRounds, continuationTruncated),
    execution,
  };
}
