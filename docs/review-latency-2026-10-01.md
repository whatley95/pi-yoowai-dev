# Review latency improvements — 2026-10-01

The reported three-file review made at least fifteen model-request attempts before the user cancelled it. File I/O was quick; repeated model rounds and separately collected context dominated the visible sequence. The abort was manual and does not establish a provider failure.

This change preserves review level, thinking, the context-request allowance, full-diff guards, workspace fingerprints, cost enforcement, and whole-tree completion requirements.

## Improvements enabled by default

- **Read batching:** the secondary model can request up to four known files with `{"tools":[{"tool":"read_file","path":"..."},...]}`. Every read counts against the existing request allowance. Commands remain single requests and keep their security restrictions. Over-budget or unsupported batches fail explicitly.
- **Correct paging:** pages retain absolute file line ranges, end on complete lines where possible, and provide a next request that advances. A character offset handles individual lines longer than the output cap. Search clipping recommends a narrower search instead of suggesting a file read of a directory.
- **Unchanged read reuse:** identical file/range requests refer to their earlier result still present in the conversation. File metadata and containment are checked again; changed files are reread. Commands are never cached by this mechanism. Reuse still counts against the request allowance.
- **Direct finalization:** after the last permitted context operation, the next call requests a final verdict immediately. It no longer first offers an unusable extra tool request. The system prefix remains stable for provider caching. If the model requests more tools instead of a verdict, the action fails rather than claiming certification.
- **Timing and cancellation:** logs correlate each loop with an ID and file scope, distinguish model waiting from local tool time, include line ranges/offsets, and count model/context requests. Batch logs expose file membership and duration. Cancelled scheduling fills unstarted outcomes instead of leaving holes in the results array.

The five-request high-review default can use five context operations and one final call. A truncated final answer retains the existing single-resume behavior. Batching can reduce the number of model rounds further without reducing the number of permitted operations.

## Optional related-file grouping

Configure the project, for example:

```json
{
  "pi-yoowai": {
    "parallelReview": true,
    "reviewBatchFiles": 3
  }
}
```

The default `reviewBatchFiles` is `1`, so existing per-file routing remains unchanged. Opt-in grouping connects source/test companions or relative-import neighbors and groups only complete file inputs that fit the context and configured input budgets, including shared context and evidence-pack allowance. No file or diff is removed to make a group fit. Unrelated, incomplete, outlined, or oversized inputs retain separate batches. A failed grouped batch leaves all of its files unreviewed and cannot certify completion. The configured model and thinking remain the same.

Grouping is opt-in because it changes how model attention is divided. Mechanical coverage can be tested; equivalent detection quality requires a live-model comparison before changing the default.

## Evidence and limits

The deterministic context benchmark uses all eight existing bug/control fixtures: array bounds, asynchronous persistence, cache keys, and HTML escaping, each with a clean control. Sequential reads use nine model rounds; groups of four reads use three. The final conversation contains the same complete fixture contents and the request allowance is identical. This measures round reduction and evidence preservation, not real-model defect detection or wall-clock speed.

Regression checks also cover absolute range/long-line reconstruction without missing or repeated characters, file mutation after reuse, live command execution, path rejection in a mixed batch, exhausted-budget refusal, correlated timings, manual cancellation, grouped failure coverage, and fallback when grouping is disabled or complete evidence does not fit.

Validation on Windows with Node 22:

- Supported Pi 0.82.1 host: complete suite passed with 1,376 passed, 4 expected skips, zero failures.
- Pi 0.99.2 disposable install: all-source typecheck, 454 focused tests, and 4 grouped-review executor cases passed without skips or failures.
- Final source additionally passed 100 focused component checks on both hosts, plus the grouped-review cases on 0.99.2.
- Typecheck, ESLint, source formatting, and `git diff --check` passed. Compatibility CI now includes the context-loop and batching regressions.

No live provider accuracy comparison is claimed. The measured nine-to-three reduction applies to the deterministic context fixture, not every real review.
