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

## Validation

Supported development host: the full suite passed with 1,470 successful tests,
four expected older-host skips, and zero failures. Typecheck, ESLint, source
formatting, and staged whitespace checks passed.

Pi 1.0.0: all-source typecheck and 564 checks passed without skips or failures
(413 component/SDK/native integration checks, 140 prompt checks, and 11 review
executor cases). Native discovery/filtering and package checks cover twelve skills
and all 39 skill files. Skill frontmatter validation passed for every entry.
