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

| Surface                             | Purpose                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| Tool `yoo`                          | Main API used by the primary agent: `plan`, `review`, `suggest`, `recommend`, `judge`, `scan`. |
| Command `/yoo`                      | Run actions or show status from the terminal.                                                  |
| Commands `/yoo-status`, `/yoo-info` | Detailed diagnostics.                                                                          |
| Command `/yoo-model`                | Interactively pick the secondary model and write it to `~/.pi/agent/settings.json`.            |
| Command `/yoo-config`               | Guidance for configuring the secondary model.                                                  |
| Command `/yoo-clear`                | Clear plan, session state, cost tracking, memory, and conventions.                             |

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
    ├── index.ts          # Extension entry: registers tools/commands, orchestrates actions
    ├── types.ts          # Domain types and interfaces
    ├── config.ts         # Load merged global + project config
    ├── secondary-model.ts# Provider map and HTTP calls to secondary LLMs
    ├── auth-reader.ts    # Resolve API keys from auth.json / env / commands
    ├── prompts.ts        # Prompt builders and JSON result validators
    ├── diff-grabber.ts   # Git/SVN diff collection and VCS info
    ├── plan-store.ts     # Persist plan/session state to disk
    ├── conventions.ts    # Scan project conventions and persist them
    ├── review-memory.ts  # Track recent issues per file for regression prompts
    ├── cost-tracker.ts   # Estimate, record, and budget secondary-model spend
    ├── loop-detector.ts  # Detect review-fix loops and emit steer messages
    ├── pre-review.ts     # Run configured pre-review shell commands
    ├── render.ts         # TUI call/result rendering for Pi
    ├── progress.ts       # Status/progress reporting helpers
    ├── file-loader.ts    # Load changed file contents within token budget
    ├── token-budget.ts   # Calculate review token budgets from model info
    ├── model-registry.ts # Known secondary model context windows and output limits
    ├── pi-paths.ts       # Resolve Pi agent and project config paths
    ├── logger.ts         # Per-project event/error log
    ├── yoo-search.ts     # /yoo-search terminal command handler
    ├── yoo-tool-params.ts # Validation for the main yoo tool parameters
    └── types/stubs/      # Ambient declarations for peer dependencies
        ├── pi-peer-deps.d.ts
        └── pi-tui.d.ts
```

### Module responsibilities

- **`index.ts`** — Main orchestrator. Holds per-`cwd` session state in memory, wires tool/command handlers, formats final text output, and integrates all submodules.
- **`secondary-model.ts`** — Entry point for secondary model calls; resolves task model overrides, enforces the cost budget, and dispatches to the appropriate backend.
- **`backends/`** — Three interchangeable backends for model calls:
  - `sdk-backend.ts` — Pi's `pi-ai` SDK (default); handles provider attribution headers, retries, caching, and thinking-level mapping.
  - `http-backend.ts` — Direct provider HTTP for custom `baseUrl` or explicit `backend: "http"`.
  - `pi-backend.ts` — Spawns the Pi CLI for fallback or explicit `backend: "pi"`.
  - `backend-resolver.ts` — Picks the backend and resolves SDK catalog metadata for token budgets.
- **`auth-reader.ts`** — Reads `~/.pi/agent/auth.json`, then falls back to environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.). Supports `!command`, `$ENV`, and `${ENV}` key indirection.
- **`prompts.ts`** — Builds system/user prompts for each action and validates the JSON the model returns.
- **`diff-grabber.ts`** — Uses `git diff` / `svn diff`. Supports `files`, `exclude`, `revision`, `since`, `untracked`. Truncates diffs to ~6,000 chars.
- **`conventions.ts`** — Static heuristics over the tracked file list plus an LLM pass; stores conventions in `.pi/heyyoo/conventions.json`.
- **`cost-tracker.ts` / `plan-store.ts` / `review-memory.ts`** — Persistent state under `.pi/heyyoo/`.
- **`loop-detector.ts`** — Watches recent tool calls and emits a steer message when `yoo.review`/`yoo.judge` repeats without real edits.
- **`yoo-search.ts`** — Handles the `/yoo-search` terminal command: validates the query, checks `pi-heyyoo.docs.webSearch.enabled`, runs DuckDuckGo search via `doc-fetcher.ts`, and formats raw results.
- **`yoo-tool-params.ts`** — Validates the main `yoo` tool parameter object, resolves the requested action, and strips/ignores disallowed fields such as the removed `search` parameter.

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
