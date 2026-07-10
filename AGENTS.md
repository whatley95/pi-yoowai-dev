# Agent Guide for pi-heyyoo

This file is written for AI coding agents. It assumes no prior knowledge of the project. The project’s README and source code are the authoritative sources; this guide summarizes the structure, commands, conventions, and security model that agents should respect.

---

## Project overview

`pi-heyyoo` is a **Pi coding-agent extension** that adds a secondary-model pair programmer. It registers a `yoo` tool and several `/yoo-*` commands inside the Pi agent. The secondary model reviews diffs, creates plans, suggests alternatives, recommends next steps, and performs final holistic judgments.

- **Name / version:** `pi-heyyoo` (package name `pi-heyyoo`), version read from `package.json`.
- **License:** MIT.
- **Author:** whatley.xyz.
- **Repository entry:** `src/index.ts`.
- **Runtime target:** Node.js, ES modules, TypeScript loaded directly by Pi (`"type": "module"`).

### What the extension exposes

**Tool `yoo`** — the main API used by the primary agent. Actions: `plan`, `review`, `suggest`, `recommend`, `judge`, `scan`, `test`, `security`.

**Slash commands** registered in the Pi terminal:

| Command                | Purpose                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `/yoo`                 | Run an action or show status: `/yoo <plan|review|suggest|recommend|judge|scan|test|security|status> [args]`. |
| `/yoo-status`, `/yoo-info` | Detailed diagnostics; `/yoo-info` is an alias for `/yoo-status`.                                  |
| `/yoo-model`           | Interactively pick the secondary model (optionally per tool) and write it to `~/.pi/agent/settings.json`. |
| `/yoo-config`          | View/edit pi-heyyoo settings: `/yoo-config <get|set|list> [key] [value]` or shorthand `/yoo-config <provider.model>`. |
| `/yoo-clear`           | Clear the active plan, state, cost, memory, conventions, learned facts, loop history, and inherited session. |
| `/yoo-clear-logs`      | Clear the per-project yoo error/event log.                                                            |
| `/yoo-index`           | Read stored yoo project context (`all`, `plan`, `memory`, `conventions`, `cost`, `logs`, `index`, `learned`; `--update` rebuilds the index). |
| `/yoo-explain`         | Explain code, an error, or a file via the secondary model.                                           |
| `/yoo-learn`           | Record or verify project facts for future sessions (`/yoo-learn <fact>` or `--verify`).             |
| `/yoo-search`          | Web search via the configured provider (DuckDuckGo/Brave).                                           |
| `/yoo-search-config`   | Configure the web search provider and save the Brave API key to `auth.json`.                         |
| `/yoo-next`            | Recommend the next step based on the active plan.                                                    |
| `/yoo-done`            | Mark the current plan step complete and recommend the next step.                                     |
| `/yoo-logs`            | Show recent yoo error/event log entries for this project.                                            |
| `/yoo-test`            | Test connectivity to the configured secondary model(s); an optional task name scopes the check.     |
| `/yoo-scan`            | Alias for `/yoo scan` — scan project conventions.                                                    |
| `/yoo-scan-deep`       | Run `/yoo scan` with deep source-file sampling.                                                      |
| `/yoo-backend`         | Switch the secondary model backend: `sdk` (default), `pi`, or `http`.                                |

---

## Technology stack

- **Language:** TypeScript 6.x (strict mode).
- **Module system:** ESM (`"type": "module"`), `nodenext` resolution.
- **Runtime:** Node.js.
- **Host platform:** Pi coding agent (`@earendil-works/pi-coding-agent`).
- **Validation schemas:** `@sinclair/typebox` (used only for tool parameter shapes).
- **TUI components:** `@earendil-works/pi-tui` (peer dependency; used in `src/render.ts` for tool call/result rendering).
- **Linting:** ESLint 10 with `@eslint/js` and `typescript-eslint` recommended configs.
- **Package manager:** npm (lockfile `package-lock.json`).

There is **no bundler and no compile step**. Source files are executed directly by Pi. Tests use the Node.js built-in test runner.

---

## Repository layout

```
pi-heyyoo/
├── package.json          # Package metadata, scripts, peer deps
├── tsconfig.json         # Strict TypeScript, noEmit, nodenext
├── eslint.config.js      # ESLint flat config
├── README.md             # User-facing documentation
├── scripts/
│   └── bump-version.js   # Semver bump helper (patch/minor/major)
└── src/
    ├── index.ts          # Extension entry: registers the yoo tool + all /yoo-* commands, orchestrates
    ├── types.ts          # Domain types/interfaces; re-exports backend types from types/secondary-model.ts
    ├── schemas.ts        # TypeBox schemas for structured results (plan steps, review/security, ...)
    ├── config.ts         # Load merged global + project config; resolve secondary settings and task-model overrides
    ├── secondary-model.ts# Entry point for model calls; key resolution, budget, backend dispatch, tool-loop
    ├── auth-reader.ts    # Resolve API keys from auth.json / env / commands (with !command, $ENV indirection)
    ├── prompts.ts        # Prompt builders and JSON result validators/salvagers
    ├── diff-grabber.ts   # Git/SVN diff collection and VCS info
    ├── file-loader.ts    # Load changed file contents within token budget
    ├── token-budget.ts   # Calculate per-action review token budgets
    ├── model-registry.ts # Known secondary model context windows and output limits
    ├── conventions.ts    # Scan project conventions and persist them; also filters source files for indexing
    ├── project-index.ts  # Build a TypeScript AST symbol index of the project (SymbolInfo)
    ├── project-snapshot.ts # Assemble a token-bounded project snapshot for plan/context prompts
    ├── plan-store.ts     # Persist plan/session state to disk
    ├── session-state.ts  # In-memory per-cwd session state map (completed steps, review rounds)
    ├── review-memory.ts  # Track recent issues per file for regression prompts
    ├── cost-tracker.ts   # Estimate, record, reserve/release, and budget secondary-model spend
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
    ├── format.ts         # Format yoo tool results into markdown text for the Pi TUI
    ├── yoo-tool-params.ts# Validation for the main yoo tool parameters
    ├── yoo-explain.ts    # /yoo-explain terminal command handler
    ├── yoo-index.ts      # /yoo-index terminal command handler
    ├── yoo-learn.ts      # /yoo-learn terminal command handler
    ├── yoo-search.ts     # /yoo-search terminal command handler
    ├── yoo-search-config.ts # /yoo-search-config terminal command handler
    ├── actions/          # One executor per yoo action + shared helpers
    │   ├── plan.ts       #   plan action executor
    │   ├── review.ts     #   review action executor
    │   ├── suggest.ts    #   suggest action executor
    │   ├── recommend.ts  #   recommend action executor
    │   ├── judge.ts      #   judge action executor
    │   ├── scan.ts       #   scan action executor
    │   ├── test.ts       #   test action executor
    │   ├── security.ts   #   security action executor
    │   ├── review-helpers.ts # shared review prompt assembly, budget, result handling
    │   ├── verify.ts     #   secondary-model self-verification loop for structured results
    │   └── shared.ts     #   cross-action helpers: STAGES, cost recording, JSON parsing, usage merging
    ├── commands/         # Terminal command helpers (argument parsers + registration)
    │   ├── arg-parsers.ts # parseReviewCommandArgs / parseTestCommandArgs / parseSecurityCommandArgs
    │   └── register.ts    # Registers all /yoo-* slash commands and delegates to the action executors
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
            ├── pi-peer-deps.d.ts
            └── pi-tui.d.ts
```

### Module responsibilities

- **`index.ts`** — Extension entry and main wiring. Wires the Pi session lifecycle (`session_start`/`session_shutdown`/`tool_execution_start`), registers the `yoo` tool, and delegates all `/yoo-*` slash-command registration to `registerYooCommands` (see `commands/register.ts`). Holds the per-`cwd` loop-detection state.
- **`types.ts`** — Domain types and interfaces (`YooAction`, `YooModelTask`, `HeyyooConfig`, ...); re-exports backend types from `types/secondary-model.ts`.
- **`schemas.ts`** — TypeBox schemas for structured results (plan steps, review/security results, etc.).
- **`config.ts`** — Loads merged global + project config; validates and resolves `secondary` settings, task-model overrides, and `DocsConfig`.
- **`secondary-model.ts`** — Entry point for secondary model calls; resolves the API key, enforces the cost budget, dispatches to the chosen backend, and runs the tool-loop when the model requests `read_file`/`run_command`.
- **`backends/`** — Pluggable model-call backends:
  - `sdk-backend.ts` — Pi's `pi-ai` SDK (default); provider attribution headers, retries, caching, thinking-level mapping.
  - `http-backend.ts` — Direct provider HTTP for custom `baseUrl` or explicit `backend: "http"`.
  - `pi-backend.ts` — Spawns the Pi CLI for fallback or explicit `backend: "pi"`.
  - `backend-resolver.ts` — Picks the backend and resolves SDK catalog metadata for token budgets.
  - `provider-api.ts` / `shared.ts` / `index.ts` — backend interface/types, shared helpers, and the backend registry.
- **`auth-reader.ts`** — Reads `~/.pi/agent/auth.json`, then falls back to environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.). Supports `!command`, `$ENV`, and `${ENV}` key indirection.
- **`prompts.ts`** — Builds system/user prompts for each action and validates/salvages the JSON the model returns.
- **`diff-grabber.ts`** — Uses `git diff` / `svn diff`. Supports `files`, `exclude`, `revision`, `since`, `untracked`. Truncates diffs to ~6,000 chars.
- **`file-loader.ts`** — Loads changed file contents within the token budget.
- **`token-budget.ts` / `model-registry.ts`** — Model context/output limits and per-action review token budgets.
- **`conventions.ts`** — Static heuristics over the tracked file list plus an LLM pass; stores conventions in `.pi/heyyoo/conventions.json`. Also provides `filterSourceFiles` / `listTrackedFiles` reused by indexing.
- **`project-index.ts`** — Builds a TypeScript AST symbol index of the project (`SymbolInfo`); persisted and reused by explain/suggest/recommend.
- **`project-snapshot.ts`** — Assembles a token-bounded project snapshot (tracked files, package.json, doc samples, index symbols) for plan/context prompts.
- **`plan-store.ts` / `session-state.ts`** — Persist plan/session state to disk and keep an in-memory per-`cwd` state map (completed steps, review rounds).
- **`review-memory.ts`** — Tracks recent issues per file for regression prompts.
- **`cost-tracker.ts`** — Estimates, records, reserves/releases, and budgets secondary-model spend.
- **`loop-detector.ts`** — Watches recent tool calls and emits a steer message when `yoo.review`/`yoo.judge` repeats without real edits.
- **`tool-loop.ts`** — Lets the secondary model request `read_file`/`run_command` tools to answer questions, with path-security and pre-review guards.
- **`pre-review.ts`** — Runs configured pre-review shell commands (interpreter commands restricted to relative scripts; inline-eval flags rejected) and formats output.
- **`render.ts`** — TUI call/result rendering for Pi.
- **`progress.ts`** — Status/progress reporting helpers for the Pi TUI.
- **`path-security.ts`** — Validates safe relative paths (path-traversal guard) for project file access.
- **`pi-paths.ts`** — Resolves Pi agent and project config paths.
- **`logger.ts`** — Per-project event/error log under `.pi/heyyoo/`.
- **`doc-fetcher.ts`** — Fetches web/doc context for `/yoo-search` and `/yoo-explain`.
- **`format.ts`** — Formats `YooToolResult` into the markdown text shown in the Pi TUI (`formatResultText`, plus `issueEmoji` / `formatModelSuffix` helpers).
- **`yoo-tool-params.ts`** — Validates the main `yoo` tool parameter object, resolves the requested action, and strips/ignores disallowed fields such as the removed `search` parameter.
- **`version.ts`** — Reads `VERSION` and `HOMEPAGE` from `package.json` so both `index.ts` and `commands/register.ts` share one source.
- **`commands/arg-parsers.ts`** — Pure string parsers that turn `/yoo review|test|security` command-line args into structured options objects.
- **`commands/register.ts`** — Registers every `/yoo-*` slash command (handlers plus `showYooStatus`); each handler validates args, calls the relevant `actions/` executor or `yoo-*` module, and renders the result with `formatResultText`. This is what keeps `index.ts` as pure wiring/export.
- **`actions/`** — One executor per `yoo` action plus shared helpers:
  - `plan.ts`, `review.ts`, `suggest.ts`, `recommend.ts`, `judge.ts`, `scan.ts`, `test.ts`, `security.ts` — action executors wiring config, prompts, diff/file loading, cost, and progress.
  - `review-helpers.ts` — Shared review prompt assembly, budget, and result handling.
  - `verify.ts` — Secondary-model self-verification loop for structured results.
  - `shared.ts` — Cross-action helpers: `STAGES`, cost recording, JSON parsing, usage merging.
- **`yoo-explain.ts`** — Handles `/yoo-explain`: explains code/error/file with the secondary model (optional doc context).
- **`yoo-index.ts`** — Handles `/yoo-index`: reads stored project context (plan, memory, conventions, cost, logs, index, learned).
- **`yoo-learn.ts`** — Handles `/yoo-learn`: records/verifies project facts for future sessions.
- **`yoo-search.ts`** — Handles `/yoo-search`: validates the query, checks `pi-heyyoo.docs.webSearch.enabled`, runs web search via `doc-fetcher.ts`, and formats raw results.
- **`yoo-search-config.ts`** — Handles `/yoo-search-config`: lets the user pick DuckDuckGo or Brave Search, and saves the Brave API key to `~/.pi/agent/auth.json` when provided inline.
- **`types/`** — Shared types: `docs.ts` (doc sources), `secondary-model.ts` (backend/SDK types), and `stubs/` ambient declarations (`pi-ai.d.ts`, `pi-peer-deps.d.ts`, `pi-tui.d.ts`).

---

## Build, check, and release commands

All commands run from the repository root.

| Command                | What it does                                         |
| ---------------------- | ---------------------------------------------------- |
| `npm install`          | Install dev dependencies and resolve peer deps.      |
| `npm run typecheck`    | Run `tsc --noEmit` against `src/`.                   |
| `npm run lint`         | Run ESLint against `src/`.                           |
| `npm test`             | Run the Node test runner against `src/**/*.test.ts`. |
| `npm run format`       | Run Prettier to format `src/`.                       |
| `npm run format:check` | Check Prettier formatting without writing.           |
| `npm run bump`         | Bump patch version in `package.json`.                |
| `npm run bump:patch`   | Same as `npm run bump`.                              |
| `npm run bump:minor`   | Bump minor version.                                  |
| `npm run bump:major`   | Bump major version.                                  |

There is **no `build`, `start`, or `dev` script**. Pi loads `src/index.ts` directly, and TypeScript is checked but not emitted (`tsconfig.json` has `"noEmit": true`).

### Pre-review commands recommended in README

The README example configures:

```json
{
  "pi-heyyoo": {
    "preReviewCommands": ["npm run typecheck", "npm run lint"]
  }
}
```

Tests live in `src/**/*.test.ts` and use the Node built-in test runner with `tsx`. If you add new test files, they are picked up automatically by `npm test`; also update `src/conventions.ts` inference if the project structure changes.

---

## Code style guidelines

Follow the existing style; the project is already internally consistent.

- **Modules:** ESM. Import Node built-ins with the `node:` prefix (`node:fs`, `node:path`, `node:child_process`).
- **Relative imports:** Use `.js` extensions for sibling/local modules (e.g. `import { loadHeyyooConfig } from "./config.js";`).
- **File names:** Kebab-case for source files (`diff-grabber.ts`, `secondary-model.ts`).
- **Type names:** PascalCase for interfaces, types, and classes.
- **Functions:** Named exports; prefer explicit return types on public module boundaries.
- **Formatting:** Two-space indentation, single quotes in strings where consistent with surrounding code.
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
5. For behavior changes, also exercise the Pi extension (`/yoo` commands or the `yoo` tool) or invoke the module with `tsx`.

Test files are co-located with the source modules they cover (`src/**/*.test.ts`). When adding new functionality, add or extend the relevant test file.

---

## Configuration and runtime architecture

### Configuration sources

`src/config.ts` merges two JSON files, with project settings overriding global settings:

1. `~/.pi/agent/settings.json` → `pi-heyyoo` object.
2. `<cwd>/.pi/settings.json` → `pi-heyyoo` object.

Relevant keys:

```ts
{
  "pi-heyyoo": {
    "secondary": { "provider": "opencode-go", "id": "deepseek-v4-pro", "thinking": "xhigh" },
    "autoJudge": true,
    "preReviewCommands": ["npm run typecheck", "npm run lint"],
    "costBudgetUsd": 0.5
  }
}
```

- `secondary.provider` / `secondary.id` — required; determines which model answers.
- `secondary.thinking` — optional reasoning budget (`off` → `xhigh`).
- `secondary.backend` — `"sdk"` (default), `"pi"`, or `"http"`. `"sdk"` uses Pi's `pi-ai` provider layer; `"pi"` spawns the Pi CLI; `"http"` uses direct provider HTTP.
- `secondary.baseUrl` — optional custom endpoint for any OpenAI-compatible or Anthropic-compatible provider.
- `secondary.apiKey` — optional inline API key (prefer `auth.json` or env vars).
- `secondary.style` — `"openai-compatible"` (default) or `"anthropic"`; used only with `baseUrl`.
- `secondary.authHeader` / `secondary.authPrefix` — optional auth header overrides; used only with `baseUrl`.
- `secondary.contextWindow` / `secondary.maxOutputTokens` — optional overrides for the current model.
- `secondary.cacheRetention` / `secondary.transport` / `secondary.maxRetries` / `secondary.maxRetryDelayMs` / `secondary.timeoutMs` — optional SDK backend tuning. Defaults mirror the main Pi agent (`cacheRetention: "short"`, `maxRetries: 3`, `timeoutMs: 300000`).
- API keys are resolved by pi-heyyoo (`secondary.apiKey` → `~/.pi/agent/auth.json` → env vars → `!command`), then by the `pi-ai` SDK's own credential/env lookup if no explicit key is found.
- If the SDK backend hits a retryable provider error, pi-heyyoo falls back to the `pi` backend once.
- `modelInfo` — optional per-model token budget overrides, keyed by model id.
- `autoJudge` — run `judge` automatically when the last plan step passes review.
- `preReviewCommands` — shell commands run before each review; output is included in the prompt. Interpreter commands (`node`, `npx`, `python`, `python3`, `ruby`) are restricted to relative script files; inline-evaluation flags (`-c`, `-e`, `--eval`, etc.) are rejected.
- `costBudgetUsd` — hard cap on estimated spend for the current Pi session. Negative values are treated as unset; `0` means no spend is allowed. `cost.json` is reset at the start of each Pi session and can also be cleared with `/yoo-clear`.

When `secondary.baseUrl` is set, the hardcoded provider map is bypassed and the configured endpoint is used directly. This makes the extension provider-universal. `modelInfo` makes the model registry user-configurable, so unknown models don't require code changes.

Example:

```json
{
  "pi-heyyoo": {
    "secondary": {
      "provider": "opencode-custom",
      "id": "qwen3.7-max",
      "baseUrl": "https://your.opencode.endpoint/v1"
    },
    "modelInfo": {
      "qwen3.7-max": { "contextWindow": 128000, "maxOutputTokens": 8192 }
    }
  }
}
```

### Authentication

API keys are resolved by `src/auth-reader.ts` in order:

1. `pi-heyyoo.secondary.apiKey` in settings (if set).
2. `~/.pi/agent/auth.json` entry for the provider (`{ "type": "api_key", "key": "..." }`).
3. Environment variable mapped to the provider (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.).
4. Indirection supported: `"key": "!command"`, `"key": "$ENV"`, `"key": "${ENV}"`.

### Runtime data

The extension stores per-project runtime data under `.pi/heyyoo/`:

- `plan.json` — active plan, completed steps, review-round counter, and which completed steps were reviewed vs. manually marked done.
- `conventions.json` — cached project conventions.
- `cost.json` — estimated spend for the current Pi session.
- `memory.json` — recent issues per file.

`.pi/` is gitignored. Do not commit it.

### Session lifecycle

- `pi.on("session_start")` loads disk state into an in-memory `Map<string, HeyyooSessionState>` keyed by `cwd`.
- `pi.on("session_shutdown")` drops the in-memory entry (state is already persisted).
- `pi.on("tool_execution_start")` records calls for loop detection.

---

## Security considerations

- **Never commit API keys.** Keys live only in `~/.pi/agent/auth.json` or environment variables.
- **`.pi/` is gitignored.** It contains runtime state that may include file paths, issue descriptions, and cost data; keep it out of version control.
- **State files are written with mode `0o600`** to limit local access.
- **Pre-review commands execute shell commands.** They are configured by the user, but any code that builds or mutates that list must not inject unsanitized input.
- **Diffs are truncated and filtered locally** before being sent to the secondary model, but review payloads still contain source-code diffs. Be careful not to include secrets in diffs sent for review.
- **Auth command indirection (`!command`)** runs arbitrary shell commands from `auth.json`; this is a user-controlled feature, not code-controlled.

---

## Deployment / distribution

- The package is consumed by Pi, not by end-users directly. Pi resolves it as an extension via `"pi": { "extensions": ["./src/index.ts"] }` in `package.json`.
- The `files` array publishes only `src/` and `README.md`.
- Version bumps are done with `npm run bump:patch|minor|major`, which edits `package.json` in place.
- There are no CI workflows, Docker files, or deployment scripts in this repository.

---

## Notes for agents

- The previous `AGENTS.md` did not exist; this file was created from the actual project contents.
- Do not assume a build step. Changes are validated with `npm run typecheck` and `npm run lint`.
- When editing source, keep the kebab-case filenames, `.js` relative imports, and `node:` prefix for built-ins.
- If you change validation schemas or tool parameters, also update the corresponding prompt builders and validators in `src/prompts.ts`.
- The `.pi/cdev/map.yaml` file is auto-generated metadata; do not hand-edit it unless asked.
