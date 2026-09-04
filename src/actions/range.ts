import {
  getDiff,
  resolveGitCommit,
  resolveGitTree,
  resolveEmptyTree,
  type DiffResult,
  type VcsInfo,
} from "../diff-grabber.js";
import { setLastReviewedCommit, setPendingReviewCommit } from "../session-state.js";
import type { ReviewResult } from "../types.js";

/** How a tool selects its diff range.
 *  - "incremental" (review, test, security): the failed round's pending
 *    anchor wins over the accepted baseline, so work that has not passed
 *    review stays inside the diff.
 *  - "holistic" (judge): the accepted baseline wins, so the final judgment
 *    covers the whole span since the last accepted review (normally the
 *    pending anchor is cleared by the time a plan completes). */
export type RangePolicy = "incremental" | "holistic";

export interface RangeScope {
  revision?: string;
  since?: string;
  files?: string[];
  exclude?: string[];
  vcs?: "git" | "svn";
}

export interface ResolvedRange {
  since?: string;
  revision?: string;
}

/** Pick the diff base for a (possibly scoped) git review. Mirrors the
 *  review-action semantics exactly:
 *  - Persisted anchors are validated at use (pending may be a tree — the
 *    empty-tree root-commit base — so commits AND trees are accepted).
 *  - No explicit revision/since: clean trees diff from the anchor, or fall
 *    back to the last commit (HEAD~1) / the empty tree for root commits;
 *    dirty trees diff the working tree against the best base (anchor or
 *    HEAD) so committed-but-unreviewed changes stay visible. Scoped
 *    incremental reviews deliberately stay recent (pending ?? HEAD~1).
 *  - Explicit user ranges are kept and absolutized like everything else.
 *  - Selected bases are absolutized NOW (git only), so a HEAD move while a
 *    long tool call runs cannot shift a later pin. SVN values are untouched.
 *  The caller applies files/exclude itself via getDiff. */
export function resolveRangeBase(
  cwd: string,
  policy: RangePolicy,
  vcsInfo: VcsInfo,
  lastReviewedCommit: string | undefined,
  pendingReviewCommit: string | undefined,
  scope: RangeScope,
): ResolvedRange {
  const gitReview = vcsInfo.type === "git" && (scope.vcs ?? vcsInfo.type) === "git";
  const pendingValid =
    gitReview &&
    pendingReviewCommit &&
    (resolveGitCommit(cwd, pendingReviewCommit) ?? resolveGitTree(cwd, pendingReviewCommit))
      ? pendingReviewCommit
      : undefined;
  const baselineValid =
    gitReview && lastReviewedCommit && resolveGitCommit(cwd, lastReviewedCommit) ? lastReviewedCommit : undefined;
  // Incremental: the failed round's anchor wins over the accepted baseline.
  // Holistic: the accepted baseline wins (the judged span since acceptance).
  const anchor = policy === "holistic" ? (baselineValid ?? pendingValid) : (pendingValid ?? baselineValid);
  const unscoped = !scope.files?.length && !scope.exclude?.length;

  const out: ResolvedRange = {};
  if (!scope.revision && !scope.since) {
    if (gitReview && !vcsInfo.dirty) {
      if (unscoped && anchor) {
        out.since = anchor;
      } else {
        // Fresh-baseline fallback: no usable anchor, or a scoped review. The
        // incremental policy uses ONLY the pending anchor here (scoped
        // reviews stay recent; the accepted baseline is not widened into
        // them), while the holistic policy accepts the whole accepted span.
        const freshBase =
          (policy === "incremental" ? pendingValid : anchor) ??
          resolveGitCommit(cwd, "HEAD~1") ??
          resolveEmptyTree(cwd);
        if (freshBase) out.since = freshBase;
        else out.revision = vcsInfo.revision ?? "HEAD";
      }
    } else {
      // Dirty tree (or non-git): diff the working tree against the best base
      // so committed-but-unreviewed changes stay visible. SVN keeps HEAD.
      out.revision = gitReview ? (anchor ?? vcsInfo.revision ?? "HEAD") : "HEAD";
    }
  } else {
    if (scope.since) out.since = scope.since;
    if (scope.revision) out.revision = scope.revision;
  }

  // Absolutize the selected base NOW (git only): a relative base (user
  // supplied, or the "HEAD" literal) would re-resolve to a different commit
  // if HEAD moves while the (possibly long) call runs, so a failed review
  // could pin a range it never actually reviewed. SVN values are untouched.
  if (gitReview) {
    if (out.since) {
      out.since = resolveGitCommit(cwd, out.since) ?? resolveGitTree(cwd, out.since) ?? out.since;
    }
    if (out.revision) {
      out.revision = resolveGitCommit(cwd, out.revision) ?? resolveGitTree(cwd, out.revision) ?? out.revision;
    }
  }
  return out;
}

/** When a combined diff was capped by reviewMaxDiffChars, its slice can cut
 *  MID-FILE and drop tail files entirely. Rebuild the complete diff by
 *  fetching each changed file individually (per-file diffs bypass the
 *  combined cap) and concatenating in changedFiles order. Single-call actions
 *  (test/security/judge) use this so their model-budget gate can fail closed
 *  honestly on the TRUE size instead of silently reviewing a fragment.
 *  Files whose refetch THROWS or returns a documented failure placeholder are
 *  reported in `omitted` — callers must treat a non-empty omitted list as
 *  incomplete coverage, not as a complete rebuild. */
export function rebuiltDiff(
  cwd: string,
  diffOptions: RangeScope & { maxDiffChars?: number; untracked?: boolean; vcs?: "git" | "svn" },
  changedFiles: string[],
): { diff: string; perFileTruncated: boolean; omitted: string[] } {
  const parts: string[] = [];
  let perFileTruncated = false;
  const omitted: string[] = [];
  for (const file of changedFiles) {
    let perFile: DiffResult;
    try {
      perFile = getDiff(cwd, { ...diffOptions, files: [file] });
    } catch {
      omitted.push(file);
      continue;
    }
    // A refetch is a failure when git returns nothing or one of the
    // documented failure placeholders (a broken range/path); successful
    // per-file diffs are accepted by content, not by the changedFiles list
    // (renames report a different path in the header).
    const isFailure =
      !perFile.diff || perFile.diff.startsWith("(no changes") || perFile.diff.startsWith("(could not retrieve");
    if (isFailure) {
      omitted.push(file);
      continue;
    }
    parts.push(perFile.diff);
    if (perFile.truncated) perFileTruncated = true;
  }
  return { diff: parts.join("\n"), perFileTruncated, omitted };
}

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
 *    moves — UNLESS the inconclusive result came from truncated/omitted
 *    coverage, in which case the unreviewed portion must stay visible (pin
 *    the range).
 *  - Scoped reviews only certify part of the tree and never touch the range
 *    state (scoped diffs are self-contained — they do not use the range — so
 *    a scoped coverage-inconclusive result loses nothing: it is simply not
 *    cached and the user is asked to re-run scoped). */
export function updateRangeState(
  cwd: string,
  vcsInfo: VcsInfo,
  diffOptions: RangeScope & { files?: string[]; exclude?: string[] },
  review: Pick<ReviewResult, "verdict" | "inconclusive">,
  opts?: { pinOnInconclusive?: boolean },
): void {
  if (vcsInfo.type !== "git" || !vcsInfo.revision) return;
  // An explicit VCS override that is not git means this review is not a git
  // review: never touch git range state for it.
  if (diffOptions.vcs && diffOptions.vcs !== "git") return;
  if (diffOptions.files?.length || diffOptions.exclude?.length) return;
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

/** Pin the attempted range after an unsuccessful attempt (model failure,
 *  budget refusal, all-batch failure, ...): the range was NOT reviewed, so a
 *  later HEAD move must not drop it. Scoped-aware; safe to call on any error
 *  return reached after range selection. */
export function pinAttemptedRange(
  cwd: string,
  vcsInfo: VcsInfo,
  diffOptions: RangeScope & { files?: string[]; exclude?: string[] },
): void {
  updateRangeState(cwd, vcsInfo, diffOptions, { verdict: "needs-work" });
}
