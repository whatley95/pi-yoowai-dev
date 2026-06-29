# pi-heyyoo

Pair-programmer extension for [Pi](https://github.com/earendil-works/pi). A secondary model reviews, plans, suggests, recommends, and judges your work — catching bugs, missing error handling, and blind spots.

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

Add to `~/.pi/agent/settings.json`:

```json
{
  "pi-heyyoo": {
    "secondary": {
      "provider": "opencode-go",
      "id": "deepseek-v4-pro",
      "thinking": "xhigh"
    },
    "autoJudge": true,
    "preReviewCommands": [
      "npm run typecheck",
      "npm run lint"
    ]
  }
}
```

**Recommended:** Use a DIFFERENT model family than your main agent. If main is DeepSeek, set secondary to Claude or GPT. This catches blind spots your main model shares.

If no secondary model is configured, yoo falls back to the main agent's model.

### Options

| Option | Type | Description |
|--------|------|-------------|
| `secondary` | object | `{ provider, id, thinking? }` for the secondary model |
| `autoJudge` | boolean | Run `yoo.judge` automatically when the last plan step passes review |
| `preReviewCommands` | string[] | Commands to run before each review; output is included in the review prompt |

## Tools

The `yoo` tool is called by the main agent during development:

| Action | When | What it does |
|--------|------|-------------|
| `yoo({ plan: "refactor auth" })` | Before starting | Creates structured todo + acceptance criteria |
| `yoo({ review: "wrote middleware" })` | After each step | Reviews git diff, returns verdict + issues |
| `yoo({ review: "wrote middleware", files: ["src/auth.ts"] })` | After each step | Reviews only the listed files |
| `yoo({ review: "wrote middleware", exclude: ["package-lock.json"] })` | After each step | Reviews diff excluding listed files |
| `yoo({ suggest: "how to..." })` | When stuck | Returns alternative approaches with pros/cons |
| `yoo({ recommend: "what next" })` | When unsure | Recommends next concrete step |
| `yoo({ judge: "all done" })` | Final review | Holistic review against original plan |
| `yoo({ scan: true })` | Once per project | Learns project conventions and architecture |

## Commands

| Command | What it does |
|---------|-------------|
| `/yoo` | Compact status card: version, model, plan, VCS, cost, conventions |
| `/yoo-status` | Detailed diagnostics: config, plan, VCS, conventions, session cost |
| `/yoo-info` | Alias for `/yoo-status` |
| `/yoo-model` | Interactively pick the secondary model from configured providers |
| `/yoo-config <provider.model>` | Guide for configuring the secondary model |
| `/yoo-clear` | Clear the active plan, session state, cost, memory, and conventions |

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

- `yoo.review` or `yoo.judge` is called 3+ times in a row without real code edits
- The same `yoo` call is repeated with the same description

This prevents the main agent from spinning in review-fix-review cycles.

## How it works

- **No child Pi process** — direct HTTP calls to the secondary model's API
- **Automatic diff collection** — `yoo.review` auto-runs `git diff HEAD`
- **Diff scope control** — limit reviews with `files` or `exclude` arrays
- **Plan persistence** — session state tracks the plan, review prompts include acceptance criteria
- **Project conventions** — `yoo.scan` and per-file pattern detection feed convention context into reviews
- **Review memory** — previous issues per file are included so the model knows what was already fixed
- **Pre-review commands** — configured lint/test/typecheck output is included in the review prompt
- **Cost tracking** — estimated spend per call and session total shown in `/yoo`
- **One round-trip** — secondary model has no tools, pure judgment
- **Supports OpenAI-compatible and Anthropic APIs** — 14 providers pre-configured

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

## Supported providers

| Provider | API style |
|----------|-----------|
| opencode-go, opencode | OpenAI-compatible |
| anthropic | Anthropic native |
| openai, deepseek, openrouter, groq, mistral, xai, together, fireworks, cerebras | OpenAI-compatible |
| google | Google Gemini |

API keys are resolved from `~/.pi/agent/auth.json` → environment variables → `!command` execution.
