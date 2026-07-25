# Agent Guide for pi-yoowai

This file is written for AI coding agents. It assumes no prior knowledge of the project. The project's README and source code are the authoritative sources; this guide summarizes the structure, commands, conventions, and security model that agents should respect.

---

## Project overview

`pi-yoowai` is a **Pi coding-agent extension** that adds a secondary-model pair programmer. It registers a `wai` tool and several `/wai-*` commands inside the Pi agent. The secondary model reviews diffs, creates plans, suggests alternatives, recommends next steps, and performs final holistic judgments.

- **Name / version:** `pi-yoowai` (package name `pi-yoowai`), version read from `package.json` (see `src/version.ts`).
- **License:** MIT.
- **Author:** whatley.xyz.
- **Repository entry:** `src/index.ts`.
- **Runtime target:** Node.js, ES modules, TypeScript loaded directly by Pi (`"type": "module"`).

### What the extension exposes

**Tool `wai`** — the main API used by the primary agent. Actions: `plan`, `review`, `suggest`, `recommend`, `judge`, `scan`, `test`, `security`, `done`, `planUpdate`.

**Additional tools** — `wai_index`, `wai_explain`, and `wai_learn` (four `pi.registerTool` calls in `src/index.ts`).

**Slash commands** registered in the Pi terminal:

| Command                | Purpose                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `/wai`                 | Run an action or show status: `/wai <plan|review|suggest|recommend|judge|scan|test|security|status> [args]`; `scan` accepts `--deep`. |
| `/wai-scan-deep`       | Alias for `/wai scan --deep` (deep scan with source-file sampling and symbol index build).            |
| `/wai-status`          | Detailed diagnostics (config, plan, VCS, conventions, cost).                                         |
| `/wai-model`           | Interactively pick the secondary model (optionally per tool) and write it to `~/.pi/agent/settings.json`. |
| `/wai-council`         | Interactively manage the judge council (add/remove members with the `/wai-model` pickers); writes `judgeCouncil` to `~/.pi/agent/settings.json`. |
| `/wai-config`          | View/edit pi-yoowai settings: `/wai-config <get|set|list> [key] [value]` or shorthand `/wai-config <provider.model>`. |
| `/wai-clear`           | Clear the active plan, state, cost, memory, conventions, learned facts, loop history, and inherited session. |
| `/wai-clear-logs`      | Clear the per-project wai error/event log.                                                           |
| `/wai-index`           | Read stored wai project context (`all`, `plan`, `memory`, `conventions`, `cost`, `logs`, `index`, `learned`; `--update` rebuilds the index). |
| `/wai-explain`         | Explain code, an error, or a file via the secondary model.                                           |
| `/wai-learn`           | Record or verify project facts for future sessions (`/wai-learn <fact>` or `--verify`).              |
| `/wai-search`          | Web search via the configured provider (DuckDuckGo/Brave).                                           |
| `/wai-search-config`   | Configure the web search provider and save the Brave API key to `auth.json`.                         |
| `/wai-next`            | Recommend the next step based on the active plan.                                                    |
| `/wai-done`            | Mark the current plan step complete and recommend the next step. `/wai-done N` sets progress to step N (lower N regresses, `0` resets); `all` completes everything; `--force` overrides the `requireReviewBeforeDone` gate. |
| `/wai-plan-update`     | Update the active plan (add/modify/remove steps) via the plan model.                                 |
| `/wai-logs`            | Show recent wai error/event log entries for this project.                                            |
| `/wai-test`            | Test connectivity to the configured secondary model(s); an optional task name scopes the check.      |
| `/wai-backend`         | Switch the secondary model backend: `sdk` (default), `pi`, or `http`.                                |
| `/wai-preset`          | List, preview (`show <name>`), or apply (`<name>`) a named model preset from `pi-yoowai.presets`; applying writes to the global `~/.pi/agent/settings.json`. |
| `/wai-audit`           | Run review, security, and test concurrently over the same working-tree diff and render one combined report (a failing section does not fail the others). |
| `/wai-reflect`         | Analyze review memory for recurring issue patterns and suggest project conventions; `--learn` saves each suggestion as a learned fact. No model calls. |

---

## Technology stack

- **Language:** TypeScript 6.x (strict mode, `target: esnext`).
- **Module system:** ESM (`"type": "module"`), `nodenext` resolution.
- **Runtime:** Node.js (CI runs Node 22; the test glob requires Node ≥ 22).
- **Host platform:** Pi coding agent (`@earendil-works/pi-coding-agent`).
- **Validation schemas:** `@sinclair/typebox` (used only for tool parameter shapes).
- **Runtime dependencies:** `typescript` (used lazily by `ast-context.ts` / `project-index.ts` via the compiler API) and `duck-duck-scrape` (lazy-loaded for DuckDuckGo web search in `doc-fetcher.ts`). Everything else is a peer/dev dependency of the Pi host.
- **TUI components:** `@earendil-works/pi-tui` (peer dependency; used in `src/render.ts` for tool call/result rendering).
- **Linting:** ESLint 10 with `@eslint/js` and `typescript-eslint` recommended configs.
- **Formatting:** Prettier (printWidth 120, double quotes, semicolons, trailing commas).
- **Package manager:** npm (lockfile `package-lock.json`).

There is **no bundler and no compile step**. Source files are executed directly by Pi. Tests use the Node.js built-in test runner with `tsx`.

---

## Repository layout

```
pi-yoowai/
├── package.json          # Package metadata, scripts, peer deps
├── tsconfig.json         # Strict TypeScript, noEmit, nodenext
├── eslint.config.js      # ESLint flat config
├── .prettierrc           # Prettier config (120 cols, double quotes)
├── README.md             # User-facing documentation
├── scripts/
│   ├── bump-version.js   # Semver bump helper (patch/minor/major)
│   └── setup.js          # Plain-Node setup installer (npx pi-yoowai setup / npm run setup)
└── src/
    ├── index.ts          # Extension entry: registers the wai tool + all /wai-* commands, orchestrates
    ├── types.ts          # Domain types/interfaces; re-exports backend types from types/secondary-model.ts
    ├── schemas.ts        # TypeBox schemas for structured results (plan steps, review/security, ...)
    ├── config.ts         # Load merged global + project config; resolve secondary settings and task-model overrides
    ├── secondary-model.ts# Entry point for model calls; key resolution, budget, backend dispatch, tool-loop
    ├── auth-reader.ts    # Resolve API keys from auth.json / env / commands (with !command, $ENV indirection)
    ├── prompts.ts        # Re-export barrel for prompts/ (keeps existing ./prompts.js import paths stable)
    ├── prompts/          # Prompt code, split by concern (one-way deps: salvage → validation)
    │   ├── builders.ts   #   System/user prompt builders per action + prompt cache/memoization
    │   ├── validation.ts #   parseJsonResponse, JSON validators, validation-error getters
    │   └── salvage.ts    #   Markdown salvagers for non-JSON model responses
    ├── diff-grabber.ts   # Git/SVN diff collection and VCS info
    ├── file-write-tools.ts # Explicit set of Pi tool names that mutate files (drives edit tracking)
    ├── file-loader.ts    # Load changed file contents within token budget
    ├── token-budget.ts   # Calculate per-action review token budgets
    ├── model-registry.ts # Known secondary model context windows and output limits
    ├── conventions.ts    # Scan project conventions and persist them; also filters source files for indexing
    ├── project-index.ts  # Build a TypeScript AST symbol index of the project (SymbolInfo)
    ├── project-snapshot.ts # Assemble a token-bounded project snapshot for plan/context prompts
    ├── plan-store.ts     # Persist plan/session state to disk
    ├── session-state.ts  # In-memory per-cwd session state map (completed steps, review rounds)
    ├── session-scope.ts  # Resolve per-project runtime directories and file paths
    ├── review-memory.ts  # Track recent issues per file for regression prompts
    ├── cost-tracker.ts   # Estimate, record, reserve/release, and budget secondary-model spend
    ├── council-members.ts # Pure judge-council member helpers (key/dedup/display) for /wai-council
    ├── loop-detector.ts  # Detect review-fix loops and emit steer messages
    ├── tool-loop.ts      # Let the model request read_file/run_command tools (path-secure, pre-review guarded)
    ├── pre-review.ts     # Run configured pre-review shell commands (restricted interpreters/eval flags)
    ├── render.ts         # TUI call/result rendering for Pi
    ├── progress.ts       # Status/progress reporting helpers for the Pi TUI
    ├── path-security.ts  # Validate safe relative paths (path-traversal guard)
    ├── pi-paths.ts       # Resolve Pi agent and project config paths
    ├── logger.ts         # Per-project event/error log
    ├── version.ts        # Exposes VERSION and HOMEPAGE read from package.json
    ├── doc-fetcher.ts    # Fetch web/doc context for search and explain
    ├── format.ts         # Format wai tool results into markdown text for the Pi TUI
    ├── wai-tool-params.ts# Validation for the main wai tool parameters
    ├── wai-explain.ts    # /wai-explain terminal command handler
    ├── wai-index.ts      # /wai-index terminal command handler
    ├── wai-learn.ts      # /wai-learn terminal command handler
    ├── wai-search.ts     # /wai-search terminal command handler
    ├── wai-search-config.ts # /wai-search-config terminal command handler
    ├── ast-context.ts    # TypeScript compiler-API context for changed files (lazy-loaded, token-bounded)
    ├── context-retrieval.ts # Compact outlines of files related to changed files via relative imports
    ├── review-cache.ts   # On-disk TTL cache for review/test/security/judge results
    ├── oauth-cache.ts    # Short-lived cache of exchanged OAuth credentials
    ├── model-history.ts  # Recently used secondary models (drives /wai-model recents)
    ├── presets.ts        # List/show/apply named model presets from pi-yoowai.presets (drives /wai-preset)
    ├── wai-audit.ts      # /wai-audit: run review+security+test executors concurrently, combined markdown report
    ├── reflect.ts        # /wai-reflect: recurring-issue pattern analysis over review memory (no model calls)
    ├── actions/          # One executor per wai action + shared helpers
    │   ├── plan.ts       #   plan action executor
    │   ├── review.ts     #   review action executor
    │   ├── suggest.ts    #   suggest action executor
    │   ├── recommend.ts  #   recommend action executor
    │   ├── judge.ts      #   judge action executor
    │   ├── judge-council.ts # judge council fan-out + verdict synthesis (judgeCouncil config)
    │   ├── scan.ts       #   scan action executor
    │   ├── test.ts       #   test action executor
    │   ├── security.ts   #   security action executor
    │   ├── done.ts       #   done action executor
    │   ├── plan-update.ts #  planUpdate action executor
    │   ├── review-helpers.ts # shared review prompt assembly, budget, result handling
    │   ├── verify.ts     #   secondary-model self-verification loop for structured results
    │   └── shared.ts     #   cross-action helpers: STAGES, cost recording, JSON parsing, usage merging
    ├── integration/      # Pi lifecycle hooks, context injection, status, audit, and native Pi UI surfaces
    │   ├── context-injector.ts # inject active plan/conventions into Pi context; setWaiToolExecuting guard
    │   ├── lifecycle.ts  # registerLifecycleHandlers + triggerAutoJudge
    │   ├── status.ts     # update Pi footer status with plan progress, cost, and pending review
    │   ├── audit.ts      # appendEntry helpers for session audit trail
    │   ├── publish.ts    # publish wai results to status + audit surfaces
    │   ├── entry-renderer.ts # custom TUI renderer for wai audit entries
    │   ├── shortcuts.ts  # keyboard shortcuts (Ctrl+Shift+R/D/S) for review/done/status
    │   ├── widget.ts     # plan-progress widget above the editor
    │   └── provider.ts   # config-gated pi.registerProvider("wai", ...) for the secondary model
    ├── commands/         # Terminal command helpers (argument parsers + registration)
    │   ├── arg-parsers.ts # parseReviewCommandArgs / parseTestCommandArgs / parseSecurityCommandArgs
    │   ├── searchable-select.ts # Filterable interactive option-picker state used by /wai-model (pi-tui fuzzyFilter when available, substring fallback)
    │   └── register.ts    # Registers all /wai-* slash commands and delegates to the action executors
    ├── backends/         # Pluggable model-call backends
    │   ├── backend-resolver.ts # pick backend; resolve SDK catalog metadata for token budgets
    │   ├── sdk-backend.ts #   Pi pi-ai SDK (default): headers, retries, caching, thinking mapping
    │   ├── http-backend.ts #  direct provider HTTP for custom baseUrl / backend:"http"
    │   ├── pi-backend.ts #    spawn the Pi CLI for fallback or backend:"pi"
    │   ├── provider-api.ts #   backend interface/types
    │   ├── shared.ts     #   shared backend helpers
    │   └── index.ts      #   backend registry
    └── types/            # Shared ambient/public types
        ├── docs.ts       #   doc-source configuration types
        ├── secondary-model.ts # backend/SDK option types
        └── stubs/        # Ambient declarations for peer dependencies
            ├── pi-ai.d.ts
            └── pi-tui.d.ts
```

Most source modules have a co-located `*.test.ts` file next to them (not shown above).

### Module responsibilities

- **`index.ts`** — Extension entry and main wiring. Wires the Pi session lifecycle (`session_start`/`session_shutdown`/`tool_execution_start`), registers the `wai` tool and the additional `wai_index`/`wai_explain`/`wai_learn` tools, registers the context injector (`registerContextInjector`) and lifecycle handlers (`registerLifecycleHandlers`), and delegates all `/wai-*` slash-command registration to `registerWaiCommands` (see `commands/register.ts`). Holds the per-`cwd` loop-detection state.
- **`integration/context-injector.ts`** — Registers a Pi `context` event handler that prepends the active plan summary, current step, and scanned conventions to the main agent's context when `autoInjectContext` is enabled. Uses `setWaiToolExecuting` to skip injection while a `wai` tool is running and includes a workflow reminder when unreviewed edits exceed `reviewReminderEdits`.
- **`integration/lifecycle.ts`** — Registers Pi lifecycle handlers: counts successful `write`/`edit` tool results, sends workflow-review steers at `turn_end` (escalating to a stop directive after `steerEscalationThreshold` consecutive turns with review pending, tracked via the `unreviewedTurns` session counter), triggers `wai.review` on `agent_settled` when `autoReviewOnSettle` is enabled and edits are pending (`triggerAutoReview`, before any auto-judge, guarded by a per-cwd in-flight set and `setWaiToolExecuting`), triggers `wai.judge` on `agent_settled` when `autoJudge` is enabled and the plan is complete, clears the prompt cache on `model_select`, injects plan progress into `session_before_compact` custom instructions, and flushes volatile counters to disk on `session_before_switch` / `session_before_fork` / `session_compact` / `session_shutdown` (`flushSessionStateWithAudit`, which also appends a session audit entry when edits are still unreviewed at flush time).
- **`integration/status.ts`** — Updates the Pi footer/status bar with the active plan progress, current step, session cost, and pending-review edit count via `ctx.ui.setStatus`.
- **`integration/audit.ts`** — Appends custom session entries (`pi.appendEntry("wai", ...)`) for plan creation/updates, step completion, review/judge verdicts, scan completion, and unreviewed edits outstanding at state flush (`session-unreviewed`) so the session timeline records wai decisions.
- **`integration/publish.ts`** — Central `publishWaiResult` helper called from the tool executor and slash commands to update status, audit entries, and the plan-progress widget after every wai result.
- **`integration/entry-renderer.ts`** — Async registration of `pi.registerEntryRenderer("wai", ...)` that returns a real `pi-tui` `Text` component so wai audit entries render with an icon, label, summary, and progress in the session timeline. Gracefully skips registration when `pi-tui` is unavailable.
- **`integration/shortcuts.ts`** — Registers keyboard shortcuts (`Ctrl+Shift+R` review, `Ctrl+Shift+D` done, `Ctrl+Shift+S` status) via `pi.registerShortcut`; gated by the `shortcuts` config flag.
- **`integration/widget.ts`** — Updates a compact plan-progress widget above the editor via `ctx.ui.setWidget("wai-plan", ...)`; hidden when no plan is active or `planWidget` is false.
- **`integration/provider.ts`** — Async, config-gated (`registerProvider: true`) `pi.registerProvider("wai", ...)` that looks up the configured secondary model in Pi's own model registry and exposes it in Pi's provider catalog. Skips registration (with a warning) when the model is not known to Pi, avoiding guessed API types.
- **`types.ts`** — Domain types and interfaces (`WaiAction`, `WaiModelTask`, `YoowaiConfig`, ...); re-exports backend types from `types/secondary-model.ts`.
- **`schemas.ts`** — TypeBox schemas for structured results (plan steps, review/security results, etc.).
- **`config.ts`** — Loads merged global + project config; validates and resolves `secondary` settings, task-model overrides, judge-council members (`resolveJudgeCouncilMembers`), and `DocsConfig`.
- **`secondary-model.ts`** — Entry point for secondary model calls; resolves the API key, enforces the cost budget, dispatches to the chosen backend, and runs the tool-loop when the model requests `read_file`/`run_command`.
- **`backends/`** — Pluggable model-call backends:
  - `sdk-backend.ts` — Pi's `pi-ai` SDK (default); provider attribution headers, retries, caching, thinking-level mapping.
  - `http-backend.ts` — Direct provider HTTP for custom `baseUrl` or explicit `backend: "http"`.
  - `pi-backend.ts` — Spawns the Pi CLI for fallback or explicit `backend: "pi"`.
  - `backend-resolver.ts` — Picks the backend and resolves SDK catalog metadata for token budgets.
  - `provider-api.ts` / `shared.ts` / `index.ts` — backend interface/types, shared helpers, and the backend registry.
- **`auth-reader.ts`** — Reads `~/.pi/agent/auth.json`, then falls back to environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.; `ANTHROPIC_OAUTH_TOKEN` is checked before `ANTHROPIC_API_KEY`). Supports `!command`, `$ENV`, and `${ENV}` key indirection. OAuth entries (`type: "oauth"`) are resolved/refreshed via the pi-ai SDK's `getOAuthApiKey`.
- **`prompts.ts` / `prompts/`** — `prompts.ts` is a pure re-export barrel so existing `./prompts.js` import paths keep working. `prompts/builders.ts` builds the system/user prompts for each action (plus prompt caching/memoization), `prompts/validation.ts` parses and validates the JSON the model returns (`parseJsonResponse`, `validate*Result`, `get*ValidationErrors`), and `prompts/salvage.ts` salvages results from markdown when the model does not return JSON. Dependencies are one-way: salvage → validation.
- **`file-write-tools.ts`** — Explicit set of Pi tool names that mutate project files (`isFileWriteTool`); `index.ts` uses it to track edits for review/done reminders. `file-write-tools.test.ts` pins the known names so a Pi tool rename fails loudly instead of silently changing behavior.
- **`diff-grabber.ts`** — Uses `git diff` / `svn diff`. Supports `files`, `exclude`, `revision`, `since`, `untracked`. Truncates diffs to ~6,000 chars. When the working tree is clean, reviews diff against the last reviewed commit (incremental diff review).
- **`file-loader.ts`** — Loads changed file contents within the token budget.
- **`token-budget.ts` / `model-registry.ts`** — Model context/output limits and per-action review token budgets.
- **`conventions.ts`** — Static heuristics over the tracked file list plus an LLM pass; stores conventions in `.pi/yoowai/conventions.json`. Also provides `filterSourceFiles` / `listTrackedFiles` reused by indexing.
- **`project-index.ts`** — Builds a TypeScript AST symbol index of the project (`SymbolInfo`); persisted to `.pi/yoowai/index.json` (incremental reuse of unchanged files) and used by explain/suggest/recommend.
- **`project-snapshot.ts`** — Assembles a token-bounded project snapshot (tracked files, package.json, doc samples, index symbols) for plan/context prompts.
- **`plan-store.ts` / `session-state.ts`** — Persist plan/session state to disk and keep an in-memory per-`cwd` state map (completed steps, review rounds, last reviewed commit, unreviewed-edit metrics: `unreviewedTurns`, `unreviewedEditsTotal`, `unreviewedEditsFlushed`). `flushSessionState` folds edits still pending review into the cumulative `unreviewedEditsTotal` without double counting across repeated flushes.
- **`review-memory.ts`** — Tracks recent issues per file for regression prompts (deduplicated, capped at 20 issues per file / 100 files, 7-day TTL).
- **`cost-tracker.ts`** — Estimates, records, reserves/releases, and budgets secondary-model spend.
- **`council-members.ts`** — Pure helpers for `/wai-council`: council-member identity keys, dedup on add, and `provider:id` display formatting (the interactive picker loop itself lives in `commands/register.ts`, reusing the `/wai-model` provider/model pickers).
- **`loop-detector.ts`** — Watches recent tool calls and emits a steer message when `wai.review`/`wai.judge` repeats without real edits.
- **`tool-loop.ts`** — Lets the secondary model request `read_file`/`run_command` tools to answer questions, with path-security and pre-review guards.
- **`pre-review.ts`** — Runs configured pre-review shell commands (interpreter commands restricted to relative scripts; inline-eval flags rejected) and formats output. On Windows, allowlisted commands that only exist as `.cmd` shims (npm, npx, tsc, eslint, ...) fall back to a sanitized `cmd.exe` invocation (`%`, `^`, and `"` are rejected so the shell cannot reinterpret anything).
- **`render.ts`** — TUI call/result rendering for Pi.
- **`progress.ts`** — Status/progress reporting helpers for the Pi TUI.
- **`path-security.ts`** — Validates safe relative paths (path-traversal guard) for project file access.
- **`pi-paths.ts`** — Resolves Pi agent and project config paths.
- **`logger.ts`** — Per-project event/error log under `.pi/yoowai/wai.log`.
- **`doc-fetcher.ts`** — Fetches web/doc context for `/wai-search` and `/wai-explain`. Only URLs declared in `docs.sources` are fetched; pages and search results are cached in `.pi/yoowai/docs/` for 24 hours; fetches time out after 10s and responses over 500 KB are rejected.
- **`format.ts`** — Formats `WaiToolResult` into the markdown text shown in the Pi TUI (`formatResultText`, plus `issueEmoji` / `formatModelSuffix` helpers).
- **`wai-tool-params.ts`** — Validates the main `wai` tool parameter object, resolves the requested action, and strips/ignores disallowed fields such as the removed `search` parameter.
- **`version.ts`** — Reads `VERSION` and `HOMEPAGE` from `package.json` so both `index.ts` and `commands/register.ts` share one source.
- **`commands/arg-parsers.ts`** — Pure string parsers that turn `/wai review|test|security` command-line args into structured options objects.
- **`commands/register.ts`** — Registers every `/wai-*` slash command (handlers plus `showWaiStatus`); each handler validates args, calls the relevant `actions/` executor or `wai-*` module, and renders the result with `formatResultText`. This is what keeps `index.ts` as pure wiring/export.
- **`actions/`** — One executor per `wai` action plus shared helpers:
  - `plan.ts`, `review.ts`, `suggest.ts`, `recommend.ts`, `judge.ts`, `scan.ts`, `test.ts`, `security.ts`, `done.ts`, `plan-update.ts` — action executors wiring config, prompts, diff/file loading, cost, and progress. `done.ts` also enforces the `requireReviewBeforeDone` gate: with unreviewed edits pending it returns a blocked result instead of advancing, unless the caller passes `force`.
  - `judge-council.ts` — Judge council: when `judgeCouncil` has ≥ 2 valid members, `judge.ts` fans the built judge prompt out to all members in parallel (each resolved over `secondary` like a `taskModels` override, called via `callSecondaryModel` with `secondaryOverride`), then synthesizes their verdicts with the configured judge model. Failed members are recorded and skipped; all-fail returns null so `judge.ts` falls back to the single-model path; synthesis failure falls back to a deterministic worst-verdict/union-of-issues merge. Per-member outcomes ride on `JudgeResult.council` and render as a "Council:" line in `format.ts`.
  - `review-helpers.ts` — Shared review prompt assembly, budget, and result handling.
  - `verify.ts` — Secondary-model self-verification loop for structured results.
  - `shared.ts` — Cross-action helpers: `STAGES`, cost recording, JSON parsing, usage merging.
- **`wai-explain.ts`** — Handles `/wai-explain`: explains code/error/file with the secondary model (optional doc context).
- **`wai-index.ts`** — Handles `/wai-index`: reads stored project context (plan, memory, conventions, cost, logs, index, learned).
- **`wai-learn.ts`** — Handles `/wai-learn`: records/verifies project facts for future sessions.
- **`wai-search.ts`** — Handles `/wai-search`: validates the query, checks `pi-yoowai.docs.webSearch.enabled`, runs web search via `doc-fetcher.ts`, and formats raw results.
- **`wai-search-config.ts`** — Handles `/wai-search-config`: lets the user pick DuckDuckGo or Brave Search, and saves the Brave API key to `~/.pi/agent/auth.json` when provided inline.
- **`ast-context.ts`** — Builds a token-bounded TypeScript compiler-API context (declarations/signatures) for changed files. The `typescript` package is imported lazily; a missing or broken install disables AST context with a logged warning instead of failing startup. Requires a `tsconfig.json`; falls back to regex-based import following (`context-retrieval.ts`) otherwise.
- **`context-retrieval.ts`** — Finds files related to changed files through relative `import`/`export` edges and includes compact outlines (token-bounded) as extra review context.
- **`review-cache.ts`** — On-disk TTL cache (1 hour, max 100 entries) for `review`/`test`/`security`/`judge` results, keyed by content hash, stored under `.pi/yoowai/`.
- **`oauth-cache.ts`** — Short-lived cache (default 55 minutes) of exchanged OAuth credentials under `.pi/yoowai/oauth-cache.json`, keyed by credential hash.
- **`model-history.ts`** — Persists recently used secondary models (`recent-models.json`, max 10) so `/wai-model` can offer recents.
- **`presets.ts`** — Lists, previews, and applies named model presets from `pi-yoowai.presets` (each a partial config with `secondary` and/or `taskModels`). Applying merges into the global `~/.pi/agent/settings.json` with the same read-modify-write approach as `/wai-model`, preserving all other keys.
- **`wai-audit.ts`** — Backs `/wai-audit`: runs the review, security, and test action executors concurrently (`Promise.all`) over the same diff and renders one combined markdown report; a throwing executor becomes an error section without failing the others. Slash-command only — not a `wai` tool action.
- **`reflect.ts`** — Backs `/wai-reflect`: pure analysis of the review-memory store (via `getMemoryEntries` in `review-memory.ts`) that finds files with multiple issues inside the 7-day TTL, groups normalized issue text into recurring themes, and emits a markdown report with a suggested `/wai-learn` convention per file. `--learn` persists each suggestion via `recordLearnedFact`. No model calls.
- **`types/`** — Shared types: `docs.ts` (doc sources), `secondary-model.ts` (backend/SDK types), and `stubs/` ambient declarations (`pi-ai.d.ts`, `pi-tui.d.ts`).

---

## Build, check, and release commands

All commands run from the repository root.

| Command                  | What it does                                         |
| ------------------------ | ---------------------------------------------------- |
| `npm install`            | Install dev dependencies and resolve peer deps.      |
| `npm run typecheck`      | Run `tsc --noEmit` against `src/`.                   |
| `npm run lint`           | Run ESLint against `src/`.                           |
| `npm test`               | Run the Node test runner against `src/**/*.test.ts`. |
| `npm run format`         | Run Prettier to format `src/`.                       |
| `npm run format:check`   | Check Prettier formatting without writing.           |
| `npm run prepublishOnly` | Runs typecheck + lint + tests automatically before `npm publish`. |
| `npm run bump`           | Bump patch version in `package.json`.                |
| `npm run bump:patch`     | Same as `npm run bump`.                              |
| `npm run bump:minor`     | Bump minor version.                                  |
| `npm run bump:major`     | Bump major version.                                  |
| `npm run setup`          | Run the interactive setup installer (`scripts/setup.js`; also the package `bin`, so `npx pi-yoowai setup` works). |

There is **no `build`, `start`, or `dev` script**. Pi loads `src/index.ts` directly, and TypeScript is checked but not emitted (`tsconfig.json` has `"noEmit": true`).

### Pre-review commands recommended in README

The README example configures:

```json
{
  "pi-yoowai": {
    "preReviewCommands": ["npm run typecheck", "npm run lint"]
  }
}
```

Tests live in `src/**/*.test.ts` and use the Node built-in test runner with `tsx`. If you add new test files, they are picked up automatically by `npm test`; also update `src/conventions.ts` inference if the project structure changes.

---

## Code style guidelines

Follow the existing style; the project is already internally consistent.

- **Modules:** ESM. Import Node built-ins with the `node:` prefix (`node:fs`, `node:path`, `node:child_process`).
- **Relative imports:** Use `.js` extensions for sibling/local modules (e.g. `import { loadYoowaiConfig } from "./config.js";`).
- **File names:** Kebab-case for source files (`diff-grabber.ts`, `secondary-model.ts`).
- **Type names:** PascalCase for interfaces, types, and classes.
- **Functions:** Named exports; prefer explicit return types on public module boundaries.
- **Formatting:** Enforced by Prettier — two-space indentation, double quotes, semicolons, trailing commas, 120-column print width (see `.prettierrc`).
- **Strictness:** `strict: true`, no implicit any. Cast unknown external values defensively before use.
- **Error handling:** Prefer `try/catch` with ignored errors where fallback behavior is intentional; avoid swallowing errors that should stop the tool.
- **State persistence:** Write JSON state files with mode `0o600` because they may contain project metadata or API-adjacent data.

### Linting

ESLint is configured in `eslint.config.js` with `@eslint/js` recommended and `typescript-eslint` recommended. It ignores `dist/`, `node_modules/`, and `*.d.ts`.

Run both checks before considering a change complete:

```bash
npm run typecheck
npm run lint
```

---

## Testing instructions

The project uses the Node.js built-in test runner with `tsx` for TypeScript loading.

1. `npm run typecheck` must pass.
2. `npm run lint` must pass.
3. `npm test` must pass.
4. `npm run format:check` must pass.
5. For behavior changes, also exercise the Pi extension (`/wai` commands or the `wai` tool) or invoke the module with `tsx`.

Test files are co-located with the source modules they cover (`src/**/*.test.ts`). When adding new functionality, add or extend the relevant test file. Note that `npm test` passes a glob to the test runner, which requires Node ≥ 22.

---

## Configuration and runtime architecture

### Configuration sources

`src/config.ts` merges two JSON files, with project settings overriding global settings. Only the `pi-yoowai` key is read:

1. `~/.pi/agent/settings.json` → `pi-yoowai` object.
2. `<cwd>/.pi/settings.json` → `pi-yoowai` object.

Core keys:

```ts
{
  "pi-yoowai": {
    "secondary": { "provider": "opencode-go", "id": "deepseek-v4-pro", "thinking": "xhigh" },
    "autoJudge": true,
    "autoInjectContext": true,
    "contextInjectMaxTokens": 800,
    "preReviewCommands": ["npm run typecheck", "npm run lint"],
    "costBudgetUsd": 0.5
  }
}
```

- `secondary.provider` / `secondary.id` — required; determines which model answers.
- `secondary.thinking` — optional reasoning budget (`off` → `xhigh`); passed through unchanged per tool, never silently capped after parse failures.
- `secondary.backend` — `"sdk"` (default), `"pi"`, or `"http"`. `"sdk"` uses Pi's `pi-ai` provider layer; `"pi"` spawns the Pi CLI; `"http"` uses direct provider HTTP.
- `secondary.baseUrl` — optional custom endpoint for any OpenAI-compatible or Anthropic-compatible provider. When set, the hardcoded provider map is bypassed.
- `secondary.apiKey` — optional inline API key (prefer `auth.json` or env vars).
- `secondary.style` — `"openai-compatible"` (default) or `"anthropic"`; used only with `baseUrl`.
- `secondary.authHeader` / `secondary.authPrefix` — optional auth header overrides; used only with `baseUrl`.
- `secondary.contextWindow` / `secondary.maxOutputTokens` — optional overrides for the current model.
- `secondary.cacheRetention` / `secondary.transport` / `secondary.maxRetries` / `secondary.maxRetryDelayMs` / `secondary.timeoutMs` — optional SDK backend tuning. Defaults mirror the main Pi agent (`cacheRetention: "short"`, `maxRetries: 3`, `timeoutMs: 300000`).
- API keys are resolved by pi-yoowai (`secondary.apiKey` → `~/.pi/agent/auth.json` → env vars → `!command`), then by the `pi-ai` SDK's own credential/env lookup if no explicit key is found.
- If the SDK backend hits a retryable provider error (5xx, rate limit, network timeout, missing API key, or a model missing from the SDK catalog), pi-yoowai falls back to the `pi` backend once.
- `modelInfo` — optional per-model token budget overrides, keyed by model id, so unknown models don't require code changes.
- `taskModels` — optional per-tool model overrides (`plan`, `review`, `suggest`, `recommend`, `judge`, `scan`, `test`, `security`, `done`, `planUpdate`, `explain`), each a partial secondary config (`provider`, `id`, `thinking`, ...).
- `judgeCouncil` — optional council of judge models: an array of `"provider/model-id"` strings (split on the first `/`; a bare string is treated as an id inheriting `secondary.provider`) or partial secondary config objects, each resolved over `secondary` like a `taskModels` override. With ≥ 2 valid members `wai.judge` fans out to all members in parallel and synthesizes their verdicts with the configured judge model; fewer than 2 valid members (or malformed entries, which are dropped during validation) keeps the single-model judge. Members should be different model families. Default: empty.
- `reviewStrategy` — `auto` (default), `diff-only`, or `full-files`; controls how much source is sent with reviews.
- `reviewFullFileThresholdLines` / `reviewMaxInputTokens` / `reviewMaxConventionsTokens` / `reviewMaxMemoryTokens` — tuning for full-file inclusion, the hard cap on review input tokens, and the conventions/memory token budgets in review prompts.
- `autoJudge` — run `judge` automatically when the last plan step passes review, when `/wai-done` marks the final step complete, or when `agent_settled` fires after all steps are complete.
- `autoReviewOnSettle` — run `review` automatically when the agent settles with unreviewed edits pending, before any auto-judge (default: `true`). Cost-budget errors are logged and skipped quietly.
- `requireReviewBeforeDone` — block `wai.done` / `/wai-done` from advancing while unreviewed edits are pending (default: `true`); overridden by `force: true` in the tool params or `/wai-done --force`, which records the step as manually marked (not reviewed).
- `steerEscalationThreshold` — consecutive `turn_end`s with unreviewed edits pending before the workflow steer escalates to an explicit stop directive (default: `3`).
- `autoInjectContext` — prepend the active plan summary, current step, and scanned conventions to the main agent's context before every LLM call (default: `true`).
- `contextInjectMaxTokens` — token budget for the injected context (default: `800`).
- `entryRenderer` — render wai audit entries with a custom TUI entry renderer (default: `true`).
- `shortcuts` — register keyboard shortcuts for common wai actions (default: `true`).
- `planWidget` — show a compact plan-progress widget above the editor (default: `true`).
- `registerProvider` — register the configured secondary model as a Pi provider named `wai` (default: `false`). When enabled, `/wai-config`, `/wai-model`, and `/wai-backend` refresh the registration automatically.
- `preReviewCommands` — shell commands run before each review; output is included in the prompt. Interpreter commands (`node`, `npx`, `python`, `python3`, `ruby`) are restricted to relative script files; inline-evaluation flags (`-c`, `-e`, `--eval`, etc.) are rejected.
- `testCommand` — command run for `/wai test` analysis; auto-detected from `package.json` when omitted.
- `verifyByDefault` / `selfVerify` — ask the main agent to confirm every wai finding, and/or run a second verification pass on `review`/`judge` results.
- `toolUseLoop` — let the secondary model use `read_file` and allowlisted `run_command` in a loop (number sets max iterations).
- `parallelReview` — review multiple changed files in parallel (number sets concurrency, default 3 when enabled).
- `deepScan` — include code samples and build a symbol index during `wai.scan`.
- `costBudgetUsd` — hard cap on estimated spend for the current Pi session. Negative values are treated as unset; `0` means no spend is allowed. `cost.json` is reset at the start of each Pi session and can also be cleared with `/wai-clear`.
- `processTimeoutMs` / `testTimeoutMs` — timeouts for child pi process calls (default 5 min) and per-model `/wai test` checks (default 2 min).
- `docs` — named documentation sources and DuckDuckGo/Brave web-search settings for `wai.suggest`, `wai.recommend`, `wai_explain`, and `/wai-search`.
- `presets` — named model presets (`Record<string, { secondary?, taskModels? }>`) applied to the global settings file via `/wai-preset <name>`; malformed entries are ignored during config validation.

### Authentication

API keys are resolved by `src/auth-reader.ts` in order:

1. `pi-yoowai.secondary.apiKey` in settings (if set).
2. `~/.pi/agent/auth.json` entry for the provider (`{ "type": "api_key", "key": "..." }`, or `type: "oauth"` entries resolved via the pi-ai SDK).
3. Environment variable mapped to the provider (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.).
4. Indirection supported: `"key": "!command"`, `"key": "$ENV"`, `"key": "${ENV}"`.

### Runtime data

The extension stores per-project runtime data under `.pi/yoowai/`:

- `plan.json` — active plan, completed steps, review-round counter, and which completed steps were reviewed vs. manually marked done.
- `conventions.json` — cached project conventions.
- `cost.json` — estimated spend for the current Pi session.
- `memory.json` — recent issues per file.
- `index.json` — project symbol index (incremental reuse of unchanged files).
- `review-cache.json` — cached review/test/security/judge results (see `review-cache.ts`).
- `oauth-cache.json` — cached exchanged OAuth credentials (see `oauth-cache.ts`).
- `recent-models.json` — recently used secondary models (see `model-history.ts`).
- `wai.log` — per-project error/event log (see `logger.ts`).
- `docs/` — cached fetched doc pages and search results (24-hour TTL).

`.pi/` is gitignored. Do not commit it.

### Session lifecycle

- `pi.on("session_start")` loads disk state into an in-memory `Map<string, YoowaiSessionState>` keyed by `cwd`.
- `pi.on("session_shutdown")` flushes volatile counters to disk, then drops the in-memory entry, clears the session-scoped directories, and hides the plan-progress widget.
- `pi.on("context")` is handled by `registerContextInjector` to prepend plan/conventions context to the main agent's LLM context (when `autoInjectContext` is enabled).
- `pi.on("tool_result")` is handled by `registerLifecycleHandlers`: successful `write`/`edit` results increment the edit counter and update the footer status; failed results do not.
- `pi.on("turn_end")` sends a workflow steer reminding the agent to run `wai.review` when unreviewed edits exist, respecting a cooldown; the steer escalates to an explicit stop directive after `steerEscalationThreshold` consecutive turns with review pending, and refreshes the footer status.
- `pi.on("agent_settled")` triggers `wai.review` automatically when `autoReviewOnSettle` is enabled and unreviewed edits are pending (before any auto-judge), then triggers `wai.judge` automatically when `autoJudge` is enabled and the active plan is complete, then updates the footer status.
- `pi.on("model_select")` clears the prompt cache so prompts rebuild for the new model.
- `pi.on("session_before_compact")` appends the active plan summary/progress/current step to the compaction custom instructions.
- `pi.on("session_before_switch")`, `pi.on("session_before_fork")`, and `pi.on("session_compact")` flush the in-memory session state to disk so edit counters and plan progress survive session navigation/compaction; a flush with unreviewed edits outstanding also appends a `session-unreviewed` audit entry.
- `pi.on("tool_execution_start")` records calls for loop detection.
- `registerWaiEntryRenderer` is awaited at extension load; it renders `wai` custom entries in the session timeline using a real `pi-tui` component.
- `registerWaiShortcuts` is called at extension load to bind `Ctrl+Shift+R/D/S` shortcuts.
- `registerWaiProvider` is called from `session_start` when `registerProvider: true` to expose the secondary model in Pi's provider catalog.

---

## Security considerations

- **Never commit API keys.** Keys live only in `~/.pi/agent/auth.json` or environment variables.
- **`.pi/` is gitignored.** It contains runtime state that may include file paths, issue descriptions, and cost data; keep it out of version control.
- **State files are written with mode `0o600`** to limit local access (including cached doc pages under `.pi/yoowai/docs/`).
- **Pre-review commands execute shell commands.** They are configured by the user, but any code that builds or mutates that list must not inject unsanitized input. Interpreter commands are restricted to relative script files and inline-eval flags are rejected; on Windows, `.cmd` shims go through a sanitized `cmd.exe` invocation.
- **Diffs are truncated and filtered locally** before being sent to the secondary model, but review payloads still contain source-code diffs. Be careful not to include secrets in diffs sent for review.
- **Auth command indirection (`!command`)** runs arbitrary shell commands from `auth.json`; this is a user-controlled feature, not code-controlled.
- **Doc fetching is allowlisted.** Only URLs declared in `docs.sources` are fetched; web search never fetches arbitrary result pages; fetches time out after 10 seconds and responses larger than 500 KB are rejected; no credentials are sent.

---

## Deployment / distribution

- The package is consumed by Pi, not by end-users directly. Pi resolves it as an extension via `"pi": { "extensions": ["./src/index.ts"] }` in `package.json`.
- The `files` array publishes `src/`, `scripts/`, and `README.md`. The `bin` entry exposes `scripts/setup.js` as `pi-yoowai` so `npx pi-yoowai setup` works; `npm run setup` runs it locally.
- Version bumps are done with `npm run bump:patch|minor|major`, which edits `package.json` in place.
- CI runs in `.github/workflows/ci.yml`: on every push to `main` and every PR, it runs `npm ci`, typecheck, lint, `format:check`, and tests on `ubuntu-latest` and `windows-latest` (Node 22 only; the test glob requires Node ≥ 22). `npm publish` is additionally gated by the local `prepublishOnly` script. `.gitattributes` pins LF line endings so prettier and diffs behave the same on every platform.
- There are no Docker files or deployment scripts in this repository.

---

## Notes for agents

- This file is maintained alongside the code; it was written from the actual project contents and should be updated whenever the structure, commands, or conventions change.
- Do not assume a build step. Changes are validated with `npm run typecheck` and `npm run lint`.
- When editing source, keep the kebab-case filenames, `.js` relative imports, and `node:` prefix for built-ins.
- If you change validation schemas or tool parameters, also update the corresponding prompt builders and validators in `src/prompts/` (`builders.ts`, `validation.ts`).
