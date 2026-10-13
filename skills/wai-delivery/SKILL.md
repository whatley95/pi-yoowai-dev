---
name: wai-delivery
description: Carry a software task from its requested outcome through Wai planning, review, and delivery while preserving user intent. Use for non-trivial planned work, resuming interrupted work, stale-plan diagnosis, incomplete-review recovery, or an authorized commit.
license: MIT
---

# Plan, review, and deliver

Inspect relevant source before planning. Describe task-sized outcomes, dependencies,
completion checks, and preservation criteria. Capture the requested outcome and scope
in the Wai plan summary, with observable success conditions in its acceptance criteria.
Include user constraints and behavior that must survive the change. Keep unconfirmed
implementation details flexible and distinguish assumptions from established decisions.

Treat follow-up corrections and constraints as refinements of the active objective
unless the user changes or cancels it. A status question does not discard remaining
work. When new evidence changes the approach, preserve the required outcome; use
`planUpdate` for confirmed changes to the existing plan and retain unaffected progress.
Ask for clarification when a missing decision materially changes scope or correctness;
continue useful work that does not depend on that answer.

Before a batch, inspect the current step. A partial diff, unfinished next step, or
unchanged preservation invariant does not make a plan stale. Require positive evidence
of a superseded assumption or incorrect tracker position before changing the plan.
Use the existing tracker, not a second set of plan files. Compare a warning with code
and the user's decisions before accepting it.

After interruption or context compaction, read `wai_index({topic:"plan"})`, recover
the latest user decisions from the available conversation, and inspect the current
workspace before continuing. Reconcile recorded progress with actual work and evidence;
recover missing context before guessing. When preparing a handoff or session summary,
retain the objective, constraints, completed outcomes and evidence, remaining work,
blockers, and next action in the existing session context.

Choose the next action that advances an unmet outcome or resolves a concrete blocker.
Continue authorized work while a useful next action is available; finishing a batch or
receiving a passing review does not by itself finish the task. Respect explicit pauses,
cancellations, and resource limits. If blocked, complete independent work where useful,
then report the missing input or capability, what was attempted, and what would unblock
progress. Repeated unchanged attempts are not progress; revise the approach when the
evidence warrants it and leave blocked outcomes visibly incomplete.

Before ending a turn, reconcile the requested outcomes with the current workspace:
which are complete with evidence, which remain actionable, and which are blocked?
If an authorized next action is available, take it. A completed subtask, proposed fix,
started background check, or status reply is a checkpoint, not a reason to hand back
unfinished work. Follow required checks through to their results when the tools and
session allow it. If execution must stop, preserve the exact next action and remaining
outcomes in the existing plan/session context, and state the reason for stopping.

When a confirmed correction or reusable discovery should change future work, use
the `wai-learning` skill when available to maintain a concise lesson through `wai_learn`.
Keep the active goal and unfinished steps in the plan; capturing a lesson is not a
substitute for completing the current task.

Use scoped review for focused feedback. Before completion, run a whole-tree review
with intended new files included and without files/exclude/revision/since restrictions.
Coverage gaps, truncation, failed checks, or inconclusive results cannot certify the
tree. Inspect recovery, cwd, VCS range, missing evidence, and request/output limits;
correct the cause before retrying unchanged input. Do not lower thinking blindly or
force completion to conceal a blocker.

A review can advance the plan. Inspect returned workflow progress or
`wai_index({topic:"plan"})` before `done`; do not accidentally complete the next step.
A passing code review can leave a step incomplete. Judge only after the actual task
criteria and required checks are satisfied. Before claiming completion, compare the
delivered result with the requested outcome and latest user constraints, and connect
each success condition to available evidence. Report any unverified condition explicitly;
never narrow the goal merely to match the work already finished.

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
