---
name: wai-delivery
description: Plan and finish a software task using Wai reviews, acceptance evidence, and Git or SVN commit preparation. Use for non-trivial planned work, stale-plan diagnosis, incomplete-review recovery, or an authorized commit.
license: MIT
---

# Plan, review, and deliver

Inspect relevant source before planning. Describe task-sized outcomes, dependencies,
completion checks, and preservation criteria. Keep unconfirmed implementation details
flexible; retain explicit user requirements and established decisions.

Before a batch, inspect the current step. A partial diff, unfinished next step, or
unchanged preservation invariant does not make a plan stale. Require positive evidence
of a superseded assumption or incorrect tracker position before changing the plan.
Use the existing tracker, not a second set of plan files. Compare a warning with code
and the user's decisions before accepting it.

Use scoped review for focused feedback. Before completion, run a whole-tree review
with intended new files included and without files/exclude/revision/since restrictions.
Coverage gaps, truncation, failed checks, or inconclusive results cannot certify the
tree. Inspect recovery, cwd, VCS range, missing evidence, and request/output limits;
correct the cause before retrying unchanged input. Do not lower thinking blindly or
force completion to conceal a blocker.

A review can advance the plan. Inspect returned workflow progress or
`wai_index({topic:"plan"})` before `done`; do not accidentally complete the next step.
A passing code review can leave a step incomplete. Judge only after the actual task
criteria and required checks are satisfied.

For Git, inspect status, stage intended paths/hunks, and inspect the exact staged diff.
For SVN, inspect status and add intended new files with explicit paths; reviewed `?`
files are still omitted by commit until scheduled for addition. Avoid bulk-adding tool
state, build output, or unrelated files. Re-review when staging/addition changes the
certified workspace.

Commit/push only within existing user authorization. Preserve unrelated changes and
report what changed, executed check results, skipped/unverified criteria, review scope
and coverage, remaining findings, and commit/push status. Model approval is not proof
of tests, visual behavior, or every acceptance criterion.

When the task includes CI, packaging, configuration, or release preparation, read
[release evidence](references/release.md). Reading this skill does not authorize
deployment, publication, or changes to external environments.
