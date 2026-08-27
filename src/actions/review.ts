import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { loadYoowaiConfig, resolveReviewTaskModel } from "../config.js";
import { resolveProjectPath } from "../path-security.js";
import {
  getDiff,
  splitDiffByFile,
  splitDiffByHunk,
  getVcsInfo,
  resolveGitCommit,
  resolveGitTree,
  resolveEmptyTree,
  type VcsInfo,
} from "../diff-grabber.js";
import { loadConventions, formatConventions } from "../conventions.js";
import { providerSupportsJsonObject, estimateCost } from "../secondary-model.js";
import { loadFileContentsForReview, isReviewableFile, type FileContentEntry } from "../file-loader.js";
import { buildRelatedContext, buildFileOutlines } from "../context-retrieval.js";
import { buildCodemap } from "../codemap.js";
import { formatDesignRulesForPrompt, isUiFile } from "../design-ref.js";
import { capActionInstructions } from "../instructions.js";
import { buildAstContext } from "../ast-context.js";
import { getPastIssuesForFiles, recordIssues } from "../review-memory.js";
import { runPreReviewCommands, formatPreReviewOutput } from "../pre-review.js";
import { resolveEffectivePreReviewCommands, resolveEffectiveToolLoop } from "./context-shared.js";
import { calculateReviewBudget, estimateTokens, truncateToTokenBudget, type ReviewBudget } from "../token-budget.js";
import { getSessionCost, formatCost, reserveCost, releaseCost } from "../cost-tracker.js";
import { logEvent } from "../logger.js";
import {
  getState,
  markStepsComplete,
  incrementReviewRounds,
  getProgress,
  markJudgeCompleted,
  getLastReviewedCommit,
  setLastReviewedCommit,
  getPendingReviewCommit,
  setPendingReviewCommit,
  getReviewedFiles,
  recordReviewedFiles,
  planStaleSuggestionDue,
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
import {
  getSessionContext,
  runWithConcurrencyLimit,
  mergeReviewResults,
  runReviewBatch,
  type ConcurrencyOutcome,
} from "./review-helpers.js";
import { executeWaiJudge } from "./judge.js";
import { resolveBackendType } from "../backends/backend-resolver.js";
import { validateReviewResult, getReviewValidationErrors, salvageReviewFromMarkdown } from "../prompts.js";
import { verifyResult, mergeVerifiedCost } from "./verify.js";
import { buildCacheKey, getCachedReview, setCachedResult } from "../review-cache.js";
import { resolveReviewSettings } from "../review-level.js";
import type { ProgressReporter } from "../progress.js";
import type { WaiToolResult, ReviewResult, UsageCost, ReviewLevel } from "../types.js";

/** Error returned when no review model can be resolved — the effective level
 *  drives the per-level task lookup (reviewMin/reviewMed/reviewHigh) with the
 *  `review` task and finally `secondary` as fallbacks. Exported so callers and
 *  tests can reference the exact message. */
export const REVIEW_NO_MODEL_ERROR =
  "No secondary model configured. Set pi-yoowai.secondary, taskModels.review, or taskModels.reviewMin/reviewMed/reviewHigh in settings.json.";

/** Update the incremental-diff range state AFTER a completed review.
 *  - pass: the baseline advances to HEAD (skipping the just-reviewed
 *    commits) and any pending anchor is cleared.
 *  - non-pass (whole-tree reviews only): the accepted baseline stays put, but
 *    a stable pending anchor keeps the reviewed range inside the next
 *    review's diff. Without it, a clean-tree review with no baseline would
 *    re-resolve HEAD~1 dynamically and drop the failed round once HEAD
 *    moves (e.g. a failed review of A, then commit B: HEAD~1 is A, so
 *    A..B excludes A).
 *  - inconclusive reviews are NOT failed rounds (verdict slip or truncation
 *    with no actionable issues): neither the baseline nor the pending anchor
 *    moves.
 *  - Scoped reviews only certify part of the tree and never touch the range
 *    state. */
function updateReviewRangeState(
  cwd: string,
  vcsInfo: VcsInfo,
  diffOptions: { since?: string; revision?: string; files?: string[]; exclude?: string[]; vcs?: "git" | "svn" },
  review: Pick<ReviewResult, "verdict" | "inconclusive">,
  opts?: { pinOnInconclusive?: boolean },
): void {
  if (vcsInfo.type !== "git" || !vcsInfo.revision) return;
  // An explicit VCS override that is not git means this review is not a git
  // review: never touch git range state for it.
  if (diffOptions.vcs && diffOptions.vcs !== "git") return;
  // Scoped reviews only certify part of the tree: they never touch the
  // baseline or the pending anchor, regardless of verdict. (Scoped diffs are
  // self-contained — they do not use the range — so a scoped coverage-
  // inconclusive result loses nothing: it is simply not cached and the user
  // is asked to re-run scoped.)
  if (diffOptions.files?.length || diffOptions.exclude?.length) return;
  // An inconclusive result is not a failed review round: nothing moves —
  // UNLESS the inconclusive result came from truncated/omitted coverage, in
  // which case the unreviewed portion must stay visible (pin the range).
  if (review.inconclusive === true && !opts?.pinOnInconclusive) return;
  if (review.verdict === "pass") {
    setLastReviewedCommit(cwd, vcsInfo.revision);
    setPendingReviewCommit(cwd, undefined);
    return;
  }
  const anchor = diffOptions.since ?? diffOptions.revision;
  // Resolve to an absolute commit OR tree SHA (the empty-tree root-commit
  // base is a tree object). A relative anchor (e.g. a user-supplied
  // `since: "HEAD~1"`) would re-resolve to a different commit once HEAD
  // moves, recreating the blind spot the anchor exists to prevent.
  const resolvedAnchor = anchor ? (resolveGitCommit(cwd, anchor) ?? resolveGitTree(cwd, anchor)) : undefined;
  if (resolvedAnchor) setPendingReviewCommit(cwd, resolvedAnchor);
}

/** Decide whether a passing review advances the plan tracker, and by how
 *  many steps. Guards the guarded auto-completion contract:
 *  - consensus (verdict "pass" with zero issues) advances by the model's
 *    relative "completedSteps" count (default 1), as before;
 *  - an explicit stepComplete: true signal advances exactly one step (the
 *    current one) even when minor issues remain, because the model
 *    explicitly confirmed the step's work is finished and covered;
 *  - anything else (needs-work/blocked, or a bare pass without stepComplete
 *    and without consensus) does not advance.
 *  Returns null when no plan is active; when the plan is already complete the
 *  returned count is 0 (bookkeeping may still run, auto-advance must not). */
export function planAdvanceFromReview(
  review: Pick<ReviewResult, "verdict" | "consensus" | "stepComplete" | "completedSteps">,
  planActive: boolean,
  planComplete: boolean,
): { count: number } | null {
  if (!planActive) return null;
  if (review.consensus) {
    const count = typeof review.completedSteps === "number" && review.completedSteps > 1 ? review.completedSteps : 1;
    return { count: planComplete ? 0 : count };
  }
  if (review.verdict === "pass" && review.stepComplete === true) {
    return { count: planComplete ? 0 : 1 };
  }
  return null;
}

export async function executeWaiReview(
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
  const config = loadYoowaiConfig(cwd);
  const reviewSettings = resolveReviewSettings(config, options.level);
  const level = reviewSettings.level;
  const effectiveConfig = { ...config, ...reviewSettings };
  // Resolve the model from the EFFECTIVE level, not the tool override: the
  // generic `wai review` (and auto-review, /wai review) runs at the resolved
  // level (config.reviewLevel ?? model-derived default), so it must honor the
  // per-level reviewMin/reviewMed/reviewHigh task models the same way the
  // explicit tools do. Configs without per-level entries fall back to the
  // `review` task, so existing setups are unchanged.
  const modelConfig = resolveReviewTaskModel(config, level);
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "review", error: REVIEW_NO_MODEL_ERROR };
  }
  const modelProfile = {
    provider: modelConfig.provider,
    id: modelConfig.id,
    thinking: modelConfig.thinking,
    backend: resolveBackendType(modelConfig.provider, modelConfig),
  };
  const nativeJson = providerSupportsJsonObject(modelConfig.provider, modelConfig.id, modelConfig);

  // Level-aware tool loop: min stays a single cheap call by default, med/high
  // let the reviewer pull the exact context it needs (read_file/search_code/
  // read-only commands). Explicit toolUseLoop config always wins. Resolved
  // here so the cache key and every runReviewBatch call share one value.
  const effectiveToolUseLoop = resolveEffectiveToolLoop(config, level);
  const loopConfig = { ...config, toolUseLoop: effectiveToolUseLoop };

  const state = getState(cwd);
  const currentStep =
    state.plan && state.completedSteps < state.plan.todo.length
      ? planStepDescription(state.plan.todo[state.completedSteps])
      : undefined;
  // Files edited since the current step started (the list resets when a step
  // completes): a focus hint for the reviewer, never a diff filter.
  const stepFocusFiles =
    state.plan && state.editedFiles && state.editedFiles.length > 0 ? state.editedFiles : undefined;

  progress(1, STAGES.review, "Collecting diff…");
  const diffOptions = {
    ...options,
    maxDiffChars: effectiveConfig.reviewMaxDiffChars,
    untracked: options.untracked ?? true,
  };
  const vcsInfo = getVcsInfo(cwd);
  // An explicit VCS override must win over auto-detection for the range
  // logic: git incremental SHAs must never feed an SVN diff or write git
  // review state for an SVN review.
  const gitReview = vcsInfo.type === "git" && (options.vcs ?? vcsInfo.type) === "git";
  const lastReviewed = getLastReviewedCommit(cwd);
  // Persisted anchors may be stale or hand-edited garbage: verify they still
  // resolve before using them as a diff base (the pending anchor may be a
  // tree — the empty-tree root-commit base — so accept commits AND trees).
  const pendingAnchor = getPendingReviewCommit(cwd);
  const pendingValid =
    gitReview && pendingAnchor && (resolveGitCommit(cwd, pendingAnchor) ?? resolveGitTree(cwd, pendingAnchor))
      ? pendingAnchor
      : undefined;
  const baselineValid = gitReview && lastReviewed && resolveGitCommit(cwd, lastReviewed) ? lastReviewed : undefined;
  const canUseIncremental =
    gitReview &&
    !vcsInfo.dirty &&
    !diffOptions.revision &&
    !diffOptions.since &&
    !diffOptions.files?.length &&
    !diffOptions.exclude?.length;
  if (canUseIncremental && (pendingValid ?? baselineValid)) {
    // A pending anchor from a failed review wins over the accepted baseline:
    // the failed range must stay the diff base until a pass clears it (they
    // coincide in the common flow, but a restart or state edit can diverge
    // them).
    diffOptions.since = pendingValid ?? baselineValid;
  } else if (!diffOptions.revision && !diffOptions.since) {
    // Clean tree with no stored baseline (fresh plan/session after committed
    // work): review the most recent commit instead of an empty `git diff
    // HEAD`. A pending anchor from a failed review wins over the dynamic
    // HEAD~1 (which would skip the failed round once HEAD moves); resolved to
    // an absolute SHA so it stays stable. A root commit has no HEAD~1 and
    // falls back to HEAD.
    if (gitReview && !vcsInfo.dirty) {
      // A pending anchor from a failed review wins over the dynamic HEAD~1
      // (which would skip the failed round once HEAD moves). A root commit
      // (no HEAD~1) diffs against the empty tree so it can actually be
      // reviewed instead of producing an empty `git diff HEAD`.
      const freshBase = pendingValid ?? resolveGitCommit(cwd, "HEAD~1") ?? resolveEmptyTree(cwd);
      if (freshBase) {
        diffOptions.since = freshBase;
      } else {
        diffOptions.revision = vcsInfo.revision ?? "HEAD";
      }
    } else {
      // Dirty tree (or non-git): diff the working tree against the best
      // known git base — pending anchor, accepted baseline, or HEAD — so
      // committed-but-unreviewed changes stay visible while the tree is
      // dirty (a bare `git diff HEAD` would hide them). SVN keeps HEAD.
      diffOptions.revision = gitReview ? (pendingValid ?? baselineValid ?? vcsInfo.revision ?? "HEAD") : "HEAD";
    }
  }
  // Absolutize the selected range base NOW (git reviews only): a relative
  // base (user-supplied `since`/`revision`, or the "HEAD" literal) would
  // re-resolve to a different commit if HEAD moves while the (possibly long)
  // review runs, so a failed review could pin a range it never actually
  // reviewed. The git diff call is identical either way. SVN range values are
  // left untouched — converting them to git SHAs would break the svn diff.
  if (gitReview) {
    if (diffOptions.since) {
      diffOptions.since =
        resolveGitCommit(cwd, diffOptions.since) ?? resolveGitTree(cwd, diffOptions.since) ?? diffOptions.since;
    }
    if (diffOptions.revision) {
      diffOptions.revision =
        resolveGitCommit(cwd, diffOptions.revision) ??
        resolveGitTree(cwd, diffOptions.revision) ??
        diffOptions.revision;
    }
  }
  const { diff, truncated, changedFiles, vcs } = getDiff(cwd, diffOptions);
  const relatedContext =
    buildAstContext(cwd, changedFiles, { maxTokens: effectiveConfig.relatedContextMaxTokens ?? 1000 }) ||
    buildRelatedContext(cwd, changedFiles).context;
  const codemap = buildCodemap(cwd, changedFiles, effectiveConfig.codemapMaxTokens ?? 1500);
  const designRefText = changedFiles.some(isUiFile)
    ? formatDesignRulesForPrompt(cwd, effectiveConfig.designRefMaxTokens ?? 800)
    : "";
  const instructionsText = capActionInstructions(cwd, "review", effectiveConfig.instructionsMaxTokens ?? 800);
  const sessionContext = getSessionContext(ctx);

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
    getPastIssuesForFiles(cwd, changedFiles, description),
    effectiveConfig.reviewMaxMemoryTokens ?? 800,
  );

  // Prior-round context: files that completed reviews in this step but are
  // NOT part of the current diff. An incremental review (clean tree,
  // lastReviewedCommit..HEAD) would otherwise never see earlier rounds'
  // files and re-flag their already-reviewed logic as missing. Token-capped
  // by priorReviewMaxTokens (0 disables); the finalized context is hashed
  // into the cache key so any change invalidates a stale cached review.
  let priorRoundContext = "";
  const priorReviewMaxTokens = effectiveConfig.priorReviewMaxTokens ?? 800;
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
    description,
    modelProfile,
    currentStep,
    // Plan progress is part of the key: without it, a cached review with
    // stepComplete/consensus auto-advance could replay after a tracker
    // regression (identical step description + identical diff within the
    // TTL) and advance the plan without a fresh model call.
    planProgress: state.plan ? `${state.completedSteps}/${state.totalSteps}` : "none",
    options,
    reviewMaxDiffChars: effectiveConfig.reviewMaxDiffChars,
    reviewMaxInputTokens: effectiveConfig.reviewMaxInputTokens,
    reviewStrategy: effectiveConfig.reviewStrategy,
    reviewFullFileThresholdLines: config.reviewFullFileThresholdLines,
    parallelReview: config.parallelReview,
    selfVerify: config.selfVerify,
    conventionsText,
    memoryContext,
    // The finalized prior context itself (not a digest): buildCacheKey hashes
    // the payload, so ANY change to the assembled context — outlines, verdict
    // lines, truncation — invalidates the cached review.
    priorRoundContext,
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
    const cached = getCachedReview(cwd, cacheKey);
    if (cached) {
      progress(3, STAGES.review, "Using cached review result…");
      // A cached pass is still a completed review: keep the baseline in sync
      // so a baseline reset (new plan/session) cannot leave the next review
      // re-diffing already-reviewed commits.
      updateReviewRangeState(cwd, vcsInfo, diffOptions, cached.review);
      recordReviewedFiles(cwd, changedFiles, cached.review.verdict);
      return {
        action: "review",
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
  if (effectivePreReviewCommands.length > 0) {
    progress(4, STAGES.review, "Running pre-review commands…");
    const results = await runPreReviewCommands(cwd, effectivePreReviewCommands);
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

  const strategy = effectiveConfig.reviewStrategy ?? "auto";
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
  const fileDiffs = splitDiffByFile(diff, vcs);

  const reviewableFiles = changedFiles.filter(isReviewableFile);
  const filesWithDiff = reviewableFiles.filter((file) => fileDiffs[file] || !truncated);
  const skippedDueToTruncation = reviewableFiles.filter((file) => !fileDiffs[file] && truncated);
  const diffLikelyTruncated = estimateTokens(diff) > Math.max(0, budgetWithPreReview.availableInputTokens - 1000);
  // Explicit parallelReview config is honored at every level, including
  // diff-only (min): the user opted into per-file concurrent reviews. The
  // AUTO-split trigger (diff too large for one call) stays med/high-only —
  // min's default contract is still one cheap call per change.
  const explicitParallel = Boolean(config.parallelReview);
  const shouldParallelize =
    (explicitParallel || (diffLikelyTruncated && strategy !== "diff-only")) &&
    filesWithDiff.length > 1 &&
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
    const remainingForDiff = Math.max(
      0,
      budgetWithPreReview.availableInputTokens -
        1000 -
        estimateTokens(codemap ?? "") -
        estimateTokens(designRefText ?? "") -
        estimateTokens(instructionsText) -
        estimateTokens(priorRoundContext),
    );
    const diffTokens = estimateTokens(diff);
    if (diffTokens > remainingForDiff && !shouldParallelize) {
      progress(7, STAGES.review, "Diff too large for a diff-only review…");
      const parallelHint =
        filesWithDiff.length > 1 ? " Enable pi-yoowai.parallelReview for a per-file parallel diff-only review, or" : "";
      // The attempted range was not reviewed: pin it so a re-run at a higher
      // level (or with scoping) still sees the whole range.
      updateReviewRangeState(cwd, vcsInfo, diffOptions, { verdict: "needs-work" });
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
        return perFileTokens > remainingForDiff;
      });
      if (oversizedFile) {
        progress(7, STAGES.review, "A single file's diff exceeds the model budget…");
        updateReviewRangeState(cwd, vcsInfo, diffOptions, { verdict: "needs-work" });
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
  let finalDiffTruncated = false;
  let finalDroppedFiles: string[] = [];
  let usedHunkChunking = false;
  let continuationRounds = 0;
  let continuationTruncated = false;
  // Set when a hunk/parallel batch had failed tasks: the merged result is
  // incomplete and must not advance the baseline or record a pass verdict.
  let reviewIncomplete = false;

  if (filesWithDiff.length === 1 && diffLikelyTruncated && strategy !== "diff-only") {
    progress(7, STAGES.review, "Diff is large; splitting into hunks for review…");
    const file = filesWithDiff[0];
    const hunks = splitDiffByHunk(fileDiffs[file] ?? "");
    if (hunks.length > 1) {
      const fileMemoryContext = truncateToTokenBudget(
        getPastIssuesForFiles(cwd, [file], description),
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
      const perHunkInputEstimate =
        1000 +
        estimateTokens(sharedContextEstimate) +
        fileResult.totalTokens +
        estimateTokens(fileDiffs[file] ?? "") / hunks.length +
        estimateTokens(fileMemoryContext);
      const projectedCost = estimateCost(
        modelConfig.provider,
        modelConfig.id,
        perHunkInputEstimate * hunks.length,
        outputEstimate * hunks.length,
      );
      if (config.costBudgetUsd !== undefined && config.costBudgetUsd >= 0) {
        const sessionCost = getSessionCost(cwd).costUsd;
        if (sessionCost + projectedCost > config.costBudgetUsd) {
          updateReviewRangeState(cwd, vcsInfo, diffOptions, { verdict: "needs-work" });
          return {
            action: "review",
            error: `Hunk-based review would exceed the configured cost budget (${formatCost(config.costBudgetUsd)}).`,
          };
        }
      }
      reserveCost(cwd, projectedCost);

      const hunkTasks = hunks.map((hunk) => async () => {
        const result = await runReviewBatch({
          cwd,
          description,
          files: fileResult.entries,
          diff: hunk,
          vcs,
          criteria: state.plan?.acceptanceCriteria?.join("\n"),
          currentStep,
          sessionContext,
          conventionsText,
          preReviewOutput,
          memoryContext: fileMemoryContext,
          priorRoundContext,
          relatedContext,
          codemap,
          designRefText,
          instructionsText,
          truncated,
          droppedFiles: droppedForBudget,
          budget: fileBudget,
          modelConfig,
          signal,
          sessionManager: ctx.sessionManager,
          relevantPaths: [file],
          nativeJson,
          focusFiles: stepFocusFiles,
          levelInstructions: reviewSettings.instructions,
          ...toolLoopOptions(loopConfig),
        });
        return { review: result.review, usage: result.usage, rounds: result.rounds, truncated: result.truncated };
      });

      let outcomes: ConcurrencyOutcome<{
        review: ReviewResult;
        usage: UsageCost;
        rounds?: number;
        truncated?: boolean;
      }>[];
      try {
        outcomes = await runWithConcurrencyLimit(hunkTasks, maxConcurrency, signal);
      } finally {
        releaseCost(cwd, projectedCost);
      }

      const successes: { review: ReviewResult; usage: UsageCost; rounds?: number; truncated?: boolean }[] = [];
      const failures: string[] = [];
      for (const outcome of outcomes) {
        if (outcome.ok) successes.push(outcome.value);
        else failures.push(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
      }

      if (successes.length === 0) {
        // Every batch failed: the attempted range was NOT reviewed, so pin
        // it (scoped-aware) before returning — otherwise moving HEAD would
        // drop the whole range, reproducing the incremental-review blind spot.
        updateReviewRangeState(cwd, vcsInfo, diffOptions, { verdict: "needs-work" });
        return { action: "review", error: failures.join("; "), model: modelProfile };
      }

      review = mergeReviewResults(successes.map((s) => s.review));
      cost = successes.reduce<UsageCost | undefined>(
        (acc, s) => (acc && s.usage ? mergeUsageCost(acc, s.usage) : s.usage),
        undefined,
      );
      if (cost) cost = recordCostWithBudget(cwd, cost);
      finalDiffTruncated = truncated || successes.some((s) => s.review.truncated);
      finalDroppedFiles = [...fileResult.dropped, ...skippedDueToTruncation];
      continuationRounds = successes.reduce((sum, s) => sum + (s.rounds ?? 0), 0);
      continuationTruncated = successes.some((s) => s.truncated);

      if (failures.length > 0) {
        review.suggestions.unshift(`Review failed for ${failures.length} hunk(s): ${failures.join("; ")}`);
        review.consensus = false;
        reviewIncomplete = true;
        // The file was only partially reviewed: record it honestly so prior
        // context cannot claim a pass, and keep the failed hunks in range via
        // the pending anchor (the merged verdict must not advance anything).
        recordReviewedFiles(cwd, [file], "needs-work");
      }

      logEvent(cwd, "info", "Hunk-based review completed", {
        file,
        hunkCount: hunks.length,
        successCount: successes.length,
        failureCount: failures.length,
        provider: modelConfig.provider,
        model: modelConfig.id,
      });
      usedHunkChunking = true;
    }
  }

  if (!usedHunkChunking && shouldParallelize) {
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
          getPastIssuesForFiles(cwd, [file], description),
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

    let projectedCost = 0;
    for (const p of preps) {
      const contentTokens = p.fileResult.entries.reduce((sum, e) => sum + e.tokenEstimate, 0);
      const diffTokens = estimateTokens(fileDiffs[p.file] ?? "");
      const inputEstimate =
        1000 + estimateTokens(sharedContextEstimate) + contentTokens + diffTokens + estimateTokens(p.fileMemoryContext);
      projectedCost += estimateCost(modelConfig.provider, modelConfig.id, inputEstimate, outputEstimate);
    }
    if (config.costBudgetUsd !== undefined && config.costBudgetUsd >= 0) {
      const sessionCost = getSessionCost(cwd).costUsd;
      if (sessionCost + projectedCost > config.costBudgetUsd) {
        updateReviewRangeState(cwd, vcsInfo, diffOptions, { verdict: "needs-work" });
        return {
          action: "review",
          error: `Parallel review would exceed the configured cost budget (${formatCost(config.costBudgetUsd)}).`,
        };
      }
    }
    reserveCost(cwd, projectedCost);

    const tasks = preps.map((p) => async () => {
      const result = await runReviewBatch({
        cwd,
        description,
        files: p.fileResult.entries,
        diff: fileDiffs[p.file] ?? "",
        vcs,
        criteria: state.plan?.acceptanceCriteria?.join("\n"),
        currentStep,
        sessionContext,
        conventionsText,
        preReviewOutput,
        memoryContext: p.fileMemoryContext,
        priorRoundContext,
        relatedContext,
        codemap,
        designRefText,
        instructionsText,
        truncated,
        droppedFiles: p.droppedForBudget,
        budget: p.fileBudget,
        modelConfig,
        signal,
        sessionManager: ctx.sessionManager,
        relevantPaths: [p.file],
        nativeJson,
        focusFiles: stepFocusFiles,
        levelInstructions: reviewSettings.instructions,
        ...toolLoopOptions(loopConfig),
      });
      return {
        file: p.file,
        review: result.review,
        usage: result.usage,
        dropped: p.fileResult.dropped,
        rounds: result.rounds,
        truncated: result.truncated,
      };
    });

    let outcomes: ConcurrencyOutcome<{
      file: string;
      review: ReviewResult;
      usage: UsageCost;
      dropped: string[];
      rounds?: number;
      truncated?: boolean;
    }>[];
    try {
      outcomes = await runWithConcurrencyLimit(tasks, maxConcurrency, signal);
    } finally {
      releaseCost(cwd, projectedCost);
    }

    const successes: {
      file: string;
      review: ReviewResult;
      usage: UsageCost;
      dropped: string[];
      rounds?: number;
      truncated?: boolean;
    }[] = [];
    const failures: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) {
        successes.push(outcome.value);
      } else {
        failures.push(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
      }
    }

    if (successes.length === 0) {
      // Every batch failed: pin the attempted (scoped-aware) range so moving
      // HEAD cannot drop it before a successful retry.
      updateReviewRangeState(cwd, vcsInfo, diffOptions, { verdict: "needs-work" });
      return { action: "review", error: failures.join("; "), model: modelProfile };
    }

    review = mergeReviewResults(successes.map((s) => s.review));
    for (const { usage } of successes) {
      const recorded = recordCostWithBudget(cwd, usage);
      cost = cost ? mergeUsageCost(cost, recorded) : recorded;
    }
    finalDroppedFiles = Array.from(new Set(successes.flatMap((s) => s.dropped).concat(skippedDueToTruncation)));
    if (finalDroppedFiles.length > 0) review.droppedFiles = finalDroppedFiles;
    finalDiffTruncated = truncated || successes.some((s) => s.review.truncated);
    continuationRounds = successes.reduce((sum, s) => sum + (s.rounds ?? 0), 0);
    continuationTruncated = successes.some((s) => s.truncated);

    if (failures.length > 0) {
      review.suggestions.unshift(`Review failed for ${failures.length} file(s): ${failures.join("; ")}`);
      review.consensus = false;
      reviewIncomplete = true;
      // Only the successful batches were actually reviewed: record them with
      // their own verdicts so prior context cannot claim a pass for files
      // whose batches failed. The failed files stay in range via the pending
      // anchor (the merged verdict must not advance anything).
      for (const s of successes) {
        recordReviewedFiles(
          cwd,
          [s.file],
          s.review.truncated === true || s.truncated === true ? "needs-work" : s.review.verdict,
        );
      }
    }

    logEvent(cwd, "info", "Parallel review completed", {
      fileCount: preps.length,
      successCount: successes.length,
      failureCount: failures.length,
      provider: modelConfig.provider,
      model: modelConfig.id,
      estimatedCostUsd: cost?.estimatedCostUsd,
    });
  } else if (!usedHunkChunking) {
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

    const systemPromptEstimate = 1000;
    const remainingForDiff = Math.max(
      0,
      budgetWithPreReview.availableInputTokens - fileResult.totalTokens - systemPromptEstimate,
    );
    const diffTokens = estimateTokens(diff);
    const finalDiff =
      diffTokens > remainingForDiff ? diff.slice(0, remainingForDiff * 4) + "\n... diff truncated" : diff;
    finalDiffTruncated = truncated || finalDiff !== diff;
    finalDroppedFiles = [...fileResult.dropped, ...skippedDueToTruncation];

    progress(7, STAGES.review, "Building review prompt…");
    let result: Awaited<ReturnType<typeof runReviewBatch>>;
    try {
      result = await runReviewBatch({
        cwd,
        description,
        files: fileResult.entries,
        diff: finalDiff,
        vcs,
        criteria: state.plan?.acceptanceCriteria?.join("\n"),
        currentStep,
        sessionContext,
        conventionsText,
        preReviewOutput,
        memoryContext,
        priorRoundContext,
        relatedContext,
        codemap,
        designRefText,
        instructionsText,
        truncated: finalDiffTruncated,
        droppedFiles: finalDroppedFiles,
        budget: budgetWithPreReview,
        modelConfig,
        signal,
        sessionManager: ctx.sessionManager,
        relevantPaths: Array.from(new Set([...(options.files ?? []), ...changedFiles])),
        progress,
        nativeJson,
        focusFiles: stepFocusFiles,
        levelInstructions: reviewSettings.instructions,
        ...toolLoopOptions(loopConfig),
      });
    } catch (err) {
      // The single batch failed entirely: the attempted range was NOT
      // reviewed, so pin it (scoped-aware) before returning — otherwise
      // moving HEAD would drop the whole range.
      updateReviewRangeState(cwd, vcsInfo, diffOptions, { verdict: "needs-work" });
      return {
        action: "review",
        error: err instanceof Error ? err.message : String(err),
        model: modelProfile,
      };
    }
    review = result.review;
    cost = recordCostWithBudget(cwd, result.usage);
    continuationRounds = result.rounds ?? 0;
    continuationTruncated = result.truncated ?? false;

    if (effectiveConfig.selfVerify) {
      progress(8, STAGES.review, "Self-verifying review result…");
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
        review = verified.result;
        cost = mergeVerifiedCost(cost, recordCostWithBudget(cwd, verified.usage));
      } catch (err) {
        logEvent(cwd, "warn", "Self-verification failed; keeping original review", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (!review) {
    // The model call failed to produce a review: the attempted range was not
    // reviewed, so pin it before returning.
    updateReviewRangeState(cwd, vcsInfo, diffOptions, { verdict: "needs-work" });
    return { action: "review", error: "Review could not be produced", model: modelProfile };
  }

  progress(8, STAGES.review, "Review response received");
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
  recordIssues(cwd, review.issues);

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
    (review.verdict === "needs-work" || review.verdict === "blocked") &&
    review.issues.length === 0
  ) {
    review.inconclusive = true;
    review.suggestions.push(
      review.suggestions.length > 0
        ? "The review returned a non-pass verdict but reported no issues — the verdict contradicts its own findings, so it is inconclusive (likely a verdict slip by the model, not a real failure). Re-run wai.review; if the change is genuinely fine the re-run should pass."
        : "The review returned a verdict with no issues, so it is inconclusive — the model response was likely truncated or off-scope. Re-run wai.review; if it repeats, lower the thinking level or scope the diff with files:[...].",
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
  if (review.verdict === "pass" && finalDiffTruncated) {
    review.verdict = "needs-work";
    review.consensus = false;
    review.stepComplete = false;
    review.inconclusive = true;
    review.suggestions.push(
      "The diff was truncated, so the pass verdict cannot be trusted — re-run the review scoped with files:[...] (or with a larger budget) to cover the omitted part of the change.",
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
        "The review flagged the active plan as stale (it no longer matches the code). Once the code is in a consistent state, update the plan with `/wai-plan-update` or `wai({ planUpdate: '...' })`.",
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
  updateReviewRangeState(
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

  // Guarded auto-completion: consensus (pass with zero issues) advances as
  // before; an explicit stepComplete signal advances exactly the current step.
  const advance = planAdvanceFromReview(
    review,
    state.plan !== undefined && state.totalSteps > 0,
    state.completedSteps >= state.totalSteps,
  );
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
        if (judgeResult.judge) {
          review.autoJudged = true;
          markJudgeCompleted(cwd);
          const mergedCost =
            cost && judgeResult.cost ? mergeUsageCost(cost, judgeResult.cost) : (cost ?? judgeResult.cost);
          return {
            action: "review",
            review,
            judge: judgeResult.judge,
            cost: mergedCost,
            model: modelProfile,
            level,
            continuation: continuationMeta(continuationRounds, continuationTruncated),
          };
        } else if (judgeResult.error) {
          markJudgeCompleted(cwd);
          review.suggestions.push(`Auto-judge failed: ${judgeResult.error}`);
        }
      } catch (err) {
        logEvent(cwd, "warn", "Auto-judge failed; keeping review result", {
          error: err instanceof Error ? err.message : String(err),
        });
        review.suggestions.push(
          `Auto-judge failed: ${err instanceof Error ? err.message : String(err)}. The review result is still available.`,
        );
      }
    }
  } else if (!review.inconclusive) {
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
    review,
    cost,
    model: modelProfile,
    level,
    continuation: continuationMeta(continuationRounds, continuationTruncated),
  };
}
