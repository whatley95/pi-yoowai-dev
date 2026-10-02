---
name: wai-debug
description: Diagnose a reproducible software failure, regression, flaky test, or incorrect runtime behavior. Use to establish the cause and verify a targeted fix; ordinary feature implementation does not require a debugging ceremony.
license: MIT
---

# Evidence-based debugging

Establish the trigger, expected/actual behavior, environment/version, and a useful
reproduction. Inspect the error and relevant implementation before proposing changes.
Follow the failure through callers, boundary data, state, and asynchronous lifecycle.

Keep a small set of plausible causes. Choose an observation that distinguishes them:
a focused test, existing log, debugger trace, or bounded temporary instrumentation.
Do not repeatedly rerun an unchanged failing workflow without new evidence. Check
local scope/input/request limits before blaming authentication or model depth.

Fix the cause in the narrowest appropriate place. Preserve unrelated user changes
and established decisions; avoid hiding errors, weakening checks, or replacing an
entire subsystem to suppress one symptom.

For a behavior defect, add or adapt a meaningful regression test when feasible. Show
that the original trigger fails before the fix or is captured by a trustworthy
reproduction, then verify it after the fix. Broaden checks when affected callers or
an unresolved concern justify it. Remove task-created instrumentation after use.

Report the cause, change, executed checks, remaining uncertainty, and any persistent
blocker. A plausible explanation or passing model review is not execution evidence.
