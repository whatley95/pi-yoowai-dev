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
      "backend": "sdk",
      "cacheRetention": "auto",
      "transport": "fetch",
      "maxRetries": 3,
      "maxRetryDelayMs": 8000,
      "timeoutMs": 120000,
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

**Cost tip:** high-frequency, low-stakes calls do not need a flagship model. Reserve the strong model for `plan`, `review`, and `judge`, and route routine work like `done` (step verification) and `scan` (convention extraction) to a cheap model with thinking off:

```json
"taskModels": {
  "done": { "provider": "deepseek", "id": "deepseek-chat", "thinking": "off" },
  "scan": { "provider": "deepseek", "id": "deepseek-chat", "thinking": "off" }
}
```

Check `/yoo-index cost` (or `.pi/heyyoo/cost.json`) first to see where your spend actually goes, then tune.

Structured tools let the secondary model write brief Markdown analysis, but the final machine-readable result must be a fenced JSON block under `## Result`. The configured `thinking` level is passed through unchanged for each tool, including per-tool `taskModels` overrides; yoo does not silently cap or turn off thinking after parse failures.

### Options

| Option                         | Type                                    | Description                                                                                                                         |
| ------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `secondary`                    | object                                  | `{ provider, id, thinking? }` for the base secondary model                                                                          |
| `taskModels`                   | object                                  | Per-tool model overrides keyed by action (`plan`, `review`, `suggest`, `recommend`, `judge`, `scan`, `test`, `security`, `done`, `planUpdate`, `explain`) |
| `autoJudge`                    | boolean                                 | Run `yoo.judge` automatically when the last plan step passes review or is marked done via `/yoo-done`                               |
| `preReviewCommands`            | string[]                                | Commands to run before each review; output is included in the review prompt                                                         |
| `testCommand`                  | string                                  | Command to run for `/yoo test` analysis (e.g. `npm test`). Auto-detected from `package.json` if omitted                             |
| `costBudgetUsd`                | number                                  | Maximum estimated session spend before yoo stops with an error. Negative values are treated as unset; `0` means no spend is allowed |
| `reviewMaxDiffChars`           | number                                  | Legacy cap on diff characters; prefer `reviewMaxInputTokens`                                                                        |
| `reviewFullFileThresholdLines` | number                                  | Include full content for changed files under this line count (default: 300)                                                         |
| `reviewMaxInputTokens`         | number                                  | Hard cap on review input tokens                                                                                                     |
| `reviewMaxConventionsTokens`   | number                                  | Max tokens of project conventions included in review prompts (default: 1000)                                                        |
| `reviewMaxMemoryTokens`        | number                                  | Max tokens of past review issues included in review prompts (default: 800)                                                          |
| `reviewStrategy`               | `"auto" \| "diff-only" \| "full-files"` | How to include changed file contents (default: `"auto"`)                                                                            |
| `verifyByDefault`              | boolean                                 | If true, every yoo result asks the main agent to confirm the finding with evidence                                                  |
| `selfVerify`                   | boolean                                 | Run a second verification pass on `yoo.review` and `yoo.judge` results (costs extra tokens)                                         |
| `toolUseLoop`                  | boolean \| number                       | Let the secondary model use `read_file` and allowlisted `run_command` in a loop; number sets the max iterations                     |
| `parallelReview`               | boolean \| number                       | Review multiple changed files in parallel; number sets concurrency (default: 3 when enabled)                                        |
| `deepScan`                     | boolean \| number                       | Include code samples and build a symbol index during `yoo.scan`; number caps sample files                                           |
| `secondary.contextWindow`      | number                                  | Override the model's context window                                                                                                 |
| `secondary.maxOutputTokens`    | number                                  | Override the model's max output tokens                                                                                              |
| `secondary.backend`            | `"sdk" \| "pi" \| "http"`              | Backend for model calls. `"sdk"` uses Pi's `pi-ai` provider layer (default); `"pi"` spawns the Pi CLI; `"http"` uses direct provider HTTP |
| `secondary.cacheRetention`     | `"none" \| "short" \| "long"`          | SDK cache retention hint (SDK backend only, default: `"short"` to match the main Pi agent)                                         |
| `secondary.transport`          | `"sse" \| "websocket" \| "websocket-cached" \| "auto"` | SDK HTTP transport hint (SDK backend only)                                                                            |
| `secondary.maxRetries`         | number                                  | Maximum SDK request retries (SDK backend only, default: 3)                                                                          |
| `secondary.maxRetryDelayMs`    | number                                  | Maximum delay between SDK retries in ms (SDK backend only, default: 60000)                                                          |
| `secondary.timeoutMs`          | number                                  | SDK request timeout in ms (SDK backend only, default: 300000 = 5 min)                                                               |
| `secondaryFallback`            | `SecondaryModelConfig[]`                | Fallback secondary models to try if the primary fails; useful for provider outages or rate limits                                   |
| `secondary.apiKey`             | string                                  | Inline API key (prefer `auth.json` or env vars)                                                                                     |
| `secondary.style`              | `"openai-compatible" \| "anthropic"`    | API style when using `baseUrl` (default: `"openai-compatible"`)                                                                     |
| `secondary.authHeader`         | string                                  | Custom auth header name when using `baseUrl`                                                                                        |
| `secondary.authPrefix`         | string                                  | Custom auth prefix when using `baseUrl`                                                                                             |
| `modelInfo`                    | object                                  | Per-model token budget overrides, keyed by model id                                                                                 |
| `processTimeoutMs`             | number                                  | Timeout in ms for child pi process calls (default: 300000 = 5 min)                                                                  |
| `testTimeoutMs`                | number                                  | Timeout in ms per model in `/yoo test` (default: 120000 = 2 min)                                                                   |
| `docs`                         | object                                  | Documentation sources and DuckDuckGo web-search settings for `yoo.suggest`, `yoo.recommend`, and `yoo_explain`                       |

### Documentation sources and web search

You can give `yoo.suggest`, `yoo.recommend`, and `yoo_explain` access to configured documentation pages. This is useful when the secondary model needs up-to-date library docs. For ad-hoc web search, use the `/yoo-search` command.

```json
{
  "pi-heyyoo": {
    "docs": {
      "sources": {
        "react": "https://react.dev/reference/react",
        "pi": "https://pi.dev/docs/latest"
      },
      "maxCharsPerSource": 8000,
      "webSearch": {
        "enabled": true,
        "provider": "brave",
        "maxResults": 3,
        "maxCharsPerResult": 3000
      }
    }
  }
}
```

| Option                             | Type                    | Description                                                                 |
| ---------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `docs.sources`                     | object                  | Named URL map. Only URLs listed here can be fetched.                        |
| `docs.maxCharsPerSource`           | number                  | Characters of each source page to include in the prompt (default: 8000)     |
| `docs.webSearch.enabled`           | boolean                 | Whether `/yoo-search` is allowed (default: false)                           |
| `docs.webSearch.provider`          | `"duckduckgo" \| "brave"` | Search provider. Defaults to "brave" when a Brave API key is available, else "duckduckgo" |
| `docs.webSearch.apiKey`            | string                  | Inline Brave API key (prefer auth.json or `BRAVE_API_KEY` env var)          |
| `docs.webSearch.maxResults`        | number                  | Search results to include (default: 3)                                      |
| `docs.webSearch.maxCharsPerResult` | number                  | Characters of each search snippet to include (default: 3000)                |

Use it from the `yoo` tool:

```js
yoo({ suggest: "useEffect vs useLayoutEffect", docs: ["react"] });
yoo({ recommend: "what next", docs: ["pi"] });
```

Or from `yoo_explain`:

```js
yoo_explain({ target: "what is MCP", docs: ["pi"] });
```

For ad-hoc web search, use the terminal command:

```text
/yoo-search Next.js app router caching
```

**Brave Search.** If you have a Brave Search API key, pi-heyyoo will use Brave automatically. Configure it via TUI with `/yoo-search-config` (interactive provider picker) or inline:

```text
/yoo-search-config brave <your-api-key>
/yoo-search-config duckduckgo
```

API key resolution order: `docs.webSearch.apiKey` → `~/.pi/agent/auth.json` `brave` entry → `BRAVE_API_KEY` env var. If Brave is selected but no key is found, pi-heyyoo falls back to DuckDuckGo.

Fetched source pages and search results are cached in `.pi/heyyoo/docs/` for 24 hours. Cache files are written with mode `0o600`. Only URLs declared in `docs.sources` are fetched; web search never fetches arbitrary result pages. Fetches time out after 10 seconds and responses larger than 500 KB are rejected. No credentials are sent.

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
| `yoo({ suggest: "...", docs: ["react"] })`                            | When stuck or asked a question | Includes configured docs in the suggestion prompt                   |
> **Diff scope:** by default `review`, `judge`, and `done` diff against `HEAD` and include untracked files, so they see staged, unstaged, and new files without you running `git add` first. Pass `revision`/`since` to scope to a commit range, or `untracked: false` to limit to tracked changes.

| `yoo({ recommend: "what next" })`                                     | When unsure                    | Recommends next concrete step                                       |
| `yoo({ recommend: "...", docs: ["pi"] })`                             | When unsure                    | Includes configured docs in the recommendation prompt               |
| `yoo({ judge: "all done" })`                                          | Final review                   | Holistic review against original plan                               |
| `yoo({ scan: true })`                                                 | Once per project               | Learns project conventions and architecture                         |
| `yoo({ test: "added payment service" })`                              | After code changes             | Checks for failing tests, missing tests, and test-quality issues    |
| `yoo({ security: "auth changes" })`                                   | Security-sensitive changes     | Audits diff for secrets, injection, auth, and other vulnerabilities |
| `yoo({ done: true })`                                                 | After completing a step        | Mark the current plan step complete; use a number or `"all"` to mark multiple steps |
| `yoo({ planUpdate: "new task description" })`                         | When plan becomes stale        | Regenerate the active plan; already-completed progress is preserved |
| `yoo({ review: "...", verify: true })`                                | Any high-stakes result         | Asks the main agent to confirm or refute the finding with evidence  |

Plan steps can include `priority` (`high`, `medium`, `low`) and `dependsOn` (1-based list of earlier steps). Plain-string steps still work for backward compatibility.

**Plan tracker.** yoo tracks file edits and sends a workflow reminder after 3+ edits without a `yoo.review` or `yoo.done` call, so the plan tracker stays in sync. Review automatically advances the plan by the number of steps the model reports as completed (`completedSteps`).

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
| `yoo_explain({ target: "what is MCP", docs: ["pi"] })` | Explains a concept using configured docs |
| `yoo_explain({ target: "MCP", docs: ["pi"] })` | Explains a concept using configured docs |

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

### Core workflow

| Command                                       | What it does                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| `/yoo`                                        | Compact status card: version, model, plan, VCS, cost, conventions         |
| `/yoo plan refactor auth middleware`          | Create a plan from the terminal                                           |
| `/yoo review "wrote verifySession"`           | Review current changes                                                    |
| `/yoo suggest "redis vs in-memory sessions?"` | Get alternative approaches with pros/cons                                 |
| `/yoo recommend`                              | Get one concrete next step based on your current situation/plan           |
| `/yoo judge "auth refactor complete"`         | Final holistic review                                                     |
| `/yoo scan`                                   | Scan project conventions                                                  |
| `/yoo scan --deep`                            | Deep scan with code samples and symbol index build                        |
| `/yoo-next`                                   | Recommend the next step based on the active plan                          |
| `/yoo-done [description]`                     | Mark the current plan step complete and recommend the next step           |
| `/yoo-done 3`                                 | Mark steps 1–3 complete                                                   |
| `/yoo-done all`                               | Mark all steps complete                                                   |
| `/yoo-plan-update <new task description>`     | Regenerate the active plan; already-completed progress is preserved       |

### Utilities and diagnostics

| Command                                        | What it does                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/yoo test [description] [--command <cmd>]`    | Analyze test coverage and failures for current changes                                 |
| `/yoo security [description] [--full-project]` | Security audit of current diff or sampled project files                                |
| `/yoo-status`                                  | Detailed diagnostics: base + per-tool models, config, plan, VCS, conventions, cost     |
| `/yoo-index [topic] [--update]`                | Read stored yoo context (plan, memory, conventions, cost, logs, index, learned)        |
| `/yoo-explain <target> [--files ...]`          | Explain code, error, or file with the secondary model                                  |
| `/yoo-search <query>`                          | Search the web via DuckDuckGo (requires `docs.webSearch.enabled`)                      |
| `/yoo-learn <fact> [--category <cat>]`         | Record a persistent project fact                                                       |
| `/yoo-learn --verify [--query <keyword>]`      | Check stored facts against the current codebase                                        |
| `/yoo-learn --verify --deep [--query <keyword>]` | Check stored facts with the secondary model                                          |
| `/yoo-model`                                   | Interactively pick the base or per-tool model; shows current provider/model/thinking   |
| `/yoo-model <provider> [filter]`               | Pre-select provider and optionally filter the model list                               |
| `/yoo-config`                                  | Show current `pi-heyyoo` settings                                                      |
| `/yoo-config get <key>`                        | Read a dotted setting (e.g. `/yoo-config get secondary.thinking`)                      |
| `/yoo-config set <key> <value>`                | Write a dotted setting (e.g. `/yoo-config set taskModels.review.id claude-sonnet-4-5`) |
| `/yoo-config <provider.model>`                 | Set the base secondary model directly (e.g. `/yoo-config openai.gpt-4o`)               |
| `/yoo-test`                                    | Test connectivity; prints a per-model summary with latency, tokens, cost, and totals   |
| `/yoo-backend <sdk\|pi\|http>`                 | Switch secondary model backend (default: `sdk`)                                        |
| `/yoo-clear`                                   | Clear the current session's plan, state, cost, memory, and conventions                 |
| `/yoo-logs`                                    | Show recent error/event log entries for this project                                   |
| `/yoo-clear-logs`                              | Clear the yoo error/event log for this project                                         |

### Deprecated aliases

These still work but print a deprecation warning and will be removed in a future release:

| Command         | Use instead       |
| --------------- | ----------------- |
| `/yoo-info`     | `/yoo-status`     |
| `/yoo-scan`     | `/yoo scan`       |
| `/yoo-scan-deep`| `/yoo scan --deep` |

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

## Caching and optimization

pi-heyyoo uses several caches to avoid redundant work and cost:

| Cache | File | Purpose |
| ----- | ---- | ------- |
| Review result cache | `.pi/heyyoo/review-cache.json` | Skip duplicate `yoo.review` calls for the same diff (1-hour TTL) |
| OAuth API-key cache | `.pi/heyyoo/oauth-cache.json` | Avoid re-authenticating OAuth providers across Pi sessions (55-min TTL) |
| Project symbol index | `.pi/heyyoo/index.json` | Reuses unchanged files on incremental updates |
| Review memory | `.pi/heyyoo/memory.json` | Deduplicated, capped at 20 issues per file / 100 files, 7-day TTL |

Context compression is applied automatically in reviews: conventions and past issues are truncated to their configured token budgets (`reviewMaxConventionsTokens`, `reviewMaxMemoryTokens`).

**Incremental diff review:** When the working tree is clean, `yoo.review` diffs against the last reviewed commit instead of the full working tree, so committed changes are reviewed incrementally. The last reviewed commit is stored in session state and reset when a new plan is created.

**Smart context retrieval:** `yoo.review` follows relative imports in changed files and includes compact outlines of referenced files (up to 5 files, 1000 tokens) so the model sees related APIs without loading the entire codebase.

**Deep AST context retrieval:** When a `tsconfig.json` is present, `yoo.review` uses the TypeScript compiler API to resolve imported symbols to their actual declarations and includes only those precise signatures (up to 1000 tokens). Falls back to regex-based import following if no `tsconfig.json` is found.

## Logging

yoo writes error and event entries to `<pi-config-dir>/heyyoo/yoo.log` in the current project (by default `.pi/heyyoo/yoo.log`). Use these commands to inspect or clear it:

```text
/yoo-logs        # show last 50 entries
/yoo-clear-logs  # empty the log
```

Logged events include secondary model errors, parse failures (with a raw response snippet), command failures, and diagnostic context like provider/model/thinking level.

## Process flow

```mermaid
sequenceDiagram
    autonumber
    participant MA as Main Agent (Pi)
    participant Yoo as yoo extension
    participant SM as Secondary model

    MA->>Yoo: yoo.plan("refactor auth")
    Yoo->>SM: generate plan + acceptance criteria
    SM-->>Yoo: todo list
    Yoo-->>MA: Plan: 5 steps

    MA->>Yoo: yoo.scan()
    Yoo->>SM: learn conventions
    SM-->>Yoo: project context
    Yoo-->>MA: conventions cached

    loop Per step
        MA->>MA: implement step N
        MA->>Yoo: yoo.done()
        Yoo->>SM: verify diff satisfies step
        SM-->>Yoo: verified / not verified
        alt verification passes
            Yoo-->>MA: Step N done ✓
        else verification fails
            Yoo-->>MA: keep working
        end

        MA->>Yoo: yoo.review("...")
        Yoo->>SM: review git diff
        SM-->>Yoo: verdict + issues + fixPlan
        alt needs-work
            Yoo-->>MA: issues + fix plan
            MA->>MA: fix issues
        else pass
            Yoo-->>MA: pass + progress + next step
        end
    end

    MA->>Yoo: yoo.judge("...")
    Yoo->>SM: holistic final review
    SM-->>Yoo: verdict + completedStepIds
    alt pass
        Yoo->>Yoo: auto-sync tracker
        Yoo-->>MA: all done ✓
    else plan stale
        Yoo-->>MA: plan stale — run yoo.planUpdate
        MA->>Yoo: yoo.planUpdate("...")
        Yoo-->>MA: updated plan
    else needs-work
        Yoo-->>MA: fix remaining issues
    end
```

Typical tool sequence:

```
yoo.plan("refactor auth")
  → Plan: 5 steps, 4 acceptance criteria

yoo.scan()
  → learns project conventions and architecture

[implement step 1]

yoo.done()                                        # verified against diff
yoo.review("wrote verifySession middleware")
  → git diff → secondary model
  → verdict: "needs-work" — 2 issues found
  → Suggested fix plan generated
  → Progress: 1/5 steps done

  [fix issues...]

yoo.review("fixed error handling")
  → verdict: "pass" — consensus ✓
  → Progress: 2/5 steps done
  → Next: migrate login route

  [implement steps 2–5 in one edit]

yoo.done("all")                                   # verified against diff
yoo.review("migrated all routes")
  → verdict: "pass" — consensus ✓
  → Progress: 5/5 steps done
  → autoJudge: final review triggered

yoo.judge("auth refactor complete")
  → final review against plan + review history
  → verdict: "pass" — all work complete ✓
  → Tracker auto-synced to 5/5
```

If the implementation diverges from the original plan, yoo flags the plan as stale in review/judge output and you can regenerate it with `yoo({ planUpdate: "..." })` or `/yoo-plan-update`. The tracker resets cleanly when a new plan is created.

### Review escalation

If a single plan step fails review 3 times, yoo marks the review as escalated. The main agent should ask the user for guidance or consider a different approach instead of looping.

### Loop detection

yoo watches for repetitive patterns and sends a steering message if:

- `yoo` tools are called 3+ times in a row without real code edits
- The same `yoo` call is repeated with the same description

This prevents the main agent from spinning in review-fix-review cycles.

## How it works

- **Auto-detect backend** — known providers use direct HTTP; Pi-routed providers (e.g. `opencode-go`) default to the `sdk` backend using Pi's `pi-ai` provider layer; override with `secondary.backend` or `/yoo-backend`
- **Automatic diff collection** — `yoo.review` auto-runs `git diff HEAD` (or `svn diff`)
- **Adaptive context** — automatically includes full contents of small changed files, outlines for large ones, and respects the model's token budget
- **Diff scope control** — limit reviews with `files`, `exclude`, `revision`, `since`, or `untracked`
- **Session-scoped state** — plan, review memory, and cost are scoped to the current Pi session, so old plans and issues do not leak into unrelated work; conventions persist per project
- **Deep project scan** — `yoo.scan` reads `package.json`, `AGENTS.md`, detects frameworks, tests, ORM, UI, build tools, CI, package manager, entry points, scripts, and samples code style
- **Project symbol index** — `yoo scan-deep` parses TypeScript/JavaScript source files and stores exported functions, classes, interfaces, types, and more; surfaced by `yoo_index`
- **Project conventions** — scan results feed into plan, suggest, recommend, review, and judge prompts
- **Learned facts** — `yoo_learn` persists project-specific facts across sessions; surfaced by `yoo_index`
- **Review memory** — previous issues per file are included so the model knows what was already fixed. When a review description is provided, issues are ranked by semantic similarity to the current change. Memory is reset for each new Pi session
- **Pre-review commands** — configured lint/test/typecheck output is included in the review prompt
- **Cost tracking + budget** — estimated spend per call, session total, optional hard budget, and wall-clock elapsed time in result headers
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

**SDK backend (default)** — all providers default to the `sdk` backend, which uses Pi's `pi-ai` provider layer and catalog metadata for token budgets, caching, retries, and thinking-level mapping. This is the same provider layer the main Pi agent uses, so new models added to Pi are automatically supported. Set `secondary.backend` to `"pi"` or `"http"` to override:

| Provider       | Reason                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------ |
| opencode-go    | Mixed API styles + complex thinking formats per model                                      |
| opencode       | Same — mixed openai-completions, anthropic-messages, google-generative-ai, openai-responses |
| deepseek, etc. | Use the SDK for built-in retry/cache behavior and future-proof model support               |

SDK backend defaults mirror the main Pi agent: `cacheRetention: "short"`, `maxRetries: 3`, and `timeoutMs: 300000`. For `opencode`/`opencode-go` calls, pi-heyyoo also sends the `x-opencode-session` and `x-opencode-client: pi` attribution headers when a session id is available.

**Credential resolution:** The SDK backend first uses pi-heyyoo's own key lookup (`secondary.apiKey` → `~/.pi/agent/auth.json` → environment variables → `!command` execution). OAuth credentials stored by Pi's `/login` command (e.g. OpenAI Codex, GitHub Copilot, Anthropic Claude Pro/Max) are detected by their `type: "oauth"` entry and resolved/refreshed via the `pi-ai` SDK's `getOAuthApiKey`. If no explicit credential is found, it falls back to the SDK's own credential resolution. This means yoo often works without any extra key configuration if the main Pi agent is already set up.

**Extension-registered providers.** Providers added by Pi extensions (e.g. [`pi-provider-kimi-code`](https://github.com/Leechael/pi-provider-kimi-code) for `kimi-coding`) may not be resolvable by the SDK backend even though they appear in Pi's catalog. If the SDK fails with "No API key for provider", pi-heyyoo now automatically falls back to the `pi` backend so the extension can supply its credentials. You can also force the `pi` backend for these providers by setting `backend: "pi"`.

**Transient-failure fallback:** If the SDK backend fails with a retryable provider error (5xx, rate limit, network timeout, or missing API key), pi-heyyoo automatically falls back to the `pi` backend once before giving up.

**Streaming progress:** For SDK backend calls, generated text is streamed to the TUI so long `suggest`, `plan`, `review`, and other operations show live progress instead of waiting silently.

**Auto-detect:** When no `backend` is explicitly set, pi-heyyoo uses the `sdk` backend for all providers. If the requested model is not in Pi's built-in SDK catalog (e.g. extension-registered providers like `pi-cursor-provider`), it automatically falls back to the `pi` backend. Direct HTTP is used only when `secondary.baseUrl` is set or when `secondary.backend` is explicitly `"http"`. Set `secondary.backend` to `"sdk"`, `"pi"`, or `"http"` to override.

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

Credentials are resolved in order: `secondary.apiKey` → `~/.pi/agent/auth.json` (API-key or OAuth entries) → environment variables → `!command` execution. For Anthropic, `ANTHROPIC_OAUTH_TOKEN` is checked before `ANTHROPIC_API_KEY` (matching Pi's precedence).

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
