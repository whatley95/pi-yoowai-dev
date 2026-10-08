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

**Tool `wai`** — the main API used by the primary agent. Actions: `plan`, `advisor`, `review`, `suggest`, `recommend`, `judge`, `scan`, `test`, `security`, `done`, `planUpdate`.

**Additional tools** — `wai_review_min`/`wai_review_med`/`wai_review_high` (explicit review-depth tools), `wai_index`, `wai_explain`, `wai_vision`, `wai_learn`, `wai_design_ref`, and `wai_scaffold` (`pi.registerTool` calls in `src/index.ts`).

**Slash commands** registered in the Pi terminal:

| Command              | Purpose                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/wai`               | Run an action or show status: `/wai <plan, advisor, review, suggest, recommend, judge, scan, test, security, done, planUpdate, status> [args]`; `scan` accepts `--deep`.                                                       |
| `/wai-scan-deep`     | Alias for `/wai scan --deep` (deep scan with source-file sampling and symbol index build).                                                                                                                                     |
| `/wai-plan`         | Full plan view: every step with its ✓ reviewed / ⚠ manually-marked / → current (with blockers) / · pending state, review rounds, last file-review verdict, acceptance criteria (checklist — not verification), and session cost. |
| `/wai-status`        | Detailed diagnostics (config, plan, VCS, conventions, cost).                                                                                                                                                                   |
| `/wai-model`         | Interactively pick the secondary model (optionally per tool) and write it to `~/.pi/agent/settings.json`. `/wai-model reset [base\|<task>]` clears the base or a task override.                                                |
| `/wai-review-model` | Direct shared-review model/thinking/selection-mode picker, with optional `all\|min\|med\|high` target and provider/filter arguments. `reset [all\|min\|med\|high]` clears only the selected global review override; reports effective per-depth models after saving/reset. |
| `/wai-council`       | Interactively manage the judge council (add/remove members with the `/wai-model` pickers, with ✓ markers for existing members and a thinking-level pick per member); writes `judgeCouncil` to `~/.pi/agent/settings.json`.     |
| `/wai-config`        | View/edit pi-yoowai settings: `/wai-config <get, set, list> [key] [value]` or shorthand `/wai-config <provider.model>`.                                                                                                        |
| `/wai-language`      | Set the language used by both the main agent and the wai secondary model: `/wai-language <name>` writes the global `pi-yoowai.language` key and clears the prompt cache; `reset` clears it (a project-level override still applies and is reported). Default: unset (natural model behavior). |
| `/wai-clear`         | Clear the active plan, state, cost, memory, conventions, learned facts, loop history, and inherited session.                                                                                                                   |
| `/wai-clear-logs`    | Clear the per-project wai error/event log.                                                                                                                                                                                     |
| `/wai-index`         | Read stored wai project context (`all`, `plan`, `memory`, `conventions`, `cost`, `logs`, `index`, `learned`; `--update` rebuilds the index).                                                                                   |
| `/wai-explain`       | Explain code, an error, or a file via the secondary model.                                                                                                                                                                     |
| `/wai-vision`        | Analyze an image (screenshot, diagram, error capture) via a vision-capable secondary model: `/wai-vision <path> [question...]`.                                                                                                |
| `/wai-learn`         | Record or verify project facts for future sessions (`/wai-learn <fact>`, `--verify [--deep]`, `--stale`, or `--reaffirm <fact>`).                                                                                              |
| `/wai-search`        | Web search via the configured provider (DuckDuckGo/Brave).                                                                                                                                                                     |
| `/wai-search-config` | Configure the web search provider and save the Brave API key to `auth.json`.                                                                                                                                                   |
| `/wai-next`          | Recommend the next step based on the active plan.                                                                                                                                                                              |
| `/wai-done`          | Mark the current plan step complete and recommend the next step. `/wai-done N` sets progress to step N (lower N regresses, `0` resets); `all` completes everything; `--force` overrides the `requireReviewBeforeDone` gate.    |
| `/wai-plan-update`   | Targeted local edit/label/add/remove/move operations, one-step undo, or model-assisted natural-language revision. Preserves unchanged outcome review records.                                                                  |
| `/wai-logs`          | Show recent wai error/event log entries for this project.                                                                                                                                                                      |
| `/wai-test`          | Test connectivity to the configured secondary model(s) and judge council members; an optional task name scopes the check (`judge` includes the council).                                                                       |
| `/wai-backend`       | Switch the secondary model backend: `sdk` (default), `pi`, or `http`.                                                                                                                                                          |
| `/wai-preset`        | List, preview (`show <name>`), or apply (`<name>`) a named model preset from `pi-yoowai.presets`; applying writes to the global `~/.pi/agent/settings.json`.                                                                   |
| `/wai-audit`         | Run review, security, and test concurrently over the same working-tree diff and render one combined report (a failing section does not fail the others).                                                                       |
| `/wai-reflect`       | Analyze review memory for recurring issue patterns and suggest project conventions; `--learn` saves each suggestion as a learned fact. No model calls.                                                                         |
| `/wai-design-ref`    | Manage user-curated UI/design rules injected into review/judge prompts for UI files: `list`, `add <rule>`, `remove <n>`, `import <path>`, `docs [topic] [doc]` (read the vendored design guidance), `reset-defaults`, `clear`. |

---

## Technology stack

- **Language:** TypeScript 6.x (strict mode, `target: esnext`).
- **Module system:** ESM (`"type": "module"`), `nodenext` resolution.
- **Runtime:** Node.js (CI runs Node 22; the test glob requires Node ≥ 22).
- **Host platform:** Pi coding agent (`@earendil-works/pi-coding-agent`).
- **Validation schemas:** `@sinclair/typebox` (used only for tool parameter shapes).
- **Runtime dependencies:** `typescript` (used lazily by `ast-context.ts` / `project-index.ts` via the compiler API), `duck-duck-scrape` (lazy-loaded for DuckDuckGo web search in `doc-fetcher.ts`), and `mupdf` (pure-WASM PDF text extraction and page rendering, lazy-loaded by `wai-vision.ts`). Everything else is a peer/dev dependency of the Pi host.
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
├── design-refs/          # Vendored Emil Kowalski design skills (MIT; attribution in README.md + LICENSE there)
├── skills/              # Native Wai-owned design/development skills and focused references
├── templates/            # Per-repo guidance templates (inert examples: main-agent engineering skill + per-action instruction files)
├── scripts/
│   ├── bump-version.js   # Semver bump helper (patch/minor/major)
│   └── setup.js          # Plain-Node setup installer (npx pi-yoowai setup / npm run setup); optionally copies Wai-owned skills for legacy/direct-file loading; existing copies are preserved
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
    ├── workflow-guidance.ts # Shared main-agent rules for review scope/recovery, plan progress, commits, and evidence
    ├── file-loader.ts    # Load changed file contents within token budget
    ├── file-policy.ts    # Shared build-artifact/metadata exclusions and binary detection for capture, indexing, and fingerprints
    ├── token-budget.ts   # Calculate per-action review token budgets
    ├── model-registry.ts # Known secondary model context windows and output limits
    ├── conventions.ts    # Scan project conventions and persist them; also filters source files for indexing
    ├── design-ref.ts     # User-curated UI/design rules (design-ref.json); injected into review/judge prompts for UI files; also serves the vendored design-refs docs and lazily seeds defaults
    ├── design-ref-defaults.ts # Distilled default rules from the vendored Emil Kowalski skills (MIT), seeding/reset, and compact writer-side guidance
    ├── instructions.ts   # Per-action instruction files (.pi/yoowai/instructions/<action>.md); mtime+size fingerprint cache, 50 KB cap, token capping
    ├── project-index.ts  # Build a TypeScript AST symbol index of the project (SymbolInfo)
    ├── project-snapshot.ts # Assemble a token-bounded project snapshot for plan/context prompts
    ├── plan-store.ts     # Persist plan/session state to disk
    ├── plan-editor.ts    # Stable step identities, targeted operations, dependency renumbering, and change summaries
    ├── plan-integrity.ts # Semantic plan validation before coercion or update application
    ├── plan-view.ts      # Pure full-plan renderer for /wai-plan + shared getBlockedBy (reviewed/manual distinction)
    ├── session-state.ts  # In-memory per-cwd session state map (completed steps, review rounds)
    ├── session-scope.ts  # Resolve per-project runtime directories and file paths
    ├── review-memory.ts  # Track recent issues per file for regression prompts
    ├── cost-tracker.ts   # Estimate, record, reserve/release, and budget secondary-model spend
    ├── council-members.ts # Pure judge-council member helpers (key/dedup/display) for /wai-council
    ├── loop-detector.ts  # Detect review-fix loops and emit steer messages
    ├── tool-loop.ts      # Let the model request read_file/search_code/run_command tools (path-secure, pre-review guarded)
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
    ├── wai-vision.ts     # wai_vision tool + /wai-vision handler: image loading/validation + vision model call
    ├── wai-index.ts      # /wai-index terminal command handler
    ├── wai-learn.ts      # /wai-learn terminal command handler
    ├── wai-search.ts     # /wai-search terminal command handler
    ├── wai-search-config.ts # /wai-search-config terminal command handler
    ├── ast-context.ts    # TypeScript compiler-API context for changed files (lazy-loaded, token-bounded)
    ├── context-retrieval.ts # Compact outlines of files related to changed files via relative imports
    ├── codemap.ts        # Compact project symbol map (changed files + import neighbors) for review/judge prompts
    ├── review-cache.ts   # On-disk TTL cache for review/test/security/judge results
    ├── oauth-cache.ts    # Short-lived cache of exchanged OAuth credentials
    ├── model-history.ts  # Recently used secondary models (drives /wai-model recents)
    ├── presets.ts        # List/show/apply named model presets from pi-yoowai.presets (drives /wai-preset)
    ├── wai-audit.ts      # /wai-audit: run review+security+test executors concurrently, combined markdown report
    ├── reflect.ts        # /wai-reflect: recurring-issue pattern analysis over review memory (no model calls)
    ├── actions/          # One executor per wai action + shared helpers
    │   ├── plan.ts       #   plan action executor
    │   ├── advisor.ts    #   advisor action executor (lightweight plain-text advice; taskModels.advisor → suggest → secondary)
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
    │   ├── context-injector.ts # inject active plan/conventions/advisor notes into Pi context; setWaiToolExecuting guard
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

- **`index.ts`** — Extension entry and main wiring. Wires the Pi session lifecycle (`session_start`/`session_shutdown`/`tool_execution_start`), registers the `wai` tool and the additional `wai_index`/`wai_explain`/`wai_learn`/`wai_design_ref` tools, registers the context injector (`registerContextInjector`) and lifecycle handlers (`registerLifecycleHandlers`), and delegates all `/wai-*` slash-command registration to `registerWaiCommands` (see `commands/register.ts`). Holds the per-`cwd` loop-detection state. On `session_start` it attaches the current session's `ModelRegistry` to the SDK backend when the host exposes the Pi ≥ 0.86 streaming methods (`attachSessionRegistry`, capability-gated via `isRegistryStreamCapable`), and `session_shutdown` detaches it — no stale registry survives a session boundary.
- **`integration/context-injector.ts`** — Registers a Pi `context` event handler that prepends the active plan summary, current step, scanned conventions, and (when `advisorNotes` is enabled) review-memory advisor notes for actively edited files to the main agent's context when `autoInjectContext` is enabled. Uses `setWaiToolExecuting` to skip injection while a `wai` tool is running and includes a workflow reminder when unreviewed edits exceed `reviewReminderEdits`. Git/SVN working copies receive commit-preparation reminders (intended files only, new-file inclusion, re-review after staging/addition changes); detection follows the nearest `.svn`/`.git` marker without spawning VCS commands. Plan reminders instruct the agent to inspect review progress before `done`, because review may already advance the step.
- **`integration/lifecycle.ts`** — Registers Pi lifecycle handlers: counts successful `write`/`edit` tool results, sends workflow-review steers at `turn_end` (escalating to a stop directive after `steerEscalationThreshold` consecutive turns with review pending, tracked via the `unreviewedTurns` session counter), runs automatic review then optional configured council assessment at `agent_before_settle` on Pi 0.87+ (older hosts use `agent_settled`), with generation-aware in-flight guards and counted context suppression, clears the prompt cache on `model_select`, injects plan progress into `session_before_compact` custom instructions, logs compaction failures on `session_compact_failed` (host ≥ 0.84.3; guardedly typed so older hosts stay compatible — the handler is inert where the event never fires), and flushes volatile counters to disk on `session_before_switch` / `session_before_fork` / `session_compact` / `session_shutdown` (`flushSessionStateWithAudit`, which also appends a session audit entry when edits are still unreviewed at flush time). The switch/fork handlers also detach the session ModelRegistry in `finally` blocks, so an earlier best-effort failure cannot leak the outgoing session's registry into the next one.
- **`integration/status.ts`** — Updates the Pi footer/status bar with the active plan progress, current step, session cost, and pending-review edit count via `ctx.ui.setStatus`.
- **`integration/audit.ts`** — Appends custom session entries (`pi.appendEntry("wai", ...)`) for plan creation/updates, step completion, review/judge verdicts, scan completion, and unreviewed edits outstanding at state flush (`session-unreviewed`) so the session timeline records wai decisions.
- **`integration/publish.ts`** — Central `publishWaiResult` helper called from the tool executor and slash commands to update status, audit entries, and the plan-progress widget after every wai result.
- **`integration/entry-renderer.ts`** — Async registration of `pi.registerEntryRenderer("wai", ...)` that returns a real `pi-tui` `Text` component so wai audit entries render with an icon, label, summary, and progress in the session timeline. Gracefully skips registration when `pi-tui` is unavailable.
- **`integration/shortcuts.ts`** — Registers keyboard shortcuts (`Ctrl+Shift+R` review, `Ctrl+Shift+D` done, `Ctrl+Shift+S` status) via `pi.registerShortcut`; gated by the `shortcuts` config flag.
- **integration/skills.ts** — Observes successful reads of packaged skill files and exposes availability/read/criteria/override diagnostics. Native package pi.skills owns discovery; no resources_discover hook bypasses resource filters. Reads do not prove compliance. The twelve packaged workflows include native Android/Kotlin, Flutter, web, security, Node, and Spring. References cover browser/integration tests, releases, architecture, profiling, and data migrations; bodies are read on demand. `skill-guidance.ts` chooses compact secondary criteria using nearest package/module evidence and canonical project containment, within the existing instruction budget.
- **`integration/widget.ts`** — Updates a compact plan-progress widget above the editor via `ctx.ui.setWidget("wai-plan", ...)`; hidden when no plan is active or `planWidget` is false.
- **`integration/provider.ts`** — Async, config-gated (`registerProvider: true`) `pi.registerProvider("wai", ...)` that looks up the configured secondary model in Pi's own model registry and exposes it in Pi's provider catalog. Skips registration (with a warning) when the model is not known to Pi, avoiding guessed API types.
- **`types.ts`** — Domain types and interfaces (`WaiAction`, `WaiModelTask`, `YoowaiConfig`, ...); re-exports backend types from `types/secondary-model.ts`.
- **`schemas.ts`** — TypeBox schemas for structured results (plan steps, review/security results, etc.).
- **`config.ts`** — Loads merged global + project config; validates and resolves `secondary` settings, task-model overrides, judge-council members (`resolveJudgeCouncilMembers`), and `DocsConfig`.
- **`secondary-model.ts`** — Entry point for secondary model calls; resolves the API key, enforces the cost budget, dispatches to the chosen backend, and runs the tool-loop when the model requests `read_file`/`run_command`.
- **`backends/`** — Pluggable model-call backends:
  - `sdk-backend.ts` — Pi's `pi-ai` SDK (default); provider attribution headers, retries, caching, thinking-level mapping. On Pi ≥ 0.86 hosts it dispatches **registry-first** through the session's `ModelRegistry` (`ctx.modelRegistry.streamSimple()`, wired by the extension lifecycle): Pi resolves authentication and the live catalog (builtins, `models.json`, extension-registered models) at request time, no pi-yoowai auth resolution or compat catalog lookup happens on that route, and registry execution failures are never replayed through the compat path — only a model-resolution miss falls back. Explicit `secondary.apiKey`/`baseUrl`/`authHeader` overrides force the compat route. Both routes share one request builder (`buildSdkOptions`/`processStream`), so headers, thinking mapping, retries, timeouts, cache retention, and usage handling are identical. Models missing from pi-ai's static builtin catalog are resolved through the shared Pi `ModelRuntime` registry (`resolveRuntimeModel`), so extension-registered providers (e.g. pi-crof) and custom `~/.pi/agent/models.json` entries work on the sdk backend — including `wai_vision` image calls for models that declare image input. On a provider credential rejection (401) with an OAuth credential it evicts cached resolutions, re-resolves (refreshing under the auth.json lock or picking up another process's fresh credential), and retries once; a second rejection surfaces a re-login hint. OAuth resolution deduplicates concurrent same-credential resolutions in-process (`inFlightOAuth` map, entry removed on settle so failures retry); cross-process refresh serialization remains Pi's AuthStorage lockfile — resolver-call counts assert in-flight dedupe only, not refresh counts.
  - `http-backend.ts` — Direct provider HTTP for custom `baseUrl` or explicit `backend: "http"`.
  - `pi-backend.ts` — Spawns the Pi CLI for fallback or explicit `backend: "pi"`.
  - `backend-resolver.ts` — Picks the backend and resolves SDK catalog metadata for token budgets.
  - `provider-api.ts` / `shared.ts` / `index.ts` — backend interface/types, shared helpers, and the backend registry.
- **`auth-reader.ts`** — Reads `~/.pi/agent/auth.json`, then falls back to environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.; for Anthropic the order is `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY`). Supports `!command`, `$ENV`, and `${ENV}` key indirection. OAuth entries (`type: "oauth"`) are resolved/refreshed preferring Pi's own `ModelRuntime` (from `@earendil-works/pi-coding-agent`), whose AuthStorage serializes token refreshes with a proper-lockfile lock on `auth.json` — this prevents refresh-token rotation races with the main Pi agent (the cause of recurring forced re-logins for providers like kimi-coding). Fallbacks, in order: pi-ai `builtinModels().getAuth()` over an auth.json-backed `CredentialStore` (pi-ai ≥ 0.82; refreshed tokens are persisted by the store's `modify()`), then the legacy `getOAuthApiKey` entry point on older pi-ai. `getAuth` may return request **headers** instead of an `apiKey` (e.g. Kimi Coding's `Authorization: Bearer ...`); the SDK backend applies those headers directly rather than sending the token as `x-api-key`.
- **`prompts.ts` / `prompts/`** — `prompts.ts` is a pure re-export barrel so existing `./prompts.js` import paths keep working. `prompts/builders.ts` builds the system/user prompts for each action (plus prompt caching/memoization), `prompts/validation.ts` parses and validates the JSON the model returns (`parseJsonResponse`, `validate*Result`, `get*ValidationErrors`), and `prompts/salvage.ts` salvages results from markdown when the model does not return JSON. Dependencies are one-way: salvage → validation. Plans use task-sized outcome steps with completion checks, flexible unconfirmed implementation details, and preservation criteria. Review/judge staleness requires positive evidence of a superseded assumption or tracker position; partial diffs, unfinished steps, preservation invariants, and equivalent implementations do not imply staleness. Explicit developer requirements remain authoritative.
- **`file-write-tools.ts`** — Explicit set of Pi tool names that mutate project files (`isFileWriteTool`); `index.ts` uses it to track edits for review/done reminders. `file-write-tools.test.ts` pins the known names so a Pi tool rename fails loudly instead of silently changing behavior.
- **`workflow-guidance.ts`** — Shared main-agent guidance for focused versus whole-tree reviews, diagnosis of inconclusive input/output, inspection of plan progress before `done`, authorized commits, Git staging/new files, and honest completion evidence. Used by tool prompt guidelines, lifecycle/context reminders, and rendered review reports to keep their instructions consistent. These are instructions, not additional enforcement gates.
- **`tool-loop.ts` context allowance** — Every batched read counts against `toolUseLoop`; current remaining counts override the initial batch-size example. An oversized batch executes nothing and allows one correction model round for the whole loop under normal cost/cancellation guards. Repeated overflow and tool requests after exhaustion fail closed. Diagnose these as context-request limits, not provider authentication, thinking depth, or token-window failures.
- **`diff-grabber.ts`** — Uses `git diff` / `svn diff`. Supports `files`, `exclude`, `revision`, `since`, `untracked`. Truncates diffs to ~6,000 chars. When the working tree is clean, reviews diff against the last reviewed commit (incremental diff review); `resolveGitCommit` resolves fallback ranges to absolute SHAs.
- **`actions/range.ts`** — Shared diff-range selection for the whole-tree actions (`src/actions/range.ts`): `resolveRangeBase` picks the diff base per policy (`incremental` for review/test/security: pending anchor wins over the accepted baseline; `holistic` for judge: baseline first) with validated anchors, clean/dirty fallbacks (HEAD~1, empty tree for root commits), and base absolutization; `updateRangeState`/`pinAttemptedRange` implement the pass-only baseline advancement, pending-anchor pinning, and the scoped/inconclusive/coverage guards; `rebuiltDiff` fetches each changed file's diff individually when a combined diff hit the reviewMaxDiffChars cap, so the single-call actions (test/security/judge) can fail closed honestly on the true size instead of reviewing a fragment. Review/test/security/judge all use it; only review mutates the range state.
- **`file-loader.ts`** — Loads changed file contents within the token budget.
- **`token-budget.ts` / `model-registry.ts`** — Model context/output limits and per-action review token budgets.
- **`conventions.ts`** — Static heuristics over the tracked file list plus an LLM pass; stores conventions in `.pi/yoowai/conventions.json`. Also provides `filterSourceFiles` / `listTrackedFiles` reused by indexing.
- **`design-ref.ts`** — Stores UI/design rules in `.pi/yoowai/design-ref.json` (max 100, deduped). `loadDesignRules` lazily seeds defaults when the store is missing/empty (`peekDesignRules` reads without seeding). `hasUiChanges` recognizes web UI and likely Flutter UI paths with SDK manifest evidence. Prompt formatting adapts source-owned legacy defaults and filters web-only defaults for Flutter while preserving user rules. `importDesignRules` extracts rules from project-relative markdown. `listDesignRefDocs` lists the nine vendored topics plus `wai-skill-design`; `readDesignRefPage` returns bounded character pages with continuation metadata and canonical-path containment checks. `readDesignRefDoc` preserves the older text API.
- **`design-ref-defaults.ts`** — `DEFAULT_DESIGN_RULES` (22 reviewer rules distilled from the vendored Emil Kowalski skills, MIT, `source: "emilkowalski/skills (MIT)"`), `seedDefaultDesignRules` (seeds only a missing/zero-rule store), `resetDesignRulesToDefaults` (explicit replace), and `formatWriterDesignGuidance` (the ~10 load-bearing rules plus a `wai_design_ref` pointer, injected into the main agent's context by `context-injector.ts` when unreviewed edits touch UI files).
- **`instructions.ts`** — Loads per-action instruction files (`.pi/yoowai/instructions/<action>.md`) for a closed set of action names, with an mtime+size fingerprint cache and a 50 KB size cap. `capActionInstructions` truncates project instructions on whole-line boundaries; changed-file callers may add optional shared skill criteria within the remaining `instructionsMaxTokens` budget, capped at 400 tokens. Project instructions have priority; `0` disables both.
- **`project-index.ts`** — Builds a TypeScript AST symbol index of the project (`SymbolInfo`); persisted to `.pi/yoowai/index.json` (incremental reuse of unchanged files) and used by explain/suggest/recommend. Each entry also records literal `imports` and reverse `dependents` (which project files import it, resolved with `.js`→`.ts` handling) so the codemap can show blast radius for changed files. `resolveImportTarget`/`normalizeRel` are exported for reuse.
- **`project-snapshot.ts`** — Assembles a token-bounded project snapshot (tracked files, package.json, doc samples, index symbols) for plan/context prompts.
- **`plan-store.ts` / `session-state.ts`** — Persist plan/session state to disk and keep an in-memory per-`cwd` state map (completed steps, review rounds, immutable plan base, completion-blocking review state, last reviewed commit, pending-review anchor, reviewed-files record, unreviewed-edit metrics: `unreviewedTurns`, `unreviewedEditsTotal`, `unreviewedEditsFlushed`). `reviewedFiles` (per-step, capped at 100 entries, normalized on load/access/save) records each completed review's files with their verdict for prior-round context; `pendingReviewCommit` keeps a failed round inside the next review's diff range until a pass. `flushSessionState` folds edits still pending review into the cumulative `unreviewedEditsTotal` without double counting across repeated flushes.
- **`plan-view.ts`** — Pure, untruncated plan presentation shared by `/wai-plan` and the widget: `buildPlanView(state, cost, opts)` renders every numbered step with its completed-vs-reviewed state (✓ done+reviewed with round counts, ⚠ completed without a passing review, → current with dependency blockers, · pending), a latest-by-`at` file-review verdict summary, the review-pending edits count with an edited-files sample, the acceptance criteria as an explicitly-unverified checklist, and the session cost; descriptions word-wrap at ~100 columns (content retained, never truncated). Also houses `getBlockedBy` and `stepGlyph` (the shared status-glyph precedence, reused by the widget so the two surfaces never diverge). The `/wai-plan` handler (`commands/register.ts`) forwards `getEditTracker().editsSinceLastReview` explicitly; the plan-progress widget (56-column inner width) renders every step with the same glyph language, so a completed-but-unreviewed step shows its own ⚠ marker inline instead of an aggregate warning line.
- **`review-memory.ts`** — Tracks recent issues per file for regression prompts (deduplicated, capped at 20 issues per file / 100 files, 7-day TTL).
- **`cost-tracker.ts`** — Estimates, records, reserves/releases, and budgets secondary-model spend.
- **`council-members.ts`** — Pure helpers for `/wai-council`: council-member identity keys, dedup on add, and `provider:id` display formatting (the interactive picker loop itself lives in `commands/register.ts`, reusing the `/wai-model` provider/model pickers).
- **`loop-detector.ts`** — Watches recent tool calls and emits a steer message when `wai.review`/`wai.judge` repeats without real edits.
- **`tool-loop.ts`** — Lets the secondary model request `read_file`/`search_code`/`run_command` tools to answer questions, with path-security and pre-review guards. `read_file` accepts optional 1-based inclusive `startLine`/`endLine` ranges (clamped, inverted ranges swapped); truncated file output appends a paging hint with the total line count. `search_code` runs a regex over project files (`listTrackedFiles` from `conventions.ts`, git-tracked or portable scan) with an optional file/directory `path` scope and 0-5 `contextLines` per match (default 1), returning `file:line` hits capped at 50 matches and the standard output budget; binary and oversized files are skipped. Command output truncation keeps head (~70%) and tail (~30%) with an elided-chars marker (shared with `pre-review.ts`). Default max iterations: 5. Model-generated `run_command` calls run with `restrictSubcommands: true`: `git`/`svn`/`npm`/`pnpm`/`yarn`/`bun`/`cargo`/`go` are limited to read-only subcommands (a per-program denylist rejects destructive or outward-facing ones like `git push`, `git reset`, `svn revert`, `npm publish`, `npm install`), while user-configured `preReviewCommands` stay unrestricted.
- **`codemap.ts`** — Builds a compact project symbol map for review/judge prompts: one line per symbol (`file.ts:12 — function foo(a, b): void`) for each changed file and its direct import neighbors, from the persisted AST index (built incrementally when missing), falling back to `context-retrieval.ts` outlines. Never throws; logs and returns `""` on failure. Budgeted by `codemapMaxTokens` and truncated on whole-line boundaries; counted within the review input-token budget but yields to changed file contents.
- **`pre-review.ts`** — Runs configured pre-review shell commands (interpreter commands restricted to relative scripts; inline-eval flags rejected) and formats output. On Windows, allowlisted commands that only exist as `.cmd` shims (npm, npx, tsc, eslint, ...) fall back to a sanitized `cmd.exe` invocation (`%`, `^`, and `"` are rejected so the shell cannot reinterpret anything).
- **`render.ts`** — TUI call/result rendering for Pi.
- **`progress.ts`** — Status/progress reporting helpers for the Pi TUI.
- **`path-security.ts`** — Validates safe relative paths and real filesystem containment, including target/ancestor symlinks and Windows junctions. Missing descendants are checked against their nearest existing ancestor; broken links fail closed.
- **`pi-paths.ts`** — Resolves Pi agent and project config paths.
- **`logger.ts`** — Per-project event/error log under `.pi/yoowai/wai.log`.
- **`doc-fetcher.ts`** — Fetches web/doc context for `/wai-search` and `/wai-explain`. Only URLs declared in `docs.sources` are fetched; pages and search results are cached in `.pi/yoowai/docs/` for 24 hours; fetches time out after 10s and responses over 500 KB are rejected.
- **`format.ts`** — Formats `WaiToolResult` into the markdown text shown in the Pi TUI (`formatResultText`, plus `issueEmoji` / `formatModelSuffix` helpers).
- **`wai-tool-params.ts`** — Validates the main `wai` tool parameter object, resolves the requested action, and strips/ignores disallowed fields such as the removed `search` parameter.
- **`version.ts`** — Reads `VERSION` and `HOMEPAGE` from `package.json` so both `index.ts` and `commands/register.ts` share one source.
- **`commands/arg-parsers.ts`** — Pure string parsers that turn `/wai review|test|security` command-line args into structured options objects.
- **`commands/register.ts`** — Registers every `/wai-*` slash command (handlers plus `showWaiStatus`); each handler validates args, calls the relevant `actions/` executor or `wai-*` module, and renders the result with `formatResultText`. This is what keeps `index.ts` as pure wiring/export.
- **`actions/`** — One executor per `wai` action plus shared helpers:
  - `plan.ts`, `advisor.ts`, `review.ts`, `suggest.ts`, `recommend.ts`, `judge.ts`, `scan.ts`, `test.ts`, `security.ts`, `done.ts`, `plan-update.ts` — action executors wiring config, prompts, diff/file loading, cost, and progress. `done.ts` also enforces the `requireReviewBeforeDone` gate: with pending edits or a failed/incomplete whole-tree review it returns a blocked result instead of advancing, unless the caller passes `force`; unavailable/invalid done verification also blocks, and `force` skips it. The shared `applyReviewOutcome` helper certifies only complete current whole-tree passes. `review.ts` runs the incremental diff (baseline advances only on a pass; a failed review pins a pending anchor so the same range stays in scope), records each round's files+verdict into `reviewedFiles`, and injects token-bounded prior-round context (`priorReviewMaxTokens`) so earlier rounds' already-reviewed files are not re-flagged as missing. When a combined diff exceeds `reviewMaxDiffChars` with multiple changed files, it refetches each missing file's diff individually and reviews per file in parallel, so a capped diff never silently drops tail files (coverage completeness is derived from post-rebuild skips, not the bare truncation flag). `advisor.ts` is the lightweight plain-text pair-programming advisor (no JSON contract, no doc fetch, no tool loop; model resolution falls back `taskModels.advisor` → `taskModels.suggest` → `secondary`).
  - `judge-council.ts` — Judge council: when `judgeCouncil` has ≥ 2 valid members, `judge.ts` fans the built judge prompt out to all members in parallel (each resolved over `secondary` like a `taskModels` override, called via `callSecondaryModel` with `secondaryOverride`), then synthesizes their verdicts with the configured judge model. Failed members are recorded and skipped; all-fail returns null so `judge.ts` reports failure without a standalone fallback; synthesis failure falls back to a deterministic worst-verdict/union-of-issues merge. Per-member outcomes ride on `JudgeResult.council` and render as a "Council:" line in `format.ts`.
  - `review-helpers.ts` — Shared review prompt assembly, budget, and result handling.
  - `verify.ts` — Secondary-model self-verification loop for structured results.
  - `shared.ts` — Cross-action helpers: `STAGES`, cost recording, JSON parsing, usage merging.
- **`wai-explain.ts`** — Handles `/wai-explain`: explains code/error/file with the secondary model (optional doc context).
- **`wai-vision.ts`** — Backs the `wai_vision` tool and `/wai-vision`: resolves the input path (project-relative via `path-security`, or an absolute path — allowed here because only whitelisted media types can leave the machine; every analysis is recorded in `wai.log`), and loads either an image (png/jpg/jpeg/webp/gif, 5 MB cap, base64-encoded) or a PDF (20 MB cap). PDFs with a text layer go through `mupdf` text extraction (first 10 pages, 100k chars) as a plain text call that any model can answer; scanned PDFs are rendered to PNG (up to 3 pages at 2× scale) and take the image path. Images ride only the SDK backend (pi-ai `ImageContent`) and the model must declare image input in Pi's catalog or runtime registry; the `taskModels.vision` override (settable via `/wai-model`) picks a vision-capable model when the base model is text-only.
- **`wai-index.ts`** — Handles `/wai-index`: reads stored project context (plan, memory, conventions, cost, logs, index, learned).
- **`actions/evidence-pack.ts`** — Deterministic review evidence pack (`buildReviewEvidencePack`): symbol lines, AST import/dependent sites, nearby test files, and best-effort contract candidates; every selection reason/cap/truncation/failure becomes a note; never calls models, never throws; budgeted by `evidencePackMaxTokens` (default 1200, 0 disables) inside reviewMaxInputTokens, yielding to complete patches and supplied source.
- **`actions/review-chunks.ts`** — Splits oversized medium/high text patches into bounded rows/hunks with absolute coordinates and overlap, packs adjacent hunks, and detects exact complete additions for source deduplication. Every segment remains required; failed segments or final integration gaps cannot certify the file. `review-helpers.ts` measures complete system/user input and preserves patches before optional source/evidence; known truncated captures fail before provider calls. Review budgets use resolved SDK metadata and the backend's permitted output limit.
- **`wai-scaffold.ts`** — Backs the `wai_scaffold` tool: deterministic (no model calls, no command execution) scaffolding of the packaged `templates/` guidance into real per-repo files — `skill` → `.pi/skills/engineering-standards/SKILL.md`; `review`/`security`/`test` → `.pi/yoowai/instructions/<action>.md`. Preview-first (default; nothing written), `apply: true` writes with exclusive `wx` creation (existing files byte-intact and reported as skipped), strict `{{key}}` substitution only from evidence (conventions scan + manifests; Dart/Flutter vs Node detection; package scripts), recognized keys without evidence render <FILL ME: key — evidence: ...> (counted), UNKNOWN keys stay raw {{key}} and count as unresolved, destinations contained (normalized + symlink-ancestor guard).
- **`wai-learn.ts`** — Backs `/wai-learn` and the `wai_learn` tool: records/verifies project facts (`learned.json`, capped at 200). Facts may carry `kind: "decision"`; decisions are injected into review prompts as a "Known decisions — do NOT re-flag" block and into the main agent's injected context with a `[decision]` marker. `findLearnedFacts` supports kind filtering; `listStaleFacts` returns only entries past their freshness budget.
  - **Freshness policy**: every entry has `lastVerifiedAt` (initialized at creation). `getFactFreshness`/`isFactFresh` evaluate staleness against per-kind budgets (`FRESHNESS_BUDGET_MS`: decisions 90d, facts 365d; overridable per call). Missing/malformed stamps fall back to `timestamp`; an unusable timestamp is stale without rejecting the record. Legacy entries without stamps get a stable derived `id` at load (persisted on the next save); new entries get a randomUUID-backed id so same-millisecond duplicates stay distinguishable.
  - **Guarded renewal**: `markFactVerified` renews only on `valid` outcomes for an exactly-one identity match (id, or fact+timestamp; a bare fact text never renews); `applyVerifiedRenewals` applies that per result; `reaffirmFact` renews explicitly by text or id and returns `renewed | not-found | ambiguous | write-failed`; `saveLearned` reports write success so `write-failed` is not misreported as not-found. `verifyLearnedFactsDeep` parses an exact-response contract (`STATUS:` + single-line `REASON:` only) — anything else is unconfirmed (`questionable`) and never renews.
  - **Exposure**: `formatLearnedFactsWithFreshness` renders stale entries with a `STALE` marker and `verify, update, or revoke` hint; `wai_index` shows them under the `learned` topic; `/wai-learn --stale`, `/wai-learn --reaffirm <fact>`, and the `wai_learn` tool's `stale`/`reaffirm` params expose them. **Contestability is deliberately deferred** — age is not treated as contradiction; the UX is the actionable stale listing.
- **`wai-search.ts`** — Handles `/wai-search`: validates the query, checks `pi-yoowai.docs.webSearch.enabled`, runs web search via `doc-fetcher.ts`, and formats raw results.
- **`wai-search-config.ts`** — Handles `/wai-search-config`: lets the user pick DuckDuckGo or Brave Search, and saves the Brave API key to `~/.pi/agent/auth.json` when provided inline.
- **`ast-context.ts`** — Builds a token-bounded TypeScript compiler-API context (declarations/signatures) for changed files. The `typescript` package is imported lazily; a missing or broken install disables AST context with a logged warning instead of failing startup. Requires a `tsconfig.json`; falls back to regex-based import following (`context-retrieval.ts`) otherwise.
- **`context-retrieval.ts`** — Finds files related to changed files through relative `import`/`export` edges and includes compact outlines (token-bounded) as extra review context.
- **`review-cache.ts`** — On-disk TTL cache (24 hours, max 200 entries) for `review`/`test`/`security`/`judge` results, keyed by content hash, stored under `.pi/yoowai/`.
- **`oauth-cache.ts`** — Short-lived cache (default 55 minutes) of exchanged OAuth credentials under `.pi/yoowai/oauth-cache.json`, keyed by credential hash.
- **`model-history.ts`** — Persists recently used secondary models (`recent-models.json`, max 10) so `/wai-model` can offer recents.
- **`model-task-routing.ts`** — Resolves the effective model and source for model-role pickers and connectivity checks, including advisor → suggest → secondary and review-depth → review → secondary. Generic review follows `resolveReviewLevel`; its picker row also shows the general fallback setting. Role labels identify shared and conditional use. `/wai-test` and model reset targets accept task names case-insensitively. Advisor and self-verification calls pass the resolved profile as `secondaryOverride`, preserving endpoint/auth routing.
- **`presets.ts`** — Lists, previews, and applies named model presets from `pi-yoowai.presets` (each a partial config with `secondary` and/or `taskModels`). Applying merges into the global `~/.pi/agent/settings.json` with the same read-modify-write approach as `/wai-model`, preserving all other keys.
- **`wai-audit.ts`** — Backs `/wai-audit`: runs the review, security, and test action executors concurrently (`Promise.all`) over the same diff and renders one combined markdown report; a throwing executor becomes an error section without failing the others. Slash-command only — not a `wai` tool action.
- **`reflect.ts`** — Backs `/wai-reflect`: pure analysis of the review-memory store (via `getMemoryEntries` in `review-memory.ts`) that finds files with multiple issues inside the 7-day TTL, groups normalized issue text into recurring themes, and emits a markdown report with a suggested `/wai-learn` convention per file. `--learn` persists each suggestion via `recordLearnedFact`. No model calls.
- **`types/`** — Shared types: `docs.ts` (doc sources), `secondary-model.ts` (backend/SDK types), and `stubs/` ambient declarations (`pi-ai.d.ts`, `pi-tui.d.ts`).

---

## Build, check, and release commands

All commands run from the repository root.

| Command                  | What it does                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `npm install`            | Install dev dependencies and resolve peer deps.                                                                   |
| `npm run typecheck`      | Run `tsc --noEmit` against `src/`.                                                                                |
| `npm run lint`           | Run ESLint against `src/`.                                                                                        |
| `npm test`               | Run the Node test runner against `src/**/*.test.ts`.                                                              |
| `npm run format`         | Run Prettier to format `src/`.                                                                                    |
| `npm run format:check`   | Check Prettier formatting without writing.                                                                        |
| `npm run prepublishOnly` | Runs typecheck + lint + tests automatically before `npm publish`.                                                 |
| `npm run bump`           | Bump patch version in `package.json`.                                                                             |
| `npm run bump:patch`     | Same as `npm run bump`.                                                                                           |
| `npm run bump:minor`     | Bump minor version.                                                                                               |
| `npm run bump:major`     | Bump major version.                                                                                               |
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

On resource-constrained hosts, run the same suite with `node --import tsx --test --test-concurrency=4 "src/**/*.test.ts"`. Put runner flags before the test paths; appending them with `npm test -- ...` does not constrain this script's worker count.

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
    "autoJudge": false,
    "judgeCouncil": [],
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
- `secondary.cacheRetention` / `secondary.transport` / `secondary.maxRetries` / `secondary.maxRetryDelayMs` / `secondary.timeoutMs` — optional backend tuning (maxRetries applies to both the SDK default 3 and the http backend default 2; `0` disables retries). Defaults mirror the main Pi agent (`cacheRetention: "short"`, `maxRetries: 3`, `timeoutMs: 300000`).
- API keys are resolved by pi-yoowai (`secondary.apiKey` → `~/.pi/agent/auth.json` → env vars → `!command`), then by the `pi-ai` SDK's own credential/env lookup if no explicit key is found.
- If the SDK backend hits a retryable provider error (5xx, rate limit, network timeout, missing API key, or a model missing from both the SDK catalog and Pi's runtime registry), pi-yoowai falls back to the `pi` backend once.
- `modelInfo` — optional per-model token budget overrides, keyed by model id, so unknown models don't require code changes.
- `taskModels` — optional per-tool model overrides (`plan`, `review`, `suggest`, `recommend`, `judge`, `scan`, `test`, `security`, `done`, `planUpdate`, `explain`, `vision`), each a partial secondary config (`provider`, `id`, `thinking`, ...).
- `judgeCouncil` — optional council of judge models: an array of `"provider/model-id"` strings (split on the first `/`; a bare string is treated as an id inheriting `secondary.provider`) or partial secondary config objects, each resolved over `secondary` like a `taskModels` override. With ≥ 2 valid members `wai.judge` fans out to all members in parallel and synthesizes their verdicts with the configured judge model; no valid members disables final assessment, one uses that member directly, and two or more use council synthesis (malformed entries are dropped during validation). Members should be different model families. Default: empty.
- `reviewStrategy` — `auto` (default), `diff-only`, or `full-files`; controls how much source is sent with reviews.
- `reviewLevel` — `min`, `med`, or `high`; generic reviews default to `med` independently of model family/thinking. Explicit tool depth wins over configured depth, which wins over the fallback. Choose high for a concrete risk or complexity reason, not file count or model capability alone. Optional `riskBasedReview` refines the fallback only when no explicit depth is set. Existing configured levels and self-verification/thinking settings remain authoritative.
- `reviewFullFileThresholdLines` / `reviewMaxInputTokens` / `reviewMaxConventionsTokens` / `reviewMaxMemoryTokens` — tuning for full-file inclusion, the hard cap on review input tokens, and the conventions/memory token budgets in review prompts.
- `autoJudge` — with configured council members, run optional final assessment automatically (default: `false`) when the last plan step passes review, when `/wai-done` marks the final step complete, or when `agent_settled` fires after all steps are complete.
- `autoReviewOnSettle` — run `review` automatically when the agent settles with unreviewed edits pending, before any auto-judge (default: `true`). Cost-budget errors are logged and skipped quietly.
- `requireReviewBeforeDone` — block `wai.done` / `/wai-done` from advancing while unreviewed edits are pending (default: `true`); overridden by `force: true` in the tool params or `/wai-done --force`, which records the step as manually marked (not reviewed).
- `steerEscalationThreshold` — consecutive `turn_end`s with unreviewed edits pending before the workflow steer escalates to an explicit stop directive (default: `3`).
- `autoInjectContext` — prepend the active plan summary, current step, and scanned conventions to the main agent's context before every LLM call (default: `true`).
- `language` — optional language directive ("respond in X") injected into the main agent's context each turn and appended to every secondary-model system prompt. Unset (default) = natural model behavior; set via `/wai-language` (global) or project `.pi/settings.json` (overrides global). Per-action instruction files apply on top.
- `contextInjectMaxTokens` — hard token budget for the injected context (default: `800`). With a finite host context estimate, optional facts/advisor notes/design rules/conventions shrink above 75% utilization and are omitted at 95%; current plan/workflow/language/VCS guidance and selected fresh decisions are retained within the configured cap. Missing/invalid estimates preserve the configured behavior. This does not compact the session or change secondary review coverage/budgets.
- `codemapMaxTokens` — token budget for the project symbol map injected into review/judge prompts (default: unset — review-level defaults apply: min 20000, med 8000, high 8000; `0` disables codemap injection).
- `designRefMaxTokens` — token budget for the design rules injected into review/judge prompts when UI files change (default: `800`; `0` disables design-rule injection).
- `instructionsMaxTokens` — token budget for per-action instruction files (`.pi/yoowai/instructions/<action>.md`) injected into that action's secondary-model prompt (default: `800`; `0` disables instruction injection).
- `priorReviewMaxTokens` — token budget for "previously reviewed this step" file outlines injected into review prompts when an incremental review cannot see earlier-round files (default: `800`; `0` disables prior-round context).
- `advisorNotes` — inject state-derived advisor notes (recent review issues in actively edited files, from review memory) into the main agent's context (default: `true`; no model calls).
- `entryRenderer` — render wai audit entries with a custom TUI entry renderer (default: `true`).
- `shortcuts` — register keyboard shortcuts for common wai actions (default: `true`).
- `planWidget` — show a compact plan-progress widget above the editor (default: `true`).
- `registerProvider` — register the configured secondary model as a Pi provider named `wai` (default: `false`). When enabled, `/wai-config`, `/wai-model`, and `/wai-backend` refresh the registration automatically.
- `preReviewCommands` — shell commands run before each review; output is included in the prompt. Interpreter commands (`node`, `npx`, `python`, `python3`, `ruby`) are restricted to relative script files; inline-evaluation flags (`-c`, `-e`, `--eval`, etc.) are rejected.
- `testCommand` — command run for `/wai test` analysis; auto-detected from `package.json` when omitted.
- `verifyByDefault` / `selfVerify` — ask the main agent to confirm every wai finding, and/or run a second verification pass on `review`/`judge` results.
- `toolUseLoop` — let the secondary model use `read_file`, `search_code`, and allowlisted `run_command` in a loop. Review defaults are off/min, 3/med, 5/high; unset/true can reserve up to 20 new-evidence requests for missing large-file context within input headroom. Explicit numeric caps win. Review pages are bounded at 64,000 characters, standalone pages at 4,000; local source files are limited to 2 MiB. Up to two identical approved read results reuse evidence without spending a new request. Every native read still executes policy checks; commands and failed reads count, and provider costs remain per call. Completed model/context rounds and cumulative worker timings appear in review results; integration timing overlaps model time, and backend retries/failures have separate logs.
- `parallelReview` — review multiple changed files in parallel (number sets concurrency, default 3 when enabled).
- `reviewBatchFiles` — opt-in maximum related files per parallel review batch (positive integer, default `1`; `3` groups related sources/tests only when complete evidence fits). Keeps all coverage/fingerprint guards and per-file fallback. See `actions/review-batching.ts` and `docs/review-latency-2026-10-01.md`.
- `deepScan` — include code samples and build a symbol index during `wai.scan`.
- `costBudgetUsd` — admission cap on estimated spend plus concurrent reservations for the current Pi session. Each underlying provider/tool/continuation call reserves centrally and settles immediately; action-level usage bookkeeping is idempotent. Actual reported usage can exceed an estimate, after which further calls stop. Negative values are treated as unset; `0` means no spend is allowed. `cost.json` is reset at the start of each Pi session and can also be cleared with `/wai-clear`.
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
- `design-ref.json` — user-curated UI/design rules (see `design-ref.ts`).
- `instructions/` — optional per-action instruction files (`<action>.md`) injected into that action's secondary-model prompt (see `instructions.ts`).
- `cost.json` — estimated spend for the current Pi session.
- `memory.json` — recent issues per file.
- `findings.json` — stable finding IDs, consecutive fresh whole-tree review counts, and evidence-bearing dismissals; `/wai-findings list` or `dismiss <id> <reason>`. Dismissals never bypass gates.
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
- `pi.on("turn_end")` sends a workflow steer reminding the agent to run `wai.review` when unreviewed edits exist, respecting a cooldown; the steer escalates to an explicit stop directive after `steerEscalationThreshold` consecutive turns with review pending, and refreshes the footer status. When edits happen with no active plan, the steer also nudges plan creation and escalates to a stop directive after `noPlanSteerEscalationThreshold` consecutive such turns (the streak resets when a plan is created via `setPlan`).
- `agent_before_settle` (Pi 0.87+) runs automatic review then optional configured council assessment and returns conversation drafts with controlled continuation. `agent_settled` retains the steer fallback for older hosts and updates status. Incoming user input permits a fresh attempt on unchanged files.
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
- **Pre-review commands execute shell commands.** They are configured by the user, but any code that builds or mutates that list must not inject unsanitized input. Interpreter commands are restricted to relative script files and inline-eval flags are rejected; on Windows, `.cmd` shims go through a sanitized `cmd.exe` invocation. Model-generated tool-loop commands (`toolUseLoop`) are additionally restricted to read-only subcommands for `git`/`svn`/package managers (`restrictSubcommands: true`), so the secondary model cannot push, reset, revert, publish, or install — and git full help (`--help` / `git help …`) is rejected for model-generated commands because it opens an external viewer (a browser) on Windows; use `git <command> -h` for terminal usage. Agents in general: on Windows, `git <command> --help` opens a browser page — prefer `-h`.
- **Diffs are truncated and filtered locally** before being sent to the secondary model, but review payloads still contain source-code diffs. Be careful not to include secrets in diffs sent for review.
- **Auth command indirection (`!command`)** runs arbitrary shell commands from `auth.json`; this is a user-controlled feature, not code-controlled.
- **Doc fetching is allowlisted.** Only URLs declared in `docs.sources` are fetched; web search never fetches arbitrary result pages; fetches time out after 10 seconds and responses larger than 500 KB are rejected; no credentials are sent.

---

## Deployment / distribution

- The package is consumed by Pi, not by end-users directly. Pi resolves it as an extension via `"pi": { "extensions": ["./src/index.ts"] }` in `package.json`.
- The `files` array publishes `src/`, `scripts/`, `design-refs/`, `skills/`, `templates/`, and `README.md`. Native `pi.skills` lists `./skills/*/SKILL.md`; Pi handles resource filtering and same-name collisions. The `bin` entry exposes `scripts/setup.js` as `pi-yoowai` so `npx pi-yoowai setup` works; `npm run setup` runs it locally.
- Version bumps are done with `npm run bump:patch|minor|major`, which edits `package.json` in place.
- CI runs in `.github/workflows/ci.yml`: on every push to `main` and every PR, it runs `npm ci`, typecheck, lint, `format:check`, and tests on `ubuntu-latest` and `windows-latest` (Node 22 only). The required `compat-latest` job stages disposable trees pinned to Pi 1.0.0 and 1.1.0, typechecks all source/tests, and runs focused SDK/lifecycle/vision/auth/integration suites, including the real Agent tool-result path and ExtensionRunner boundary dispatcher. The `>=0.82.1` peer floor remains unchanged. `npm publish` is additionally gated by `prepublishOnly`; `.gitattributes` pins LF line endings.

### Pi host compatibility

- Pi 1.0+ uses compact essential tool guidance plus the discoverable `wai` namespace; `wai_index({topic:'guidance'})` is the direct-tool fallback. Full detail lives in `tool-guidance.ts` and remains visible on older hosts. `native-output-schemas.ts` describes every wai tool's structured results. `recovery` is locally derived diagnostic advice, and `workflow` snapshots tracker state after outcome application; neither grants completion. Knowledge `limit`/filters disclose selection counts and never change review coverage or the saved index.
- `wai_vision` accepts exactly one image/PDF path or inline Pi image block (PNG/JPEG/GIF/WebP, canonical base64, max 5 MB decoded). Validate before model work and never expose base64 through logs, reports, or codemode stores. Optional native image generation and critique examples are in `templates/pi-codemode-workflows.md`; generation costs are accounted by Pi, critique costs by wai, and generated references are not implementation evidence.

- **Tested hosts:** 0.82.1 (full suite), 1.0.0 and 1.1.0 (all-source typecheck and focused integration suites). The required `compat-latest` CI matrix re-validates both modern hosts.
- **Pi 0.87 actionable boundaries:** `host-capabilities.ts` gates `agent_before_settle` by installed host version; `pi.on` presence alone does not prove support. Automatic review precedes optional configured council assessment; verdicts become custom-message drafts, and findings request continuation only when `context.canContinue` permits it. Unchanged workspace/progress attempts are suppressed. Older hosts retain the `agent_settled` steer path. Work is cancelled on switch/fork/tree/shutdown; stale completions cannot publish into the replacement session.
- **Pi 1.1 integration:** `token-budget.ts` owns the conservative 3.5-character estimate and `tokenBudgetChars`; backend estimates and all token-to-character prompt limits share them. Truncation markers count within the configured budget. Required-evidence guards remain unchanged. SDK calls retain valid reported costs (including zero) and cached input tokens in Wai's separate cost log; admission/reservations still use rough estimates. Log Pi's monotonic per-response `durationMs` when present, without inventing a value on older hosts or changing worker timing semantics. `agent_settled.aborted` or an aborted context signal prevents starting automatic review/judge even before any actionable boundary is observed.
- **CLI fallback isolation:** `backends/pi-backend.ts` selects `read,grep,find,ls` and disables extensions/skills/prompt templates. A bounded, cached `--version` probe checks the launched executable, not the imported peer host; Pi 1.0.4+ additionally receives `--no-mcp`. Unknown/older versions receive only legacy-supported flags; unknown versions cannot guarantee MCP isolation. Preserve SDK native policy checks and prompt-provided action/skill criteria.
- **Native tools:** `integration/native-tools.ts` sets sequential execution for workflow mutations and also queues direct invocations per cwd. A `tool_result` middleware sets Pi's native error flag from `details.error` without discarding details. Actual SDK usage is collected per tool invocation (including nested/concurrent calls); cache hits and estimated HTTP/Pi CLI usage are not charged to native totals. Commands/automatic actions retain wai's separate cost log.
- **Native review readers:** `integration/read-tools.ts` uses invocation-scoped AsyncLocalStorage for the live `ctx.executeTool()` API. `tool-loop.ts` validates project paths/junctions, regexes, candidates and output limits before/after native `read`/`grep`; searches batch at most 32 files with escaped exact-path globs capped around 2,000 characters. Native errors/disabled tools never fall back to local reads, and native reads do not reuse results based on local stat metadata. Native character paging preserves opaque host annotations; host source truncation advances by declared source lines. Slash commands, automatic actions, and older hosts use the existing local reader. Model-generated commands retain the allowlisted command runner.
- Native context-request instructions advertise only the callable `read`/`grep` entries from the invocation context (Pi's default active tools can omit `grep`). A missing/malformed callable-tool list on a native API fails closed; it is not a legacy fallback. Do not auto-activate tools or retry denied operations through local reads/commands.
- **Branch state:** audit entries include versioned session-state snapshots. `integration/branch-state.ts` restores from `getBranch()` on session start/tree navigation, never all session entries. An explicit `/wai-clear` adds an empty snapshot. Navigating before the first snapshot resets plan/progress; legacy startup keeps disk state. Restored fingerprints are reconciled against current files.
- **`context_with_system` (0.87+): deferred, not planned.** The existing `context` prepend already supplies plan/conventions/advisor-notes injection; system-message rewriting would change instruction priority, blur the trust boundary of injected conventions, and can reduce prompt-cache reuse. Adopt only if a concrete need appears, with a documented capability check — `pi.on` presence alone does not prove event support.
- There are no Docker files or deployment scripts in this repository.

---

## Notes for agents

- `file-policy.ts` keeps generated output and VCS/IDE metadata out of Git/SVN capture, indexing, and workspace fingerprints before source budgets are consumed. SVN working-copy actions resolve to local BASE; explicit revision/files/exclude requests remain scoped and cannot certify completion. Binary unversioned content is represented by a marker, never UTF-8 replacement bytes.
- Review memory expires on reads and retains bounded occurrence timestamps for reflection without repeating identical prompt entries. Shallow learned-fact verification checks structural references only and never renews freshness; deep renewal requires complete source evidence and a valid model verdict. Failed learned-fact writes must surface an error.
- `json-read-cache.ts` caches parsed memory, learned facts, and conventions by resolved path plus exact source contents (128-entry bound). Reads compare current text before reusing parsed data because Windows can preserve timestamps and file identity across same-size writes. Readers get copies, writes invalidate, and TTL decisions remain live. `selectLearnedFacts` ranks fresh knowledge by task/category/source paths with recency as a tie-breaker; context reserves up to 160 tokens (20%) for whole relevant facts before discarding other optional sections. Review uses the same selection for decisions.
- `scan-cache.ts` reuses successful scan inputs for 24 hours; keys include prompts, complete scanned file lists, local heuristics, model settings, depth, and instructions. Reused deep scans still refresh the full symbol graph, without extending the cache's original age. Invalid/truncated output is not cached. `scanRefresh: true` and `/wai scan --refresh` bypass reuse. Sampling is not complete source coverage. Keep cache files under ignored `.pi/`.
- Context consumers use `loadFreshProjectIndex`, which checks the entire source set and file metadata so newly added/edited/deleted callers refresh reverse edges. Relative import neighbors share `resolveImportTarget` with the AST index, including NodeNext .js-to-.ts resolution and canonical parent paths. Portable scans skip .svn administration before applying their file cap. Symbol extraction remains TypeScript/JavaScript; other languages do not have an AST dependency graph.

- `actions/plan-update.ts` supports local targeted edit/add/remove/move batches, cosmetic labels, one-step undo, and model-assisted natural-language revisions. `plan-editor.ts` gives steps stable IDs and remaps dependencies by identity; `plan-integrity.ts` rejects duplicate IDs and invalid/forward/self/non-integer dependencies before coercion. Only unchanged completed leading outcomes retain their actual review flags/round counts; new or changed work cannot inherit a count. Acceptance-criteria changes reopen completed work. Model generation is deferred, and `commitPlanUpdate` rejects concurrent state changes and persists one atomic replacement before changing session memory. Updates/undo preserve task/range anchors, pending edits, and review gates. Undo restores prior completion only when source fingerprints still match. New plan creation clears undo. `plan.md.example` and `planUpdate.md.example` remain inert instruction templates.
- `planAdvanceFromReview` requires a passing whole-tree review with explicit completion evidence (`stepComplete: true` or a positive `completedSteps` count with consensus). Explicit false/zero, stale-plan, and inconclusive signals prevent advancement. A correct partial change can pass while keeping its step open. Cache keys include a contract version; bump it when fixed assessment rules change.
- Review selection prefers generic `wai({review:'...'})` for normal changes; explicit depth tools intentionally override routing, and high should name a concrete risk. `reviewLevel: "auto"` or unset uses med unless opt-in `riskBasedReview` routes the captured diff. Fixed min/med/high values and explicit tools remain authoritative. The picker preserves automatic mode; project overrides are reported. `review-level.ts` derives `levelSelection` diagnostics (depth/source/reason) for each call, including cache hits and local errors after capture. Risk heuristics inspect sensitive source paths, additions/removals, and surrounding access-control hunks; documentation patches do not trigger code signals, and token paths alone are not credential evidence. Routing reasons do not certify safety or coverage. Keep thinking settings, full evidence guards, and completion rules unchanged.
- `/wai-review-model` reuses the model picker while bypassing the general role menu. Its shared picker preselects the fallback being edited, even when a depth override is active. Depth-specific selection/reset changes only that task override; reset works without a registry and preserves review mode/council/base settings. Post-save/reset reports use merged config to expose effective models and project priority.
- `actions/review-tool-context.ts` reserves bounded capacity only for missing context; complete supplied diffs/files need no tool requests. Review prompts carry a `ReviewAssignment` for the file/hunk worker, so the overall description does not imply missing coverage from other workers. `ToolLoopCoverageError` preserves already recorded usage and missing paths; review converts local input/request limits into `contextLimited`/`coverageGaps`, without retrying fallback models. `omittedFileContents` reports supplemental contents absent while their captured patches remain in scope; that list alone is not a required-evidence gap. Merging, plan/range advancement, completion certification, and caching reject incomplete patches and required evidence gaps. Do not fabricate code issues to represent coverage gaps or bypass native policy checks when reusing evidence.
- On Pi 0.99+, `integration/native-tools.ts` publishes each tool's JSON-normalized `details` as `structuredContent` with an object `outputSchema`, so codemode can inspect results and errors. Readable reports, existing details, direct exposure, and the 0.82.1 peer floor remain supported. Compatibility tests exercise real codemode execution, nested edit events through ExtensionRunner, and controlled OpenAI subscription auth routing and retries; they do not perform live provider logins.

- `workspace-fingerprint.ts` hashes Git HEAD/index and tracked/non-ignored untracked contents, or SVN working-copy status/properties and versioned/unversioned contents. Generated output and project-root `.pi/` are excluded; known metadata/build writes do not increment review-pending counters. `syncWorkspaceChanges` reconciles shell/editor edits at session/turn/settle/done boundaries. Passing review results carry `workspaceFingerprint` and are accepted only if it still matches. Review/judge/done verification reject changed workspaces before advancing state; projects without Git/SVN retain host edit tracking.
- `completion-evidence.ts` persists configured command exit codes and separate model assessments in plan state. Criteria remain unverified rather than deriving proof from generic test success. Configured failing checks prevent passing review/judge verdicts; requests with configured checks bypass model-result caches to execute checks afresh.
- `finding-tracker.ts` tracks complete fresh whole-tree rounds (no cache/scoped/incomplete counts), supplies documented dismissal context, and is cleared by `/wai-clear`.
- `review-benchmark.ts` and `scripts/review-benchmark.ts` provide eight paired fixtures, an opt-in live runner, and a scorer requiring human adjudication. `npm run benchmark -- --fixtures`/`--score <report>` are offline; `--live --output <report>` makes provider calls with a cumulative configured budget. Do not report measured model accuracy from fixture or unit-test success.

- `resolveBudgetModel` shares execution-route SDK metadata and explicit capacity overrides across review/judge/security/test. `deduplicateAddedSource` matches complete exact additions by Git/SVN path; modified files, outlines, partial patches and sampled security contents remain supplied. `prepareActionContext` measures complete judgment/security/test prompts (including language and tool overhead), fails locally on impossible caps, and enables bounded 64k pages only when their existing tool-loop configuration permits it. Numeric request limits and the true=5 default remain; councils still receive the same prepared source and keep their existing parallel/synthesis flow. Cache keys include capacity/input caps and language. These actions still require a complete single-call diff; only medium/high review segments large patches. Preserve required evidence and avoid claiming measured accuracy or universal speedups from deterministic request-count checks.

- This file is maintained alongside the code; it was written from the actual project contents and should be updated whenever the structure, commands, or conventions change.
- Do not assume a build step. Changes are validated with `npm run typecheck` and `npm run lint`.
- When editing source, keep the kebab-case filenames, `.js` relative imports, and `node:` prefix for built-ins.
- If you change validation schemas or tool parameters, also update the corresponding prompt builders and validators in `src/prompts/` (`builders.ts`, `validation.ts`).

- Packaged skills use native pi.skills metadata and on-demand references. Preserve unmodified vendored design documents and MIT attribution; edit Wai adaptations in skills/. Shared secondary criteria are optional and bounded inside instructionsMaxTokens after project rules. Do not call optional criteria source evidence or report model compliance from a successful skill read. Design references support bounded character paging; preserve nextOffset/truncated metadata. Flutter requires SDK manifest evidence; Android uses containing-module plugin/manifest evidence and stops at non-Android Gradle boundaries. Mobile UI does not receive web-only defaults. Kotlin support can be built into AGP; absence of kotlin-android alone is not a defect.
