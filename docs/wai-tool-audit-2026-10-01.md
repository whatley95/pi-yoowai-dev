# Wai tool audit — 2026-10-01

The workflow is sound: deterministic discovery and memory supply context, the secondary model reviews code, and whole-workspace evidence controls completion. The remaining work is mostly about context consistency, explicit coverage, and reducing repeated discovery. Several concrete defects found during this audit have been fixed; the feature opportunities below are recommendations, not completed changes.

Scope: all ten registered tools, including the eleven actions of `wai`, plus the supporting command families. Source inspection was combined with local HTTP fixtures, Git/SVN working copies, and integration checks against an actual Pi 0.99.2 installation. It does not establish the quality of every live model/provider response.

## Changes completed

Commit `ad1bf39` improves memory and scan reuse:

- Learned facts are selected by the current task, category, source, and edited files. Freshness is evaluated before selection, and complete fact lines fit within the context budget. Relevant decisions also reach review prompts.
- Main-agent context reserves space for compact learned knowledge within its existing total budget. Targeted `wai_index` queries remain the way to retrieve more detail; injection depends on `autoInjectContext` being enabled.
- Parsed conventions, learned facts, and review-memory JSON are cached by filesystem metadata. Warm reads still check for changes, but avoid reparsing unchanged files. Callers receive independent copies, and time-based freshness continues to advance without a file change.
- Successful scans reuse identical model inputs for up to 24 hours. `scanRefresh: true` or `/wai scan --refresh` forces a model call. A reused deep scan still refreshes the symbol index; reuse does not extend the original expiry.

The subsequent audit fixes five defects:

| Defect                                                                                                                        | Corrected behavior                                                                                                                          | Regression evidence                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `wai.test` could return a cached analysis without executing its command again, and trust a model pass after a failed command. | Calls with a detected/configured test command always execute it; a nonzero exit prevents a pass. Static analysis alone can still be cached. | The same diff is tested twice; the second command fails, is actually executed, and overrides an optimistic model response. |
| SVN done verification used repository `HEAD`.                                                                                 | It compares local work with working-copy `BASE`. Git continues to use `HEAD`.                                                               | Two real checkouts: repository HEAD advances while the reviewed checkout remains at its original revision.                 |
| Failed plan updates were carried only in a completion message.                                                                | They expose a top-level error, native `isError`, and an error notification while preserving the original plan.                              | A deliberately unavailable planning call returns a native error and leaves the existing plan intact.                       |
| Memory keyword filtering discarded file headings.                                                                             | Matching entries retain the file and its issue; queries can match filenames too.                                                            | Two files with the same issue keyword remain distinguishable, including a file-scoped query.                               |
| Design-reference text was absent from `structuredContent`.                                                                    | Document contents and document listings are available to codemode as well as readable tool output.                                          | A real Pi codemode script reads the registered tool's guidance and topic/document listing.                                 |

The CI compatibility job now pins Pi 0.99.2 and includes the added action/memory regressions. The supported peer floor remains 0.82.1.

## Tool-by-tool findings

### Actions of `wai`

| Action       | Current behavior assessed                                                                                                                                                             | Next useful improvement                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan`       | Uses conventions and a bounded project snapshot, validates structured output, and avoids storing an invalid plan.                                                                     | Supply the same relevant learned facts/decisions used by reviews. Introduce stable step identities and explicit evidence expectations so wording changes do not imply different work.                                    |
| `advisor`    | A lightweight answer with conventions and relevant indexed files; its model falls back through advisor → suggest → base.                                                              | Include a small task-specific memory section. Report when related files were unavailable rather than letting missing context look complete.                                                                              |
| `review`     | Captures Git/SVN changes and new files, excludes agent state/generated outputs, handles oversized patches, checks workspace identity, and separates scoped review from certification. | Add stable reason codes for missing evidence, incomplete coverage, parse failure, stale plan, and non-actionable verdict. A caller could then choose the correct recovery instead of repeatedly changing thinking depth. |
| `suggest`    | Compares alternatives with related files, conventions, optional documentation, and structured validation.                                                                             | Include accepted project decisions so it does not recommend an alternative already rejected for a documented reason.                                                                                                     |
| `recommend`  | Uses plan progress, related files, conventions, and review history.                                                                                                                   | Rank memory by the next task, include learned decisions, and fall back to actively edited files when symbol retrieval has no useful match. Return the evidence needed to unblock the next step.                          |
| `judge`      | Uses a holistic range, complete-diff guards, plan progress, fingerprints, configured checks, and optional council synthesis.                                                          | Include the same accepted decisions as review. Make the council participation policy explicit when a member fails: participating members, missing members, and any required quorum.                                      |
| `scan`       | Deterministic discovery plus optional sampled model analysis and AST index enrichment; successful unchanged inputs can now be reused.                                                 | Return sampling coverage, omitted files, index-build failures, and cache age. Add package-aware sampling for large repositories. A deep scan is sampled analysis, not proof that every source file was read.             |
| `test`       | Collects the complete requested diff, runs an explicit/detected command, and asks the model for coverage analysis. The live-command cache defect is fixed.                            | Expose command, exit code, timeout, and output clipping as structured execution evidence; distinguish executed tests from static analysis in machine-readable results.                                                   |
| `security`   | Supports scoped diff checks and a broader source sample, with safe tool-loop paths and structured findings.                                                                           | Expose inspected and omitted files. The full-project option samples files, so the report should state that coverage explicitly rather than imply an exhaustive audit.                                                    |
| `done`       | Requires eligible review evidence, distinguishes manual overrides, and can verify the current step against a stable workspace. SVN now uses `BASE`.                                   | Reuse explicit, fresh step-completion evidence when available to avoid a redundant model call, while retaining separate manual/reviewed states.                                                                          |
| `planUpdate` | Carries the old plan/progress into regeneration and retains only the unchanged completed prefix. Failed updates now report an error correctly.                                        | Show a compact before/after step preview and expose the call's model/cost details. Stable step identities would reduce unnecessary progress loss after harmless wording changes.                                         |

### Explicit review tools

| Tool              | Current behavior assessed                                       | Next useful improvement                                                                                                                                 |
| ----------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wai_review_min`  | Uses the shared review pipeline with minimal depth.             | Benchmark context construction as well as model cost; a small review should not spend most of its budget on maps and related-file context.              |
| `wai_review_med`  | Uses the same capture and certification guards at medium depth. | Report actual file/hunk coverage and budget decisions so a rerun has a concrete purpose.                                                                |
| `wai_review_high` | Adds deeper reasoning through the shared pipeline.              | Escalate based on risk, unresolved findings, or coverage gaps. Repeated high-depth calls cannot repair an unavailable file or stale plan by themselves. |

### Context and helper tools

| Tool             | Current behavior assessed                                                                                                          | Next useful improvement                                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wai_index`      | Local retrieval of plan, memory, learned facts, conventions, cost, logs, and symbol index; keyword memory now retains attribution. | Apply filters and limits to structured index output too, add pagination, and share one freshness/discovery pass within an invocation. Prefer `topic`, `query`, and `files` over repeated `all` requests. |
| `wai_learn`      | Stores facts/decisions with provenance, age limits, guarded renewal, and optional source-grounded verification.                    | Expose update/revoke/upsert by entry ID, deduplicate repeated facts, and detect conflicting decisions. Source changes could queue focused verification; they must not silently renew the entry.          |
| `wai_explain`    | Combines questions/files/errors with conventions, index context, and optional documentation using safe project paths.              | Add an aggregate prompt/file budget, explicit unavailable-file diagnostics, and an empty-response error. A per-file cap alone does not bound a many-file request.                                        |
| `wai_vision`     | Validates images/PDFs, resolves image-capable models, and supports PDF text or rendered pages.                                     | Apply per-action instructions consistently to all input routes and expose PDF page selection/coverage. Empty model responses should be diagnosed.                                                        |
| `wai_scaffold`   | Deterministic preview, evidence-based substitutions, containment checks, and exclusive creation preserve existing guidance.        | Offer the shipped plan/planUpdate templates as targets and improve Java/Maven/Gradle/Python detection. Keep unknown details as explicit placeholders.                                                    |
| `wai_design_ref` | Reads curated packaged guidance without a model call; both text and structured results now contain the document.                   | Its tool interface is read-only, so consider allowing concurrent reads and adding accurate read-only annotations. Rule-changing slash commands still need mutation safeguards.                           |

## Supporting commands and shared components

- `/wai-audit`: its three executors each collect context independently. Sharing an immutable diff/fingerprint and command evidence would reduce repeated VCS work and make all three sections inspect the same snapshot. An agent-facing audit action would also make orchestration easier.
- `/wai-reflect`: deterministic recurrence analysis is useful; avoid saving the same learned convention repeatedly and retain the originating findings as provenance.
- Model/config/council/backend/preset/connectivity commands: the live Pi registry integration already handles custom models and provider routing. Improve status output with the resolved task model, backend route, and fallback reason without exposing credentials.
- Search/document context: retain allowlists and source attribution; expose cached-document age and unavailable-source diagnostics.
- Status/plan/logs/clear: add memory selection counts, scan/index coverage, and cache age. The user should be able to see why context was omitted without inspecting logs.
- Code mapper: AST symbols currently serve TypeScript/JavaScript. Java and Dart need real language-specific discovery rather than a TypeScript-only parser. Refresh by changed file and import dependents, expose unsupported-language coverage, and benchmark large SVN trees before adding a heavier indexer.
- Context budgets: use one reusable task-aware knowledge selector across actions. Keep plans, commands, facts, decisions, and review findings distinguishable; retrieved memory is context, not proof of correctness.

## Latest Pi integration

Pi **0.99.2**, released September 30, is the latest stable release checked during this audit. It fixes Windows standalone codemode startup and long-session/catalog lookup performance. These are useful host upgrades for this project. Its new MCP startup/search behavior concerns MCP servers; Wai's native extension tools do not automatically gain those server-specific behaviors. [Release notes](https://github.com/earendil-works/pi/releases/tag/v0.99.2).

Wai already uses several relevant newer capabilities: registry-based streaming, lifecycle boundary hooks, structured tool results, native usage reporting, skill discovery, and sequential execution for state-changing workflow tools. The codemode guidance fix and the updated compatibility job make those existing integrations more reliable.

The next integration opportunity is optional exposure/namespace metadata for auxiliary tools, accurate annotations, and more precise output schemas. Keep workflow-critical tools discoverable and test both direct and nested calls before changing defaults. Pi's extension API documents these controls and nested execution. [Pinned extension API documentation](https://raw.githubusercontent.com/earendil-works/pi/v0.99.2/packages/coding-agent/docs/extensions.md).

System-prompt rewriting remains deferred, as documented in the agent guide. Current context injection is sufficient; changing instruction priority or prompt-cache behavior needs a concrete reason.

## Recommended next order

1. Share bounded learned decisions across plan, advisor, suggest, recommend, and judge. This addresses repeated rediscovery and inconsistent advice.
2. Add structured coverage and recovery reasons across review, test, security, scan, and vision. This addresses blind reruns and overbroad conclusions.
3. Add learned-entry update/revoke/upsert by ID, with duplicate/conflict handling and source-change verification queues.
4. Extend the code mapper and scaffold detection for Java and Dart, prioritizing the user's SVN projects.
5. Share audit snapshots and incremental discovery, then benchmark latency, prompt tokens, and VCS calls before further caching or exposure changes.

## Validation

The memory/scan commit passed typecheck, lint, formatting, and the complete 0.82.1-host suite: 1,355 passed, 3 skipped, zero failures.

Final audit validation, executed on Windows with Node 22:

- Supported Pi 0.82.1 host: the complete suite passed, with 1,359 passed, 4 skipped, zero failures. The additional skip is the new real-codemode test, which needs Pi 0.99+.
- Latest Pi 0.99.2 disposable install: all-source typecheck and 418 focused tests passed, with no skips or failures. This includes real codemode execution, lifecycle/registry/auth integration, memory/scan checks, and Git/SVN action regressions.
- Typecheck, ESLint, source formatting, and `git diff --check` passed.

The compatibility workflow is updated for subsequent CI runs. A live provider login or a complete 0.99.2-host test run was not part of this verification.
