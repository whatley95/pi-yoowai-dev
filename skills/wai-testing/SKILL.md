---
name: wai-testing
description: Select, implement, or assess tests for a software behavior change, regression, or integration boundary. Use for meaningful test coverage and truthful verification, without adding tests for every reversible cosmetic edit.
license: MIT
---

# Meaningful verification

Identify changed behavior and concrete acceptance/preservation criteria. Inspect
existing tests, fixtures, manifests, and CI to discover the actual commands. Do not
invent a build step or assume a unit suite verifies an integration/device criterion.

Choose the lowest test level that observes the contract: focused unit behavior,
boundary/integration behavior, or end-to-end behavior where wiring is the risk.
Test the observable outcome rather than reproducing private implementation details.
For a bug fix, cover its original trigger and expected behavior.

Cover relevant negative paths, boundary inputs, cancellation, disposal, and provider
failure without building an exhaustive matrix unrelated to this change. Isolate
fixtures and external dependencies; avoid wall-clock waits where a controlled clock
can observe the same behavior.

Run checks appropriate to the change and the repository's requirements. Record exit
codes and useful failure evidence. Once they pass, repeat or broaden only for new
changes, failures, or unresolved risks. Distinguish skipped, unavailable, failing,
and successful checks. Don't infer all acceptance criteria from one green command.

For review, read [evaluation criteria](references/checks.md). Wai test analysis is
model assessment, not proof that the commands were executed.

For browser navigation, user flows, or integration failures, read
[browser and boundary tests](references/browser-integration.md). Use the project's
existing runner; this guidance does not require installing a new browser framework.
