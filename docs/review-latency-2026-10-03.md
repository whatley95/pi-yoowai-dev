# Large review evidence and latency — 2026-10-03

The reported high review used 269k input tokens and 112k output tokens over
2,618.5 seconds and returned incomplete coverage. Those totals alone cannot identify
the exact number of calls or distinguish reasoning from tool paging.

Source inspection found that splitting used raw diff size before full-file content
and actual prompt overhead, oversized single additions could not be segmented, output
reservation could be smaller than the backend's permitted limit, and 16k-character
pages required repeated model rounds. The changes address these paths while preserving
configured models/thinking, request limits, native permission checks, cancellation,
cost enforcement, workspace fingerprints, and whole-tree completion requirements.

## Evidence handling

- Measure actual prompt overhead and the resolved SDK model/output capacity before
  assigning patches. Reject impossible fixed-input caps before a provider request.
- Prioritize complete patches. Include exact new-file source once; report supplemental
  source omissions separately. Never infer equivalence for modified or partial patches.
- Segment oversized medium/high text patches by hunks and bounded rows with absolute
  old/new coordinates and overlap. Pack small adjacent hunks. Review every segment,
  then assess interactions with a separate integration call that can request source.
  Model summaries are explicitly identified as assessments rather than source evidence.
- Failed segments, integration gaps, unsplittable evidence, and explicit capture
  truncation cannot certify or advance the accepted baseline. Diff-only reviews retain
  their fail-closed limit for an individually oversized file.
- Read up to 64k characters per review page within remaining input headroom. The local
  source ceiling is 2 MiB; standalone pages retain their 4k default. Native read failures
  remain authoritative and never fall back to local access. Host-imposed native read
  byte/line limits can still require additional pages.

## Mechanical verification

A deterministic 55 KB local-reader fixture is delivered in one read and two model rounds,
instead of four reads and five rounds, with the complete same content. Single/multiple
900-line new-file fixtures verify every absolute source line reaches review evidence,
all prompts remain within the calculated limit, and configured thinking is retained.
Failed-segment and integration-gap cases verify that passing sibling segments cannot
certify the file or advance the baseline. Further checks cover Git/SVN headers,
replacement coordinates, newline markers, duplicate-source equivalence, too-small
input caps, SDK phase callbacks without hidden reasoning, and report diagnostics.

Completed round/context counts and worker timings make repeated model work visible.
Worker totals may exceed wall time under concurrency, and integration timing overlaps
model time. These counts exclude backend-internal retries and failed rounds, which
retain separate failure logs.

This is mechanical coverage and call-count evidence. No live-model accuracy comparison
or promised wall-clock speedup is claimed; provider reasoning and necessary context
can still dominate a high review.

## Coverage across actions

The follow-up extends shared capacity resolution and exact new-file source
deduplication to judge, security, and test analysis. Their complete prompts are
measured before a provider request; when context tools are explicitly enabled,
64k read pages are bounded by the remaining prompt capacity. Unset/false still
disables their loops, true still permits five requests, and numeric limits remain
authoritative. Min/medium/high reviews, automatic review, and `/wai-audit` share
these executors. Council members receive the same deduplicated source and retain
parallel assessment plus synthesis. Standalone tools retain 4k pages.

The actual judge/security/test executors each deliver a complete identical 55 KB
source fixture in one context request and two model rounds with an explicit
one-request cap. Each also verifies one copy of new-file source, retained
modified-file contents, and zero provider calls for an impossible input cap.
Additional checks cover SDK/configured capacity precedence, Git/SVN source identity,
sampled-security source retention, disabled loops, language overhead, and small
remaining context. These are local HTTP/SDK stubs rather than live-model timings.

## Tradeoffs

- A larger page can increase tokens in one request while reducing repeated model
  round trips. Pages shrink with available headroom; native host byte/line limits
  can still require multiple reads.
- Medium/high segmentation repeats instructions and overlap and requires an
  integration pass. It can cost more or take longer than an already-fitting call.
  Judge/security/test still require a complete diff to fit one assessment; they
  do not gain review's segmentation. Project-wide security remains a sample.
- Configured reasoning, verification, council membership, actual check execution,
  cancellation, native policy, fingerprints and certification are preserved.
  Provider reasoning and configured commands can still dominate latency.
- Complete-input preflight can reject an impossible cap sooner, producing an
  honest error rather than spending model calls on incomplete evidence. Changed
  cache contracts/capacity settings require a fresh assessment once.
- Small one-call reviews may improve little. Changing evidence paging/distribution
  can affect model attention; coverage regression tests do not prove identical
  defect detection. A repeated, human-adjudicated live comparison is still needed
  for an accuracy or end-to-end speed claim.

## Validation

Supported development host: the full suite passed with 1,484 successful tests,
four expected older-host skips, and zero failures. Typecheck, ESLint, source
formatting, and staged whitespace checks passed.

Pi 1.0.0: all-source typecheck and 564 checks passed without skips or failures
(413 component/SDK/native integration checks, 140 prompt checks, and 11 review
executor cases). Native discovery/filtering and package checks cover twelve skills
and all 39 skill files. Skill frontmatter validation passed for every entry.

The follow-up also passed all-source typechecking on Pi 1.0.0 and 97 focused
context/judge/security/test/SDK regressions without skips or failures. The full
supported-host suite used the unchanged test glob with Node's worker limit before
the file arguments (`node --import tsx --test --test-concurrency=4 "src/**/*.test.ts"`).
