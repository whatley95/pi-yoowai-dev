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

| Surface | Purpose |
|---------|---------|
| Tool `yoo` | Main API used by the primary agent: `plan`, `review`, `suggest`, `recommend`, `judge`, `scan`. |
| Command `/yoo` | Run actions or show status from the terminal. |
| Commands `/yoo-status`, `/yoo-info` | Detailed diagnostics. |
| Command `/yoo-model` | Interactively pick the secondary model and write it to `~/.pi/agent/settings.json`. |
| Command `/yoo-config` | Guidance for configuring the secondary model. |
| Command `/yoo-clear` | Clear plan, session state, cost tracking, memory, and conventions. |

---

## Technology stack

- **Language:** TypeScript 6.x (strict mode).
- **Module system:** ESM (`"type": "module"`), `nodenext` resolution.
- **Runtime:** Node.js.
- **Host platform:** Pi coding agent (`@earendil-works/pi-coding-agent`).
- **Validation schemas:** `@sinclair/typebox` (used only for tool parameter shapes).
- **Linting:** ESLint 10 with `@eslint/js` and `typescript-eslint` recommended configs.
- **Package manager:** npm (lockfile `package-lock.json`).

There is **no bundler, no test framework, and no compile step**. Source files are executed directly by Pi.

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
    └── types/stubs/      # Ambient declarations for peer dependencies
        ├── pi-peer-deps.d.ts
        └── pi-tui.d.ts
```

### Module responsibilities

- **`index.ts`** — Main orchestrator. Holds per-`cwd` session state in memory, wires tool/command handlers, formats final text output, and integrates all submodules.
- **`secondary-model.ts`** — Maps provider names (e.g. `anthropic`, `openai`, `deepseek`, `opencode-go`, `google`) to API styles, builds chat requests, estimates tokens/cost, and returns raw model output.
- **`auth-reader.ts`** — Reads `~/.pi/agent/auth.json`, then falls back to environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.). Supports `!command`, `$ENV`, and `${ENV}` key indirection.
- **`prompts.ts`** — Builds system/user prompts for each action and validates the JSON the model returns.
- **`diff-grabber.ts`** — Uses `git diff` / `svn diff`. Supports `files`, `exclude`, `revision`, `since`, `untracked`. Truncates diffs to ~6,000 chars.
- **`conventions.ts`** — Static heuristics over the tracked file list plus an LLM pass; stores conventions in `.pi/heyyoo/conventions.json`.
- **`cost-tracker.ts` / `plan-store.ts` / `review-memory.ts`** — Persistent state under `.pi/heyyoo/`.
- **`loop-detector.ts`** — Watches recent tool calls and emits a steer message when `yoo.review`/`yoo.judge` repeats without real edits.

---

## Build, check, and release commands

All commands run from the repository root.

| Command | What it does |
|---------|--------------|
| `npm install` | Install dev dependencies and resolve peer deps. |
| `npm run typecheck` | Run `tsc --noEmit` against `src/`. |
| `npm run lint` | Run ESLint against `src/`. |
| `npm run bump` | Bump patch version in `package.json`. |
| `npm run bump:patch` | Same as `npm run bump`. |
| `npm run bump:minor` | Bump minor version. |
| `npm run bump:major` | Bump major version. |

There is **no `build`, `test`, `start`, or `dev` script**. Pi loads `src/index.ts` directly, and TypeScript is checked but not emitted (`tsconfig.json` has `"noEmit": true`).

### Pre-review commands recommended in README

The README example configures:

```json
{
  "pi-heyyoo": {
    "preReviewCommands": [
      "npm run typecheck",
      "npm run lint"
    ]
  }
}
```

If you add tests, wire them here and in `package.json` scripts; update `src/conventions.ts` and this file so the scan detects them.

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

This project currently **does not have an automated test suite** (no `test` script, no test framework dependency, no test files).

Validation is manual / integration-based:

1. `npm run typecheck` must pass.
2. `npm run lint` must pass.
3. If you change behavior, exercise it through the Pi extension (`/yoo` commands or the `yoo` tool) or by invoking the module with `tsx`.

When adding tests, choose a framework consistent with the project conventions at that time and update this section.

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
- `autoJudge` — run `judge` automatically when the last plan step passes review.
- `preReviewCommands` — shell commands run before each review; output is included in the prompt.
- `costBudgetUsd` — hard cap on session spend.

### Authentication

API keys are resolved by `src/auth-reader.ts` in order:

1. `~/.pi/agent/auth.json` entry for the provider (`{ "type": "api_key", "key": "..." }`).
2. Environment variable mapped to the provider (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.).
3. Indirection supported: `"key": "!command"`, `"key": "$ENV"`, `"key": "${ENV}"`.

### Runtime data

The extension stores per-project runtime data under `.pi/heyyoo/`:

- `plan.json` — active plan, completed steps, review-round counter.
- `conventions.json` — cached project conventions.
- `cost.json` — estimated session spend.
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
