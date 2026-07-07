# pi-heyyoo

Pair-programmer extension for [Pi](https://github.com/earendil-works/pi). A secondary model reviews, plans, suggests, recommends, and judges your work — catching bugs, missing error handling, and blind spots.

Built by [whatley.xyz](https://whatley.xyz).

## Install

```bash
pi install git:github.com/whatley95/pi-heyyoo-dev
```

Or from local path:

```bash
pi install ./pi-heyyoo
```

Try without installing:

```bash
pi -e git:github.com/whatley95/pi-heyyoo-dev
```

## Configuration

Add to your Pi agent settings file (usually `~/.pi/agent/settings.json`):

```json
{
  "pi-heyyoo": {
    "secondary": {
      "provider": "opencode-go",
      "id": "deepseek-v4-pro",
      "thinking": "xhigh",
      "contextWindow": 64000,
      "maxOutputTokens": 8192
    },
    "autoJudge": true,
    "preReviewCommands": ["npm run typecheck", "npm run lint"],
    "costBudgetUsd": 0.5,
    "reviewFullFileThresholdLines": 300,
    "reviewMaxInputTokens": 50000,
    "reviewStrategy": "auto",
    "modelInfo": {
      "qwen3.7-max": { "contextWindow": 128000, "maxOutputTokens": 8192 }
    },
    "taskModels": {
      "review": { "provider": "anthropic", "id": "claude-sonnet-4-5", "thinking": "high" },
      "scan": { "provider": "deepseek", "id": "deepseek-chat", "thinking": "off" }
    }
  }
}
```

**Recommended:** Use a DIFFERENT model family than your main agent. If main is DeepSeek, set secondary to Claude or GPT. This catches blind spots your main model shares.

If no secondary model is configured, yoo returns an error. Configure `pi-heyyoo.secondary` in settings.json or use `/yoo-model` to pick one interactively. You can also set a different model per yoo tool with `taskModels` or `/yoo-model`.

Structured tools let the secondary model write brief Markdown analysis, but the final machine-readable result must be a fenced JSON block under `## Result`. The configured `thinking` level is passed through unchanged for each tool, including per-tool `taskModels` overrides; yoo does not silently cap or turn off thinking after parse failures.

### Options

| Option                         | Type                                    | Description                                                                                                                         |
| ------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `secondary`                    | object                                  | `{ provider, id, thinking? }` for the base secondary model                                                                          |
| `taskModels`                   | object                                  | Per-tool model overrides keyed by action (`plan`, `review`, `suggest`, `recommend`, `judge`, `scan`, `test`, `security`, `explain`)  |
| `autoJudge`                    | boolean                                 | Run `yoo.judge` automatically when the last plan step passes review                                                                 |
| `preReviewCommands`            | string[]                                | Commands to run before each review; output is included in the review prompt                                                         |
| `testCommand`                  | string                                  | Command to run for `/yoo test` analysis (e.g. `npm test`). Auto-detected from `package.json` if omitted                             |
| `costBudgetUsd`                | number                                  | Maximum estimated session spend before yoo stops with an error. Negative values are treated as unset; `0` means no spend is allowed |
| `reviewMaxDiffChars`           | number                                  | Legacy cap on diff characters; prefer `reviewMaxInputTokens`                                                                        |
| `reviewFullFileThresholdLines` | number                                  | Include full content for changed files under this line count (default: 300)                                                         |
| `reviewMaxInputTokens`         | number                                  | Hard cap on review input tokens                                                                                                     |
| `reviewStrategy`               | `"auto" \| "diff-only" \| "full-files"` | How to include changed file contents (default: `"auto"`)                                                                            |
| `verifyByDefault`              | boolean                                 | If true, every yoo result asks the main agent to confirm the finding with evidence                                                  |
| `secondary.contextWindow`      | number                                  | Override the model's context window                                                                                                 |
| `secondary.maxOutputTokens`    | number                                  | Override the model's max output tokens                                                                                              |
| `secondary.backend`             | `"pi" \| "http"`                       | Backend for model calls. `"pi"` spawns child pi process; `"http"` uses direct provider HTTP. Auto-detected if omitted (known providers → HTTP, unknown → pi) |
| `secondary.baseUrl`            | string                                  | Custom endpoint for any OpenAI-compatible or Anthropic-compatible provider                                                          |
| `secondary.apiKey`             | string                                  | Inline API key (prefer `auth.json` or env vars)                                                                                     |
| `secondary.style`              | `"openai-compatible" \| "anthropic"`    | API style when using `baseUrl` (default: `"openai-compatible"`)                                                                     |
| `secondary.authHeader`         | string                                  | Custom auth header name when using `baseUrl`                                                                                        |
| `secondary.authPrefix`         | string                                  | Custom auth prefix when using `baseUrl`                                                                                             |
| `modelInfo`                    | object                                  | Per-model token budget overrides, keyed by model id                                                                                 |
| `processTimeoutMs`             | number                                  | Timeout in ms for child pi process calls (default: 300000 = 5 min)                                                                  |
| `testTimeoutMs`                | number                                  | Timeout in ms per model in `/yoo test` (default: 120000 = 2 min)                                                                   |

## Tools

The `yoo` tool is called by the main agent during development:

| Action                                                                | When                           | What it does                                                        |
| --------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `yoo({ plan: "refactor auth" })`                                      | Before starting                | Creates structured todo + acceptance criteria                       |
| `yoo({ review: "wrote middleware" })`                                 | After each step                | Reviews git diff, returns verdict + issues                          |
| `yoo({ review: "wrote middleware", files: ["src/auth.ts"] })`         | After each step                | Reviews only the listed files                                       |
| `yoo({ review: "wrote middleware", exclude: ["package-lock.json"] })` | After each step                | Reviews diff excluding listed files                                 |
| `yoo({ review: "wrote middleware", revision: "HEAD~1" })`             | After each step                | Reviews changes against a specific revision                         |
| `yoo({ review: "wrote middleware", untracked: true })`                | After each step                | Includes untracked (new) files in the review                        |
| `yoo({ suggest: "how to..." })`                                       | When stuck or asked a question | Returns alternative approaches with pros/cons                       |
| `yoo({ recommend: "what next" })`                                     | When unsure                    | Recommends next concrete step                                       |
| `yoo({ judge: "all done" })`                                          | Final review                   | Holistic review against original plan                               |
| `yoo({ scan: true })`                                                 | Once per project               | Learns project conventions and architecture                         |
| `yoo({ test: "added payment service" })`                              | After code changes             | Checks for failing tests, missing tests, and test-quality issues    |
| `yoo({ security: "auth changes" })`                                   | Security-sensitive changes     | Audits diff for secrets, injection, auth, and other vulnerabilities |
| `yoo({ review: "...", verify: true })`                                | Any high-stakes result         | Asks the main agent to confirm or refute the finding with evidence  |

Plan steps can include `priority` (`high`, `medium`, `low`) and `dependsOn` (1-based list of earlier steps). Plain-string steps still work for backward compatibility.

### `yoo_index` tool

The `yoo_index` tool is a fast, read-only lookup for stored yoo context. It does not call a model.

| Call | What it returns |
| --- | --- |
| `yoo_index({})` or `yoo_index({ topic: "all" })` | Conventions, active plan, review memory, cost, and recent logs |
| `yoo_index({ topic: "conventions" })` | Project conventions from `yoo scan` |
| `yoo_index({ topic: "plan" })` | Active todo list and progress |
| `yoo_index({ topic: "memory" })` | Past review issues for all files |
| `yoo_index({ topic: "memory", files: ["src/auth.ts"] })` | Past review issues for specific files |
| `yoo_index({ topic: "memory", query: "race condition" })` | Memory entries matching a keyword |
| `yoo_index({ topic: "cost" })` | Estimated session spend |
| `yoo_index({ topic: "logs" })` | Recent yoo log entries |
| `yoo_index({ topic: "index" })` | Project symbol index (built by `yoo scan-deep` or `yoo_index({ update: true })`) |
| `yoo_index({ topic: "learned" })` | Facts recorded with `yoo_learn` |
| `yoo_index({ update: true })` | Rebuild the symbol index before returning results |

Use `yoo_index` before editing to quickly learn the project's rules, current task, known issues, symbols, and recorded facts.

### `yoo_explain` tool

Explain a code snippet, error message, diff, or file with the secondary model.

| Call | What it does |
| --- | --- |
| `yoo_explain({ target: "TypeError: Cannot read..." })` | Explains an error and the likely fix |
| `yoo_explain({ target: "src/auth.ts" })` | Explains the purpose and structure of a file |
| `yoo_explain({ target: "function verifySession", files: ["src/auth.ts"] })` | Explains a specific function with full file context |

`yoo_explain` is read-only — it does not edit files. If you pass a merge conflict, it explains the conflicting versions and suggests resolutions, but it does not claim the files are resolved.

### `yoo_learn` tool

Record a persistent project fact that yoo will remember across sessions.

| Call | What it does |
| --- | --- |
| `yoo_learn({ fact: "Auth is handled by Clerk" })` | Stores a fact |
| `yoo_learn({ fact: "Use camelCase for functions", category: "conventions" })` | Stores a categorized fact |
| `yoo_learn({ verify: true })` | Check all stored facts against the current codebase (heuristic, no model call) |
| `yoo_learn({ verify: true, query: "auth" })` | Verify only facts matching a keyword |
| `yoo_learn({ verify: true, deep: true })` | Verify facts with the secondary model for higher accuracy |
| `yoo_learn({ verify: true, deep: true, query: "auth" })` | Deep verify only facts matching a keyword |

Recorded facts appear in `yoo_index({ topic: "learned" })`.

`verify` checks referenced files, source files, and symbols from the project index. It returns each fact as `valid`, `questionable`, or `outdated` — no model call, so it is fast and safe to run manually.

`verify` + `deep` calls the secondary model for each fact, including the source file and project conventions in the prompt. It is more accurate but costs tokens per fact.

## Commands

| Command                                        | What it does                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/yoo`                                         | Compact status card: version, model, plan, VCS, cost, conventions                      |
| `/yoo plan refactor auth middleware`           | Create a plan from the terminal                                                        |
| `/yoo review "wrote verifySession"`            | Review current changes                                                                 |
| `/yoo suggest "redis vs in-memory sessions?"`  | Get alternative approaches with pros/cons                                              |
| `/yoo recommend`                               | Get one concrete next step based on your current situation/plan                        |
| `/yoo judge "auth refactor complete"`          | Final holistic review                                                                  |
| `/yoo scan`                                    | Scan project conventions                                                               |
| `/yoo test [description] [--command <cmd>]`    | Analyze test coverage and failures for current changes                                 |
| `/yoo security [description] [--full-project]` | Security audit of current diff or sampled project files                                |
| `/yoo-status`                                  | Detailed diagnostics: base + per-tool models, config, plan, VCS, conventions, cost     |
| `/yoo-info`                                    | Alias for `/yoo-status`                                                                |
| `/yoo-index [topic] [--update]`                | Read stored yoo context (plan, memory, conventions, cost, logs, index, learned)        |
| `/yoo-explain <target> [--files ...]`          | Explain code, error, or file with the secondary model                                  |
| `/yoo-learn <fact> [--category <cat>]`         | Record a persistent project fact                                                       |
| `/yoo-learn --verify [--query <keyword>]`      | Check stored facts against the current codebase                                        |
| `/yoo-learn --verify --deep [--query <keyword>]` | Check stored facts with the secondary model                                            |
| `/yoo-model`                                   | Interactively pick the base or per-tool model; shows current provider/model/thinking   |
| `/yoo-model <provider> [filter]`               | Pre-select provider and optionally filter the model list                               |
| `/yoo-config`                                  | Show current `pi-heyyoo` settings                                                      |
| `/yoo-config get <key>`                        | Read a dotted setting (e.g. `/yoo-config get secondary.thinking`)                      |
| `/yoo-config set <key> <value>`                | Write a dotted setting (e.g. `/yoo-config set taskModels.review.id claude-sonnet-4-5`) |
| `/yoo-config <provider.model>`                 | Set the base secondary model directly (e.g. `/yoo-config openai.gpt-4o`)               |
| `/yoo-test`                                    | Test connectivity; prints a per-model summary with latency, tokens, cost, and totals   |
| `/yoo-backend <pi\|http>`                      | Switch secondary model backend (default: `pi`)                                         |
| `/yoo-clear`                                   | Clear the current session's plan, state, cost, memory, and conventions                 |
| `/yoo-next`                                    | Recommend the next step based on the active plan                                       |
| `/yoo-done`                                    | Mark the current plan step complete and recommend the next step                        |
| `/yoo-logs`                                    | Show recent error/event log entries for this project                                   |
| `/yoo-clear-logs`                              | Clear the yoo error/event log for this project                                         |

### Review command options

`/yoo review` accepts flags to scope the diff:

```text
/yoo review upload component --revision HEAD~1
/yoo review check r1234 changes --since 1230 --vcs svn
/yoo review look at these files --files src/app.ts,src/lib.ts
/yoo review exclude generated --exclude dist/,package-lock.json
/yoo review include new files --untracked
```

| Flag                | Description                                                     |
| ------------------- | --------------------------------------------------------------- |
| `--revision` / `-r` | Compare against a revision (e.g. `HEAD~1`, `1234`, `1234:HEAD`) |
| `--since` / `-s`    | Include changes since a revision or commit ID                   |
| `--files` / `-f`    | Comma-separated list of files to review                         |
| `--exclude` / `-x`  | Comma-separated list of files/patterns to exclude               |
| `--vcs git\|svn`    | Force Git or SVN diff mode                                      |
| `--untracked`       | Include untracked (new) files                                   |

`/yoo test` and `/yoo security` accept the same diff-scoping flags as `/yoo review` (`--files`, `--exclude`, `--revision`, `--since`, `--vcs`, `--untracked`). `/yoo-test` (with a hyphen) is a separate command that tests model connectivity.

## Logging

yoo writes error and event entries to `<pi-config-dir>/heyyoo/yoo.log` in the current project (by default `.pi/heyyoo/yoo.log`). Use these commands to inspect or clear it:

```text
/yoo-logs        # show last 50 entries
/yoo-clear-logs  # empty the log
```

Logged events include secondary model errors, parse failures (with a raw response snippet), command failures, and diagnostic context like provider/model/thinking level.

## Process flow

```
yoo.plan("refactor auth")
  → Plan: 5 steps, 4 acceptance criteria

yoo.scan()
  → learns project conventions and architecture

yoo.review("wrote verifySession middleware")
  → git diff → secondary model
  → verdict: "needs-work" — 2 issues found
  → Progress: 0/5 steps done

  [fix issues...]

yoo.review("fixed error handling")
  → verdict: "pass" — consensus ✓
  → Progress: 1/5 steps done
  → Next: migrate login route

  [next step...]

yoo.review("migrated all routes")
  → verdict: "pass" — consensus ✓
  → Progress: 5/5 steps done
  → autoJudge: final review triggered

yoo.judge("auth refactor complete")
  → final review against plan + review history
  → verdict: "pass" — all work complete ✓
```

### Review escalation

If a single plan step fails review 3 times, yoo marks the review as escalated. The main agent should ask the user for guidance or consider a different approach instead of looping.

### Loop detection

yoo watches for repetitive patterns and sends a steering message if:

- `yoo` tools are called 3+ times in a row without real code edits
- The same `yoo` call is repeated with the same description

This prevents the main agent from spinning in review-fix-review cycles.

## How it works

- **Auto-detect backend** — known providers use direct HTTP (fast, no child process); unknown providers fall back to the pi process for Pi's routing/auth layer; override with `secondary.backend` or `/yoo-backend`
- **Automatic diff collection** — `yoo.review` auto-runs `git diff HEAD` (or `svn diff`)
- **Adaptive context** — automatically includes full contents of small changed files, outlines for large ones, and respects the model's token budget
- **Diff scope control** — limit reviews with `files`, `exclude`, `revision`, `since`, or `untracked`
- **Session-scoped state** — plan, review memory, and cost are scoped to the current Pi session, so old plans and issues do not leak into unrelated work; conventions persist per project
- **Deep project scan** — `yoo.scan` reads `package.json`, `AGENTS.md`, detects frameworks, tests, ORM, UI, build tools, CI, package manager, entry points, scripts, and samples code style
- **Project symbol index** — `yoo scan-deep` parses TypeScript/JavaScript source files and stores exported functions, classes, interfaces, types, and more; surfaced by `yoo_index`
- **Project conventions** — scan results feed into plan, suggest, recommend, review, and judge prompts
- **Learned facts** — `yoo_learn` persists project-specific facts across sessions; surfaced by `yoo_index`
- **Review memory** — previous issues per file are included so the model knows what was already fixed; memory is reset for each new Pi session
- **Pre-review commands** — configured lint/test/typecheck output is included in the review prompt
- **Cost tracking + budget** — estimated spend per call, session total, and optional hard budget
- **Robust JSON parsing** — accepts Markdown analysis followed by a `## Result` fenced JSON block, unwraps wrapper objects like `{ "response": "..." }`, and falls back to markdown salvage without changing the configured thinking level
- **One round-trip** — secondary model has no tools, pure judgment
- **Supports OpenAI-compatible and Anthropic APIs** — 26 providers pre-configured for direct HTTP, plus any custom endpoint via `baseUrl`

## Consensus protocol

Both agents agree when:

1. `yoo.review` returns `{ verdict: "pass", consensus: true }` for each step
2. `yoo.judge` returns `{ verdict: "pass", consensus: true }` for the full task

The secondary model checks:

- Error handling (missing try/catch, null checks)
- Imports and references
- Project conventions
- Logic errors
- Plan completeness

## Verification

When a yoo finding is surprising, high-stakes, or unclear, add `verify: true` to the tool call:

```js
yoo({ review: "refactored payment service", verify: true });
```

The tool result then asks the main agent to confirm or refute the finding and provide evidence (specific files, lines, facts, or reasoning). Use this to catch model hallucinations or over-eager approvals before acting.

Set `verifyByDefault: true` in `pi-heyyoo` settings to request verification on every yoo result.

## Questions and decisions

yoo is not only for code changes. Use it for questions and decisions too:

- `yoo({ suggest: "should I use callbacks or async/await here?" })` — compare 2–3 alternative approaches with pros/cons when you are unsure which path to take.
- `yoo({ recommend: "what should I investigate next?" })` — get one decisive next step, with reasoning and rejected alternatives, based on your current situation and plan.

When the user asks a technical or architectural question, call `yoo.suggest` or `yoo.recommend` before answering from your own knowledge.

**Suggest vs Recommend:** `suggest` is for exploring options; `recommend` is for deciding what to do next.

## Supported providers

**Direct HTTP (26 providers)** — fast, no child process overhead:

| Provider                                                                        | API style         |
| ------------------------------------------------------------------------------- | ----------------- |
| anthropic                                                                       | Anthropic native  |
| openai, deepseek, openrouter, groq, mistral, xai, together, fireworks, cerebras | OpenAI-compatible |
| google                                                                          | Google Gemini (OpenAI-compatible endpoint) |
| ant-ling, nvidia, huggingface, moonshotai, moonshotai-cn                        | OpenAI-compatible |
| xiaomi, xiaomi-token-plan-ams/cn/sgp, zai, zai-coding-cn                        | OpenAI-compatible |
| kimi-coding, minimax, minimax-cn, vercel-ai-gateway                             | Anthropic native  |

**Pi backend (per-model routing)** — these providers have models with mixed API styles, so they use the pi process which handles per-model routing:

| Provider       | Reason                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------ |
| opencode-go    | Some models use openai-completions, others use anthropic-messages with different baseUrls  |
| opencode       | Same — mixed openai-completions, anthropic-messages, google-generative-ai, openai-responses |

**Auto-detect:** When no `backend` is explicitly set, pi-heyyoo uses direct HTTP for known providers or custom `baseUrl`, and falls back to the pi process for unknown providers. Set `secondary.backend` to `"http"` or `"pi"` to override.

You can also use **any OpenAI-compatible or Anthropic-compatible endpoint** by setting `secondary.baseUrl`. Set `secondary.style` to `"anthropic"` for Anthropic-style endpoints.

```json
{
  "pi-heyyoo": {
    "secondary": {
      "provider": "opencode-custom",
      "id": "qwen3.7-max",
      "baseUrl": "https://your.opencode.endpoint/v1",
      "apiKey": "sk-..."
    }
  }
}
```

API keys are resolved in order: `secondary.apiKey` → `~/.pi/agent/auth.json` → environment variables → `!command` execution. For Anthropic, `ANTHROPIC_OAUTH_TOKEN` is checked before `ANTHROPIC_API_KEY` (matching Pi's precedence).

## Development scripts

```bash
npm run typecheck      # TypeScript type check
npm run lint           # ESLint
npm run test           # Node test runner (src/**/*.test.ts)
npm run format         # Prettier format
npm run format:check   # Prettier check
```

## Version bumping

```bash
npm run bump:patch   # 0.2.x → 0.2.x+1
npm run bump:minor   # 0.2.x → 0.3.0
npm run bump:major   # 0.2.x → 1.0.0
```

The version shown in `/yoo` is read automatically from `package.json`.
