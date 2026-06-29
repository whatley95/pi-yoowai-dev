# pi-heyyo

Pair-programmer extension for [Pi](https://github.com/earendil-works/pi). A secondary model reviews, plans, suggests, recommends, and judges your work — catching bugs, missing error handling, and blind spots.

## Install

```bash
pi install git:github.com/whatley95/pi-heyyoo-dev
```

Or from local path:

```bash
pi install ./pi-heyyo
```

Try without installing:

```bash
pi -e git:github.com/whatley95/pi-heyyoo-dev
```

## Configuration

Add to `~/.pi/agent/settings.json`:

```json
{
  "pi-heyyo": {
    "secondary": {
      "provider": "opencode-go",
      "id": "deepseek-v4-pro",
      "thinking": "xhigh"
    }
  }
}
```

**Recommended:** Use a DIFFERENT model family than your main agent. If main is DeepSeek, set secondary to Claude or GPT. This catches blind spots your main model shares.

If no secondary model is configured, yoo falls back to the main agent's model.

## Tools

The `yoo` tool is called by the main agent during development:

| Action | When | What it does |
|--------|------|-------------|
| `yoo({ plan: "refactor auth" })` | Before starting | Creates structured todo + acceptance criteria |
| `yoo({ review: "wrote middleware" })` | After each step | Reviews git diff, returns verdict + issues |
| `yoo({ suggest: "how to..." })` | When stuck | Returns alternative approaches with pros/cons |
| `yoo({ recommend: "what next" })` | When unsure | Recommends next concrete step |
| `yoo({ judge: "all done" })` | Final review | Holistic review against original plan |

## Commands

| Command | What it does |
|---------|-------------|
| `/yoo` | Show current configuration and session plan status |
| `/yoo-config <provider.model>` | Guide for configuring the secondary model |

## Flow

```
yoo.plan("refactor auth")
  → Plan: 3 steps, 4 acceptance criteria

yoo.review("wrote verifySession middleware")
  → git diff → secondary model
  → verdict: "needs-work" — 2 issues found

  [fix issues...]

yoo.review("fixed error handling")
  → verdict: "pass" — consensus ✓

  [next step...]

yoo.review("migrated all routes")
  → verdict: "pass" — consensus ✓

yoo.judge("auth refactor complete")
  → final review against plan
  → verdict: "pass" — all work complete ✓
```

## How it works

- **No child Pi process** — direct HTTP calls to the secondary model's API
- **Automatic diff collection** — `yoo.review` auto-runs `git diff HEAD`
- **Plan persistence** — session state tracks the plan, review prompts include acceptance criteria
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
