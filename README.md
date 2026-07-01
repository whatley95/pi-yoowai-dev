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
    "reviewStrategy": "auto"
  }
}
```

**Recommended:** Use a DIFFERENT model family than your main agent. If main is DeepSeek, set secondary to Claude or GPT. This catches blind spots your main model shares.

If no secondary model is configured, yoo returns an error. Configure `pi-heyyoo.secondary` in settings.json or use `/yoo-model` to pick one interactively.

### Options

| Option                         | Type                                    | Description                                                                                                                         |
| ------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `secondary`                    | object                                  | `{ provider, id, thinking? }` for the secondary model                                                                               |
| `autoJudge`                    | boolean                                 | Run `yoo.judge` automatically when the last plan step passes review                                                                 |
| `preReviewCommands`            | string[]                                | Commands to run before each review; output is included in the review prompt                                                         |
| `costBudgetUsd`                | number                                  | Maximum estimated session spend before yoo stops with an error. Negative values are treated as unset; `0` means no spend is allowed |
| `reviewMaxDiffChars`           | number                                  | Legacy cap on diff characters; prefer `reviewMaxInputTokens`                                                                        |
| `reviewFullFileThresholdLines` | number                                  | Include full content for changed files under this line count (default: 300)                                                         |
| `reviewMaxInputTokens`         | number                                  | Hard cap on review input tokens                                                                                                     |
| `reviewStrategy`               | `"auto" \| "diff-only" \| "full-files"` | How to include changed file contents (default: `"auto"`)                                                                            |
| `verifyByDefault`              | boolean                                 | If true, every yoo result asks the main agent to confirm the finding with evidence                                                  |
| `secondary.contextWindow`      | number                                  | Override the model's context window                                                                                                 |
| `secondary.maxOutputTokens`    | number                                  | Override the model's max output tokens                                                                                              |

## Tools

The `yoo` tool is called by the main agent during development:

| Action                                                                | When                           | What it does                                                       |
| --------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `yoo({ plan: "refactor auth" })`                                      | Before starting                | Creates structured todo + acceptance criteria                      |
| `yoo({ review: "wrote middleware" })`                                 | After each step                | Reviews git diff, returns verdict + issues                         |
| `yoo({ review: "wrote middleware", files: ["src/auth.ts"] })`         | After each step                | Reviews only the listed files                                      |
| `yoo({ review: "wrote middleware", exclude: ["package-lock.json"] })` | After each step                | Reviews diff excluding listed files                                |
| `yoo({ review: "wrote middleware", revision: "HEAD~1" })`             | After each step                | Reviews changes against a specific revision                        |
| `yoo({ review: "wrote middleware", untracked: true })`                | After each step                | Includes untracked (new) files in the review                       |
| `yoo({ suggest: "how to..." })`                                       | When stuck or asked a question | Returns alternative approaches with pros/cons                      |
| `yoo({ recommend: "what next" })`                                     | When unsure                    | Recommends next concrete step                                      |
| `yoo({ judge: "all done" })`                                          | Final review                   | Holistic review against original plan                              |
| `yoo({ scan: true })`                                                 | Once per project               | Learns project conventions and architecture                        |
| `yoo({ review: "...", verify: true })`                                | Any high-stakes result         | Asks the main agent to confirm or refute the finding with evidence |

## Commands

| Command                                       | What it does                                                        |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `/yoo`                                        | Compact status card: version, model, plan, VCS, cost, conventions   |
| `/yoo plan refactor auth middleware`          | Create a plan from the terminal                                     |
| `/yoo review "wrote verifySession"`           | Review current changes                                              |
| `/yoo suggest "redis vs in-memory sessions?"` | Get alternative approaches                                          |
| `/yoo recommend`                              | Get a recommended next step                                         |
| `/yoo judge "auth refactor complete"`         | Final holistic review                                               |
| `/yoo scan`                                   | Scan project conventions                                            |
| `/yoo-status`                                 | Detailed diagnostics: config, plan, VCS, conventions, session cost  |
| `/yoo-info`                                   | Alias for `/yoo-status`                                             |
| `/yoo-model`                                  | Interactively pick the secondary model from configured providers    |
| `/yoo-config <provider.model>`                | Set the secondary model directly (e.g. `/yoo-config openai.gpt-4o`) |
| `/yoo-clear`                                  | Clear the active plan, session state, cost, memory, and conventions |
| `/yoo-next`                                   | Recommend the next step based on the active plan                    |
| `/yoo-done`                                   | Mark the current plan step complete and recommend the next step     |
| `/yoo-logs`                                   | Show recent error/event log entries for this project                |
| `/yoo-clear-logs`                             | Clear the yoo error/event log for this project                      |

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

- **No child Pi process** — direct HTTP calls to the secondary model's API
- **Automatic diff collection** — `yoo.review` auto-runs `git diff HEAD` (or `svn diff`)
- **Adaptive context** — automatically includes full contents of small changed files, outlines for large ones, and respects the model's token budget
- **Diff scope control** — limit reviews with `files`, `exclude`, `revision`, `since`, or `untracked`
- **Plan persistence** — session state tracks the plan, review prompts include acceptance criteria
- **Deep project scan** — `yoo.scan` reads `package.json`, `AGENTS.md`, detects frameworks, tests, ORM, UI, build tools, CI, package manager, entry points, scripts, and samples code style
- **Project conventions** — scan results feed into plan, suggest, recommend, review, and judge prompts
- **Review memory** — previous issues per file are included so the model knows what was already fixed
- **Pre-review commands** — configured lint/test/typecheck output is included in the review prompt
- **Cost tracking + budget** — estimated spend per call, session total, and optional hard budget
- **One round-trip** — secondary model has no tools, pure judgment
- **Supports OpenAI-compatible and Anthropic APIs** — 13 providers pre-configured

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

- `yoo({ suggest: "should I use callbacks or async/await here?" })` — get alternative approaches with pros/cons before answering the user.
- `yoo({ recommend: "what should I investigate next?" })` — get a concrete next step when progress stalls.

When the user asks a technical or architectural question, call `yoo.suggest` or `yoo.recommend` before answering from your own knowledge.

## Supported providers

| Provider                                                                        | API style         |
| ------------------------------------------------------------------------------- | ----------------- |
| opencode-go, opencode                                                           | OpenAI-compatible |
| anthropic                                                                       | Anthropic native  |
| openai, deepseek, openrouter, groq, mistral, xai, together, fireworks, cerebras | OpenAI-compatible |
| google                                                                          | Google Gemini     |

API keys are resolved from `~/.pi/agent/auth.json` → environment variables → `!command` execution.

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
